import type { AnyBulkWriteOperation } from "mongodb";
import { col, type EmailDoc } from "../../db/mongo.ts";

/**
 * Coalesces the hot-path "mark as sent" writes into bulkWrite calls (every `intervalMs` or
 * `maxOps`). One round trip per ~hundreds of emails instead of one per email is what lets a
 * worker sustain thousands of sends/second against MongoDB.
 *
 * Trade-off (documented in the README): if the process dies between SMTP acceptance and the next
 * flush, those emails stay `sending`, the reaper re-queues them after the lease and they may be
 * delivered twice. The deterministic Message-ID lets receivers/dedupers spot the duplicate.
 */
export class StatusWriter {
  private buf: AnyBulkWriteOperation<EmailDoc>[] = [];
  private timer: ReturnType<typeof setInterval>;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    intervalMs = 100,
    private maxOps = 500,
  ) {
    this.timer = setInterval(() => void this.flush(), intervalMs);
  }

  markSent(emailId: EmailDoc["_id"], response: string) {
    this.push({
      updateOne: {
        filter: { _id: emailId, status: "sending" },
        update: { $set: { status: "sent", sentAt: new Date(), response: response.slice(0, 300) }, $unset: { lastError: "" } },
      },
    });
  }

  private push(op: AnyBulkWriteOperation<EmailDoc>) {
    this.buf.push(op);
    if (this.buf.length >= this.maxOps) void this.flush();
  }

  flush(): Promise<void> {
    // serialize flushes so a slow Mongo never produces unbounded concurrent bulkWrites
    this.flushing = this.flushing.then(async () => {
      if (this.buf.length === 0) return;
      const ops = this.buf;
      this.buf = [];
      for (let attempt = 1; ; attempt++) {
        try {
          await col.emails().bulkWrite(ops, { ordered: false, writeConcern: { w: 1 } });
          return;
        } catch (e) {
          if (attempt >= 5) {
            console.error(`[status-writer] dropping ${ops.length} ops after ${attempt} attempts:`, (e as Error).message);
            return; // reaper will recover the affected emails
          }
          await new Promise((r) => setTimeout(r, 200 * attempt));
        }
      }
    });
    return this.flushing;
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
