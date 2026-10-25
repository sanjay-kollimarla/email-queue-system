import { buildRelay } from "../container.ts";
import { connectMongo, mongo } from "../db/mongo.ts";
import { runService, type Service } from "../lifecycle.ts";
import { redis } from "../lib/redis.ts";
import { closeQueues } from "../queue/queues.ts";

const TICK_MS = 50;
const IDLE_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RelayService implements Service {
  readonly name = "relay";
  private readonly release = buildRelay();
  private stopping = false;
  private loop?: Promise<void>;

  async start(): Promise<void> {
    await connectMongo();
    this.loop = this.run();
    console.log(JSON.stringify({ level: "info", service: this.name, msg: "started", tickMs: TICK_MS }));
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await sleep((await this.release.tick()) ? TICK_MS : IDLE_MS);
      } catch (e) {
        console.error(JSON.stringify({ level: "error", service: this.name, msg: (e as Error).message }));
        await sleep(1000);
      }
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

if (import.meta.main) await runService(new RelayService());
