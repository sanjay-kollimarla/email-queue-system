import { Worker } from "bullmq";
import { ObjectId } from "mongodb";
import { config } from "../config.ts";
import { buildSendWorker } from "../container.ts";
import { connectMongo, mongo } from "../db/mongo.ts";
import { BullSendJob } from "../infra/queue/bull-adapters.ts";
import { runService, type Service } from "../lifecycle.ts";
import { createRedis, redis } from "../lib/redis.ts";
import { QUEUE_NAMES, closeQueues, type Lane, type SendJobData } from "../queue/queues.ts";
import { closeAllTransports } from "../smtp/transport.ts";

const STATS_EVERY_MS = 5000;

class SendWorkerService implements Service {
  readonly name = "worker";
  private readonly app = buildSendWorker(this.name);
  private workers: Worker<SendJobData>[] = [];
  private statTimer?: ReturnType<typeof setInterval>;

  async start(): Promise<void> {
    await connectMongo();
    this.app.reporter.start();

    const { service, emails, metrics, metricsSink, log } = this.app;
    const lanes: Lane[] = ["transactional", "bulk"];
    this.workers = lanes.map((lane) => {
      const worker = new Worker<SendJobData>(QUEUE_NAMES[lane], (job, token) => service.handle(new BullSendJob(job, token)), {
        connection: createRedis(`worker-${lane}`),
        concurrency: lane === "bulk" ? config.WORKER_CONCURRENCY : Math.max(10, Math.ceil(config.WORKER_CONCURRENCY / 4)),
        lockDuration: 60_000,
        stalledInterval: 30_000,
        maxStalledCount: 2,
      });
      worker.on("error", (e) => log.error("queue error", { lane, error: e.message }));
      worker.on("failed", (job, err) => {
        if (!job || err.name === "DelayedError") return;
        // retries exhausted: finalize the email (stalled jobs are recovered by the reaper instead)
        if (job.attemptsMade >= (job.opts.attempts ?? 1) && !/stalled/i.test(err.message)) {
          metrics.inc("failed");
          void emails.markFailed(
            new ObjectId(job.data.emailId),
            `gave up after ${job.attemptsMade} attempts: ${err.message}`.slice(0, 500),
          );
        }
      });
      return worker;
    });

    let last = metrics.snapshot();
    let lastCpu = process.cpuUsage();
    this.statTimer = setInterval(() => {
      const now = metrics.snapshot();
      const cpu = process.cpuUsage(lastCpu);
      lastCpu = process.cpuUsage();
      const delta = Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v - last[k as keyof typeof last]]));
      last = now;
      // cluster-wide totals for the API /metrics endpoint
      for (const [k, v] of Object.entries(delta)) void metricsSink.add(k, v).catch(() => {});
      if (Object.values(delta).some((v) => v > 0)) {
        log.info("stats", {
          windowSec: STATS_EVERY_MS / 1000,
          ...delta,
          sentPerSec: Math.round(((delta.sent ?? 0) / STATS_EVERY_MS) * 1000),
          cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / STATS_EVERY_MS) * 100),
        });
      }
    }, STATS_EVERY_MS);

    log.info("started", { concurrency: config.WORKER_CONCURRENCY });
  }

  async stop(): Promise<void> {
    if (this.statTimer) clearInterval(this.statTimer);
    await Promise.all(this.workers.map((w) => w.close())); // waits for active jobs
    await this.app.reporter.stop();
    await this.app.writer.close();
    closeAllTransports();
    await closeQueues();
    await mongo.close();
    redis.disconnect();
  }
}

if (import.meta.main) await runService(new SendWorkerService());
