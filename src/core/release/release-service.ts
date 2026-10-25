import type { ObjectId } from "mongodb";
import type { Lane } from "../../queue/queues.ts";
import type { JobQueue, Logger, OutboxStore, ReleaseBudget, SmtpDirectory } from "../ports.ts";

export interface ReleasePolicy {
  maxChunk: number;
  maxIterationsPerTick: number;
  /** backpressure: stop releasing while a lane already has this many ready jobs */
  maxReady: number;
}

const LANES: Lane[] = ["transactional", "bulk"]; // strict priority within an account

/**
 * The paced release valve between MongoDB (durable backlog) and the hot queue.
 *
 *   outbox (pending, MongoDB) --[credits from the account's token bucket]--> ready queue
 *
 * A backlog stays in MongoDB and only as many emails as the account may send RIGHT NOW are moved
 * to the queue each tick. Backlog size therefore never affects Redis memory, and a throttle, pause
 * or daily cap takes effect within one tick instead of after a pre-scheduled backlog drains.
 */
export class ReleaseService {
  private lastBackpressureLog = 0;

  constructor(
    private readonly outbox: OutboxStore,
    private readonly smtps: SmtpDirectory,
    private readonly budget: ReleaseBudget,
    private readonly queue: JobQueue,
    private readonly policy: ReleasePolicy,
    private readonly log: Logger,
  ) {}

  /** One pass over every account with a backlog. Returns false when there was nothing to do. */
  async tick(): Promise<boolean> {
    const smtpIds = await this.outbox.smtpIdsWithBacklog();
    if (smtpIds.length === 0) return false;

    const [tx, bulk] = await Promise.all(LANES.map((l) => this.queue.readyDepth(l)));
    const open: Record<Lane, boolean> = {
      transactional: tx! < this.policy.maxReady,
      bulk: bulk! < this.policy.maxReady,
    };
    if (!open.transactional || !open.bulk) this.logBackpressure(tx!, bulk!);

    await Promise.all(
      smtpIds.map((id) =>
        this.releaseFor(id, open).catch((e) => this.log.error("release failed", { smtpId: String(id), error: (e as Error).message })),
      ),
    );
    return true;
  }

  private async releaseFor(smtpId: ObjectId, open: Record<Lane, boolean>): Promise<void> {
    const smtp = await this.smtps.find(smtpId);
    if (!smtp) return this.failBacklog(smtpId);
    if (smtp.health === "auth_failed") return; // hold the backlog in MongoDB until credentials are fixed

    for (const lane of LANES) {
      if (!open[lane]) continue;
      for (let i = 0; i < this.policy.maxIterationsPerTick; i++) {
        const doc = await this.outbox.claim(smtpId, lane);
        if (!doc) break;

        const want = Math.min(doc.emailIds.length - doc.cursor, this.policy.maxChunk);
        const granted = await this.budget.credit(smtp, want);
        if (granted === 0) {
          await this.outbox.release(doc);
          return; // no budget for this account right now; lower lanes share it, so skip them too
        }

        const ids = doc.emailIds.slice(doc.cursor, doc.cursor + granted);
        // jobId = emailId: re-releasing after a crash cannot create duplicate jobs
        await this.queue.enqueue(
          lane,
          ids.map((id) => ({ jobId: String(id), data: { emailId: String(id), smtpId: String(smtp._id) } })),
        );
        await this.outbox.markEnqueued(ids);
        await this.outbox.advance(doc, doc.cursor + granted);
        if (granted < want) break; // budget exhausted for this tick
      }
    }
  }

  private async failBacklog(smtpId: ObjectId): Promise<void> {
    for (const lane of LANES) {
      for (let doc = await this.outbox.claim(smtpId, lane); doc; doc = await this.outbox.claim(smtpId, lane)) {
        await this.outbox.failBacklog(doc, "smtp account was deleted");
      }
    }
  }

  private logBackpressure(tx: number, bulk: number): void {
    if (Date.now() - this.lastBackpressureLog < 10_000) return;
    this.lastBackpressureLog = Date.now();
    this.log.info("backpressure: ready queue full, backlog stays in MongoDB", { tx, bulk, max: this.policy.maxReady });
  }
}
