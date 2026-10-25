import { Queue, type JobsOptions } from "bullmq";
import { redis } from "../lib/redis.ts";

export type Lane = "transactional" | "bulk";

export const QUEUE_NAMES: Record<Lane, string> = {
  transactional: "email-transactional",
  bulk: "email-bulk",
};

/** Deliberately tiny: the email itself lives in MongoDB, Redis only carries ids. */
export interface SendJobData {
  emailId: string;
  smtpId: string;
  /** the execution-guard slot was already reserved on a previous deferral */
  pre?: boolean;
  /** how many times the job was deferred (throttle / pause); bounds a hopeless account */
  deferrals?: number;
}

export const JOB_ATTEMPTS = 6;

export const defaultJobOptions: JobsOptions = {
  attempts: JOB_ATTEMPTS,
  // transient failures only (5xx/permanent never retry; throttles are deferred without using an attempt)
  backoff: { type: "exponential", delay: 10_000, jitter: 0.5 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const queues: Record<Lane, Queue<SendJobData>> = {
  transactional: new Queue(QUEUE_NAMES.transactional, { connection: redis, defaultJobOptions }),
  bulk: new Queue(QUEUE_NAMES.bulk, { connection: redis, defaultJobOptions }),
};

export async function closeQueues() {
  await Promise.all(Object.values(queues).map((q) => q.close()));
}
