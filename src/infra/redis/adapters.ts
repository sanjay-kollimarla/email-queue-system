import type { Redis } from "ioredis";
import type { Queue } from "bullmq";
import type { MetricsReader, MetricsWriter, QueueStats, Readiness, AttemptThrottle } from "../../core/api/ports.ts";
import { mongo } from "../../db/mongo.ts";
import type { Lane, SendJobData } from "../../queue/queues.ts";

export class RedisAttemptThrottle implements AttemptThrottle {
  constructor(private readonly redis: Redis) {}
  async hit(key: string, windowSec: number): Promise<number> {
    const bucket = `thr:${key}:${Math.floor(Date.now() / (windowSec * 1000))}`;
    const n = await this.redis.incr(bucket);
    if (n === 1) await this.redis.expire(bucket, windowSec * 2);
    return n;
  }
}

/** Cluster-wide counters: every worker process adds its deltas, the API exposes the totals. */
const METRICS_KEY = "emailq:metrics";
export class RedisMetrics implements MetricsReader, MetricsWriter {
  constructor(private readonly redis: Redis) {}
  async add(counter: string, n: number): Promise<void> {
    if (n !== 0) await this.redis.hincrby(METRICS_KEY, counter, n);
  }
  async totals(): Promise<Record<string, number>> {
    return Object.fromEntries(Object.entries(await this.redis.hgetall(METRICS_KEY)).map(([k, v]) => [k, Number(v)]));
  }
}

export class BullQueueStats implements QueueStats {
  constructor(private readonly queues: Record<Lane, Queue<SendJobData>>) {}
  async perLane() {
    const out: Awaited<ReturnType<QueueStats["perLane"]>> = {};
    for (const [lane, q] of Object.entries(this.queues)) {
      const [counts, oldest] = await Promise.all([q.getJobCounts("waiting", "active", "delayed", "failed"), q.getWaiting(0, 0)]);
      const ts = oldest[0]?.timestamp;
      out[lane] = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        delayed: counts.delayed ?? 0,
        failed: counts.failed ?? 0,
        oldestWaitingAgeSec: ts ? Math.max(0, (Date.now() - ts) / 1000) : 0,
      };
    }
    return out;
  }
}

export class MongoRedisReadiness implements Readiness {
  constructor(private readonly redis: Redis) {}
  async check(): Promise<void> {
    await Promise.all([mongo.db("admin").command({ ping: 1 }), this.redis.ping()]);
  }
}
