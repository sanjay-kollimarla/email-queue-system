import type { SmtpAccountDoc } from "../../db/mongo.ts";
import type { Logger, SendRateFeedback, SmtpDirectory } from "../ports.ts";

/**
 * Batches "N sends succeeded" signals for the adaptive rate controller: one Redis call per account per
 * interval instead of one per email. Only a limit learned from a throttle is persisted; the climb
 * during slow start is just warm-up.
 */
export class SuccessReporter {
  private pending = new Map<string, { smtp: SmtpAccountDoc; n: number }>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly feedback: SendRateFeedback,
    private readonly smtps: SmtpDirectory,
    private readonly log: Logger,
    private readonly intervalMs = 250,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
  }

  note(smtp: SmtpAccountDoc): void {
    const key = String(smtp._id);
    const entry = this.pending.get(key);
    if (entry) entry.n++;
    else this.pending.set(key, { smtp, n: 1 });
  }

  async flush(): Promise<void> {
    const batch = [...this.pending.values()];
    this.pending.clear();
    await Promise.all(
      batch.map(async ({ smtp, n }) => {
        try {
          const { ssthresh } = await this.feedback.onSuccess(smtp, n);
          if (ssthresh > 0) this.smtps.saveLearnedRate(smtp, ssthresh);
        } catch (e) {
          this.log.error("rate feedback flush failed", { error: (e as Error).message });
        }
      }),
    );
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
