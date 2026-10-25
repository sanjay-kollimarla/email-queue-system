import { ObjectId } from "mongodb";
import type { EmailStore } from "../../core/ports.ts";
import { col, type EmailDoc } from "../../db/mongo.ts";
import type { StatusWriter } from "./status-writer.ts";

export class MongoEmailStore implements EmailStore {
  constructor(private readonly writer: StatusWriter) {}

  // w:1 on the hot path: waiting for a majority journal flush per email capped throughput near 3k/s.
  // Losing a claim in a MongoDB crash window only means a re-send (the reaper path); ACCEPTED emails
  // are written w:majority by the API.
  claimForSending(id: ObjectId): Promise<EmailDoc | null> {
    return col
      .emails()
      .findOneAndUpdate(
        { _id: id, status: "queued" },
        { $set: { status: "sending", sendingAt: new Date() }, $inc: { attempts: 1 } },
        { returnDocument: "after", writeConcern: { w: 1 } },
      );
  }

  recordSent(id: ObjectId, response: string): void {
    this.writer.markSent(id, response);
  }

  async revertToQueued(id: ObjectId, reason: string): Promise<void> {
    await col.emails().updateOne({ _id: id, status: "sending" }, { $set: { status: "queued", lastError: reason } });
  }

  async markFailed(id: ObjectId, reason: string): Promise<void> {
    await col.emails().updateOne({ _id: id, status: { $in: ["queued", "sending"] } }, { $set: { status: "failed", lastError: reason } });
  }

  async suppressRecipient(userId: ObjectId, email: string, reason: string): Promise<void> {
    await col
      .suppressions()
      .updateOne(
        { userId, email: email.toLowerCase() },
        { $setOnInsert: { _id: new ObjectId(), reason: reason.slice(0, 200), createdAt: new Date() } },
        { upsert: true },
      );
  }
}
