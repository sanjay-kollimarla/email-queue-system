import { DelayedError, type Job, type Queue } from "bullmq";
import type { JobQueue, SendJob } from "../../core/ports.ts";
import { queues, type Lane, type SendJobData } from "../../queue/queues.ts";

/** Adapts a BullMQ job to the SendJob port, hiding the moveToDelayed + DelayedError protocol. */
export class BullSendJob implements SendJob {
  constructor(
    private readonly job: Job<SendJobData>,
    private readonly token: string | undefined,
  ) {}

  get data(): Readonly<SendJobData> {
    return this.job.data;
  }

  async patch(patch: Partial<SendJobData>): Promise<void> {
    await this.job.updateData({ ...this.job.data, ...patch });
  }

  async defer(untilMs: number, opts: { patch?: Partial<SendJobData>; countDeferral?: boolean } = {}): Promise<never> {
    const deferrals = (this.job.data.deferrals ?? 0) + (opts.countDeferral === false ? 0 : 1);
    await this.job.updateData({ ...this.job.data, ...opts.patch, deferrals });
    await this.job.moveToDelayed(untilMs, this.token);
    throw new DelayedError();
  }
}

const LIVE = new Set(["waiting", "delayed", "active", "prioritized", "waiting-children"]);

export class BullJobQueue implements JobQueue {
  constructor(private readonly byLane: Record<Lane, Queue<SendJobData>> = queues) {}

  async enqueue(lane: Lane, jobs: Array<{ jobId: string; data: SendJobData; delayMs?: number }>): Promise<void> {
    await this.byLane[lane].addBulk(
      jobs.map((j) => ({
        name: "send",
        data: j.data,
        opts: { jobId: j.jobId, ...(j.delayMs ? { delay: j.delayMs } : {}) },
      })),
    );
  }

  readyDepth(lane: Lane): Promise<number> {
    return this.byLane[lane].getWaitingCount();
  }

  async isLive(lane: Lane, jobId: string): Promise<boolean> {
    const job = await this.byLane[lane].getJob(jobId);
    return job ? LIVE.has(await job.getState()) : false;
  }
}
