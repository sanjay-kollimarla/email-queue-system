/**
 * Ports: the narrow interfaces the application core depends on (Dependency Inversion).
 * The core never imports MongoDB, Redis, BullMQ or Nodemailer; src/infra/* provides adapters and
 * src/container.ts is the only place that wires them together. Interfaces are deliberately small
 * (Interface Segregation) so a test double only has to implement what a class really uses.
 */
import type { ObjectId } from "mongodb";
import type { AttachmentRef, EmailDoc, OutboxDoc, SmtpAccountDoc, TemplateDoc } from "../db/mongo.ts";
import type { Lane, SendJobData } from "../queue/queues.ts";

// ---------- persistence ----------
export interface EmailStore {
  /** Atomically move queued -> sending and return the email; null if someone else owns it or it is done. */
  claimForSending(id: ObjectId): Promise<EmailDoc | null>;
  /** Hot path: buffered, coalesced into bulk writes. */
  recordSent(id: ObjectId, response: string): void;
  revertToQueued(id: ObjectId, reason: string): Promise<void>;
  markFailed(id: ObjectId, reason: string): Promise<void>;
  suppressRecipient(userId: ObjectId, email: string, reason: string): Promise<void>;
}

export interface SmtpDirectory {
  find(id: string | ObjectId): Promise<SmtpAccountDoc | null>;
  flagAuthFailed(smtp: SmtpAccountDoc, detail: string): Promise<void>;
  /** Fire-and-forget persistence of the limit the adaptive controller inferred. */
  saveLearnedRate(smtp: SmtpAccountDoc, ratePerSec: number): void;
}

export interface TemplateStore {
  find(id: ObjectId): Promise<TemplateDoc | null>;
}

export interface OutboxStore {
  smtpIdsWithBacklog(): Promise<ObjectId[]>;
  claim(smtpId: ObjectId, lane: Lane): Promise<OutboxDoc | null>;
  /** Give a claimed document back untouched (no budget right now). */
  release(doc: OutboxDoc): Promise<void>;
  /** Record that `cursor` emails were released; completes the document when it reaches the end. */
  advance(doc: OutboxDoc, cursor: number): Promise<void>;
  failBacklog(doc: OutboxDoc, reason: string): Promise<void>;
  markEnqueued(emailIds: ObjectId[]): Promise<void>;
}

export interface RecoveryStore {
  findStuckSending(olderThan: Date, limit: number): Promise<Array<Pick<EmailDoc, "_id" | "smtpId" | "priority" | "sendingAt">>>;
  requeueStuck(ids: ObjectId[], olderThan: Date): Promise<void>;
  findReleasedBefore(cutoff: Date, limit: number): Promise<Array<Pick<EmailDoc, "_id" | "smtpId" | "priority" | "lastEnqueuedAt">>>;
  touchEnqueued(ids: ObjectId[]): Promise<void>;
}

// ---------- rate control (segregated by who uses it) ----------
type RateInfo = Pick<SmtpAccountDoc, "_id" | "ceilingPerSec" | "learnedRate">;

export interface SendRateGuard {
  acquire(a: RateInfo): Promise<{ paused: true; until: number } | { paused: false; waitMs: number; intervalMs: number }>;
  pausedUntil(smtpId: string): Promise<number>;
  pause(smtpId: string, untilMs: number): Promise<void>;
}

export interface SendRateFeedback {
  onSuccess(a: Pick<SmtpAccountDoc, "_id" | "ceilingPerSec">, n: number): Promise<{ rate: number; ssthresh: number }>;
  onThrottle(a: Pick<SmtpAccountDoc, "_id" | "ceilingPerSec">, retryAfterMs?: number): Promise<{ rate: number; pauseUntil: number }>;
}

export interface ReleaseBudget {
  credit(a: RateInfo & Pick<SmtpAccountDoc, "dailyCap">, want: number): Promise<number>;
}

// ---------- delivery & queueing ----------
export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface OutgoingMail {
  emailId: string;
  messageId: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: MailAttachment[];
  /** extra headers, e.g. List-Unsubscribe */
  headers?: Record<string, string>;
}

export interface AttachmentStore {
  put(userId: ObjectId, file: MailAttachment): Promise<AttachmentRef>;
  load(refs: AttachmentRef[]): Promise<MailAttachment[]>;
  /** Delete stored files nobody has used since `cutoff`; returns how many were removed. */
  purgeUnusedSince(cutoff: Date): Promise<number>;
}

/** Builds the per-email headers that depend on who the recipient is (e.g. one-click unsubscribe). */
export interface ListHeaders {
  forEmail(email: EmailDoc): Record<string, string>;
}
export interface DeliveryReceipt {
  response: string;
  rejected: string[];
}
export interface Mailer {
  send(smtp: SmtpAccountDoc, mail: OutgoingMail): Promise<DeliveryReceipt>;
}

/** What the send use case needs from a queue job (hides BullMQ's token / DelayedError mechanics). */
export interface SendJob {
  readonly data: Readonly<SendJobData>;
  /**
   * Re-schedule without consuming a retry attempt. Never returns: control flow is unwound to the
   * queue adapter. `countDeferral` feeds the "hopeless account" limit.
   */
  defer(untilMs: number, opts?: { patch?: Partial<SendJobData>; countDeferral?: boolean }): Promise<never>;
  patch(patch: Partial<SendJobData>): Promise<void>;
}

export interface JobQueue {
  enqueue(lane: Lane, jobs: Array<{ jobId: string; data: SendJobData; delayMs?: number }>): Promise<void>;
  readyDepth(lane: Lane): Promise<number>;
  /** true if a job with this id exists and can still run (waiting / delayed / active). */
  isLive(lane: Lane, jobId: string): Promise<boolean>;
}

export type Counter = "sent" | "throttled" | "deferred" | "failed" | "transient";
export interface Metrics {
  inc(counter: Counter, n?: number): void;
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}
