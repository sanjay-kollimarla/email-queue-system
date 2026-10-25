/**
 * Disaster recovery: rebuild queue jobs from MongoDB (the source of truth) after Redis lost data.
 *
 *   bun run requeue                  # every `queued` email older than 5 minutes
 *   bun run requeue -- --older-than 0
 *
 * It creates fresh outbox documents; the relay re-reserves slots and re-enqueues with jobId = emailId
 * (jobs that still exist in Redis are left alone, so running this twice is harmless).
 */
import { ObjectId } from "mongodb";
import { col, connectMongo, mongo } from "../db/mongo.ts";
import { redis } from "../lib/redis.ts";
import { closeQueues } from "../queue/queues.ts";

const arg = process.argv.indexOf("--older-than");
const olderThanMin = arg > -1 ? Number(process.argv[arg + 1]) : 5;

await connectMongo();
const cutoff = new Date(Date.now() - olderThanMin * 60_000);
const cursor = col
  .emails()
  .find({ status: "queued", createdAt: { $lt: cutoff } }, { projection: { _id: 1, userId: 1, smtpId: 1, priority: 1 } })
  .sort({ _id: 1 });

const groups = new Map<string, { userId: ObjectId; smtpId: ObjectId; priority: "transactional" | "bulk"; ids: ObjectId[] }>();
let total = 0;
const flush = async (key: string) => {
  const g = groups.get(key)!;
  await col.outbox().insertOne({
    _id: new ObjectId(),
    userId: g.userId,
    smtpId: g.smtpId,
    priority: g.priority,
    emailIds: g.ids,
    state: "pending",
    cursor: 0,
    createdAt: new Date(),
  });
  total += g.ids.length;
  groups.delete(key);
};

for await (const e of cursor) {
  const key = `${e.smtpId}:${e.priority}`;
  const g = groups.get(key) ?? { userId: e.userId, smtpId: e.smtpId, priority: e.priority, ids: [] };
  g.ids.push(e._id);
  groups.set(key, g);
  if (g.ids.length >= 1000) await flush(key);
}
for (const key of [...groups.keys()]) await flush(key);

console.log(`re-queued ${total} emails via the outbox`);
await closeQueues();
await mongo.close();
redis.disconnect();
