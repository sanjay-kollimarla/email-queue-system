import type { ObjectId } from "mongodb";
import type { DeliveryActivityRepository, ThroughputPoint } from "../../core/api/ports.ts";
import { col, type EmailStatus } from "../../db/mongo.ts";

export class MongoDeliveryActivityRepository implements DeliveryActivityRepository {
  async sentPerBucket(userId: ObjectId, since: Date, bucketSec: number): Promise<ThroughputPoint[]> {
    const rows = await col
      .emails()
      .aggregate<{ _id: Date; sent: number }>([
        { $match: { userId, sentAt: { $gte: since } } },
        { $group: { _id: { $dateTrunc: { date: "$sentAt", unit: "second", binSize: bucketSec } }, sent: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    return rows.map((r) => ({ at: r._id, sent: r.sent }));
  }

  async recentProblems(userId: ObjectId, limit: number) {
    const rows = await col
      .emails()
      .find(
        { userId, status: { $in: ["failed", "bounced", "complained"] satisfies EmailStatus[] } },
        { projection: { to: 1, status: 1, lastError: 1, sentAt: 1, createdAt: 1 } },
      )
      .sort({ _id: -1 })
      .limit(limit)
      .toArray();
    return rows.map((r) => ({ id: r._id, to: r.to, status: r.status, reason: r.lastError, at: r.sentAt ?? r.createdAt }));
  }
}
