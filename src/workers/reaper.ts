import { buildRecovery } from "../container.ts";
import { connectMongo, mongo } from "../db/mongo.ts";
import { runService, type Service } from "../lifecycle.ts";
import { redis } from "../lib/redis.ts";
import { closeQueues } from "../queue/queues.ts";

const BATCH = 500;
const HOUSEKEEPING_EVERY_MS = 6 * 3600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class ReaperService implements Service {
  readonly name = "reaper";
  private readonly app = buildRecovery();
  private stopping = false;
  private loop?: Promise<void>;

  async start(): Promise<void> {
    await connectMongo();
    this.loop = this.run();
    this.app.log.info("started");
  }

  private async run(): Promise<void> {
    const { service, housekeeping, log } = this.app;
    let lastHousekeeping = 0;
    while (!this.stopping) {
      let busy = false;
      try {
        const stuck = await service.reapStuckSending();
        if (stuck > 0) log.warn("re-queued stuck sends", { count: stuck });
        const rec = await service.reconcileLostJobs();
        if (rec.recreated > 0) log.warn("recreated lost jobs", { count: rec.recreated, checked: rec.checked });
        busy = stuck === BATCH || rec.checked === BATCH;
        if (Date.now() - lastHousekeeping > HOUSEKEEPING_EVERY_MS) {
          lastHousekeeping = Date.now();
          const purged = await housekeeping.purgeAttachments();
          if (purged > 0) log.info("purged unused attachments", { count: purged });
        }
      } catch (e) {
        log.error("pass failed", { error: (e as Error).message });
        await sleep(5000);
      }
      await sleep(busy ? 100 : 15_000);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.loop;
    await closeQueues();
    await mongo.close();
    redis.disconnect();
  }
}

if (import.meta.main) await runService(new ReaperService());
