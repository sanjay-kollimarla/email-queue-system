import type { Lane } from "../../queue/queues.ts";
import type { JobQueue, RecoveryStore } from "../ports.ts";

export interface RecoveryPolicy {
  batch: number;
  sendingLeaseMs: number;
  /** a released email still `queued` this long after release must have a live job, or it was lost */
  reconcileAfterMs: number;
}

const LANES: Lane[] = ["transactional", "bulk"];
const byLane = <T extends { priority: Lane }>(rows: T[], lane: Lane) => rows.filter((r) => r.priority === lane);

/**
 * Self-healing. MongoDB is the source of truth; the queue is a cache that may lose data.
 *
 * (1) reapStuckSending: a worker died after claiming an email (status `sending`). Order matters for
 *     crash safety: first add a job with a DETERMINISTIC id for this stuck episode (delayed a few
 *     seconds), then flip the email back to `queued`. A crash in between is repaired next pass
 *     (duplicate jobId ignored, flip retried); the delay guarantees the job never runs before the flip.
 *
 * (2) reconcileLostJobs: Redis lost jobs (crash within the AOF fsync window, or wiped). Any released
 *     email still `queued` after reconcileAfterMs with no live job gets a new one. Emails whose job
 *     is alive (long backoff, paused account) are only re-stamped so they are not re-checked each pass.
 */
export class RecoveryService {
  constructor(
    private readonly store: RecoveryStore,
    private readonly queue: JobQueue,
    private readonly policy: RecoveryPolicy,
  ) {}

  async reapStuckSending(): Promise<number> {
    const cutoff = new Date(Date.now() - this.policy.sendingLeaseMs);
    const stuck = await this.store.findStuckSending(cutoff, this.policy.batch);
    if (stuck.length === 0) return 0;

    for (const lane of LANES) {
      const mine = byLane(stuck, lane);
      if (mine.length === 0) continue;
      await this.queue.enqueue(
        lane,
        mine.map((e) => ({
          jobId: `${e._id}-r${e.sendingAt!.getTime()}`,
          data: { emailId: String(e._id), smtpId: String(e.smtpId) },
          delayMs: 5000,
        })),
      );
    }
    await this.store.requeueStuck(
      stuck.map((e) => e._id),
      cutoff,
    );
    return stuck.length;
  }

  async reconcileLostJobs(): Promise<{ checked: number; recreated: number }> {
    const cutoff = new Date(Date.now() - this.policy.reconcileAfterMs);
    const candidates = await this.store.findReleasedBefore(cutoff, this.policy.batch);
    if (candidates.length === 0) return { checked: 0, recreated: 0 };

    const lost = (await Promise.all(candidates.map(async (e) => ((await this.queue.isLive(e.priority, String(e._id))) ? null : e)))).filter(
      (e): e is (typeof candidates)[number] => e !== null,
    );

    for (const lane of LANES) {
      const mine = byLane(lost, lane);
      if (mine.length === 0) continue;
      await this.queue.enqueue(
        lane,
        mine.map((e) => ({
          jobId: `${e._id}-rc${e.lastEnqueuedAt!.getTime()}`,
          data: { emailId: String(e._id), smtpId: String(e.smtpId) },
        })),
      );
    }
    await this.store.touchEnqueued(candidates.map((e) => e._id));
    return { checked: candidates.length, recreated: lost.length };
  }
}
