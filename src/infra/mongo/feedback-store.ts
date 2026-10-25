import { ObjectId } from "mongodb";
import type { FeedbackEvent } from "../../core/feedback/parsers.ts";
import type { FeedbackStore } from "../../core/feedback/feedback-service.ts";
import { col } from "../../db/mongo.ts";

export class MongoFeedbackStore implements FeedbackStore {
  async applyToEmail(userId: ObjectId, smtpId: ObjectId, event: FeedbackEvent): Promise<boolean> {
    const status = event.kind === "complaint" ? "complained" : "bounced";
    const update = { $set: { status, lastError: event.reason.slice(0, 300) } } as const;

    if (event.messageId) {
      const byId = await col.emails().updateOne({ userId, messageId: event.messageId, status: { $in: ["sent", "bounced"] } }, update);
      if (byId.matchedCount > 0) return true;
    }
    // providers rewrite Message-IDs (SES does), so fall back to the latest send to that recipient
    const latest = await col
      .emails()
      .find({ userId, smtpId, toLower: event.email.toLowerCase(), status: "sent" }, { projection: { _id: 1 } })
      .sort({ _id: -1 })
      .limit(1)
      .next();
    if (!latest) return false;
    await col.emails().updateOne({ _id: latest._id, status: "sent" }, update);
    return true;
  }

  async suppress(userId: ObjectId, email: string, reason: string): Promise<void> {
    await col
      .suppressions()
      .updateOne(
        { userId, email: email.toLowerCase() },
        { $setOnInsert: { _id: new ObjectId(), reason, createdAt: new Date() } },
        { upsert: true },
      );
  }
}
