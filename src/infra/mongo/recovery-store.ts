import type { ObjectId } from "mongodb";
import type { RecoveryStore } from "../../core/ports.ts";
import { col } from "../../db/mongo.ts";

export class MongoRecoveryStore implements RecoveryStore {
  findStuckSending(olderThan: Date, limit: number) {
    return col
      .emails()
      .find({ status: "sending", sendingAt: { $lt: olderThan } }, { projection: { _id: 1, smtpId: 1, priority: 1, sendingAt: 1 } })
      .limit(limit)
      .toArray();
  }

  async requeueStuck(ids: ObjectId[], olderThan: Date): Promise<void> {
    await col
      .emails()
      .updateMany(
        { _id: { $in: ids }, status: "sending", sendingAt: { $lt: olderThan } },
        { $set: { status: "queued", lastError: "re-queued by reaper (worker lost)", lastEnqueuedAt: new Date() } },
      );
  }

  findReleasedBefore(cutoff: Date, limit: number) {
    return col
      .emails()
      .find({ status: "queued", lastEnqueuedAt: { $lt: cutoff } }, { projection: { _id: 1, smtpId: 1, priority: 1, lastEnqueuedAt: 1 } })
      .limit(limit)
      .toArray();
  }

  async touchEnqueued(ids: ObjectId[]): Promise<void> {
    await col.emails().updateMany({ _id: { $in: ids }, status: "queued" }, { $set: { lastEnqueuedAt: new Date() } });
  }
}
