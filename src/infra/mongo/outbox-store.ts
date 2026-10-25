import type { ObjectId } from "mongodb";
import type { OutboxStore } from "../../core/ports.ts";
import { col, type OutboxDoc } from "../../db/mongo.ts";
import type { Lane } from "../../queue/queues.ts";

const LEASE_MS = 30_000;

export class MongoOutboxStore implements OutboxStore {
  smtpIdsWithBacklog(): Promise<ObjectId[]> {
    return col.outbox().distinct("smtpId", { state: { $in: ["pending", "releasing"] } });
  }

  /** Lease one document; an expired lease lets another relay take over from a crashed one. */
  claim(smtpId: ObjectId, lane: Lane): Promise<OutboxDoc | null> {
    const now = new Date();
    return col
      .outbox()
      .findOneAndUpdate(
        { smtpId, priority: lane, $or: [{ state: "pending" }, { state: "releasing", leaseUntil: { $lt: now } }] },
        { $set: { state: "releasing", leaseUntil: new Date(now.getTime() + LEASE_MS) } },
        { sort: { createdAt: 1 }, returnDocument: "after" },
      );
  }

  async release(doc: OutboxDoc): Promise<void> {
    await col.outbox().updateOne({ _id: doc._id }, { $set: { state: "pending" }, $unset: { leaseUntil: "" } });
  }

  async advance(doc: OutboxDoc, cursor: number): Promise<void> {
    await col
      .outbox()
      .updateOne(
        { _id: doc._id },
        cursor >= doc.emailIds.length
          ? { $set: { state: "done", cursor, doneAt: new Date() }, $unset: { leaseUntil: "" } }
          : { $set: { state: "pending", cursor }, $unset: { leaseUntil: "" } },
      );
  }

  async failBacklog(doc: OutboxDoc, reason: string): Promise<void> {
    await col
      .emails()
      .updateMany({ _id: { $in: doc.emailIds.slice(doc.cursor) }, status: "queued" }, { $set: { status: "failed", lastError: reason } });
    await col.outbox().updateOne({ _id: doc._id }, { $set: { state: "done", doneAt: new Date() }, $unset: { leaseUntil: "" } });
  }

  /** Stamp released emails BEFORE advancing the cursor: lets the reconciler tell "released" from "backlog". */
  async markEnqueued(emailIds: ObjectId[]): Promise<void> {
    await col
      .emails()
      .updateMany({ _id: { $in: emailIds }, status: "queued" }, { $set: { lastEnqueuedAt: new Date() } }, { writeConcern: { w: 1 } });
  }
}
