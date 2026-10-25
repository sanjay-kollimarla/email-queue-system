import type { EmailDoc, SmtpAccountDoc } from "../../db/mongo.ts";
import type { SendOutcome } from "../../smtp/classify.ts";
import type { EmailStore, Metrics, SendJob, SendRateFeedback, SendRateGuard, SmtpDirectory } from "../ports.ts";

/**
 * Strategy pattern: one handler per way a send can fail. Adding a failure kind means adding a class
 * and one entry in `FailureHandlers`; the compiler (mapped type below) rejects a missing one, and
 * SendEmailService never changes (Open/Closed).
 */
export interface FailureContext<K extends SendOutcome["kind"]> {
  email: EmailDoc;
  smtp: SmtpAccountDoc;
  outcome: Extract<SendOutcome, { kind: K }>;
  job: SendJob;
}

export interface FailureHandler<K extends SendOutcome["kind"]> {
  handle(ctx: FailureContext<K>): Promise<void>;
}

export type FailureHandlers = { [K in SendOutcome["kind"]]: FailureHandler<K> };

export interface FailurePolicy {
  authPauseMs: number;
  defaultQuotaPauseMs: number;
}

const jitter = (maxMs: number) => Math.floor(Math.random() * maxMs);

/** 5xx / bad recipient: finished as failed, never retried; unknown mailboxes are suppressed for the tenant. */
export class PermanentFailureHandler implements FailureHandler<"permanent"> {
  constructor(
    private readonly emails: EmailStore,
    private readonly metrics: Metrics,
  ) {}
  async handle({ email, outcome }: FailureContext<"permanent">): Promise<void> {
    this.metrics.inc("failed");
    await this.emails.markFailed(email._id, outcome.reason);
    if (outcome.suppress) await this.emails.suppressRecipient(email.userId, email.to, outcome.reason);
  }
}

/** Provider said "slow down": multiplicative decrease, pause, retry later without using an attempt. */
export class ThrottleHandler implements FailureHandler<"throttle"> {
  constructor(
    private readonly emails: EmailStore,
    private readonly feedback: SendRateFeedback,
    private readonly smtps: SmtpDirectory,
    private readonly metrics: Metrics,
  ) {}
  async handle({ email, smtp, outcome, job }: FailureContext<"throttle">): Promise<void> {
    this.metrics.inc("throttled");
    await this.emails.revertToQueued(email._id, outcome.reason);
    const { rate, pauseUntil } = await this.feedback.onThrottle(smtp, outcome.retryAfterMs ?? 0);
    this.smtps.saveLearnedRate(smtp, rate);
    return job.defer(pauseUntil + jitter(1000));
  }
}

/** Daily quota hit: pause the whole account. */
export class QuotaHandler implements FailureHandler<"quota"> {
  constructor(
    private readonly emails: EmailStore,
    private readonly guard: SendRateGuard,
    private readonly policy: FailurePolicy,
  ) {}
  async handle({ email, smtp, outcome, job }: FailureContext<"quota">): Promise<void> {
    await this.emails.revertToQueued(email._id, outcome.reason);
    const until = Date.now() + (outcome.retryAfterMs ?? this.policy.defaultQuotaPauseMs);
    await this.guard.pause(String(smtp._id), until);
    return job.defer(until + jitter(5000));
  }
}

/** Credentials rejected: flag the account (the API refuses new sends for it) and hold its mail. */
export class AuthFailureHandler implements FailureHandler<"auth"> {
  constructor(
    private readonly emails: EmailStore,
    private readonly smtps: SmtpDirectory,
    private readonly guard: SendRateGuard,
    private readonly policy: FailurePolicy,
  ) {}
  async handle({ email, smtp, outcome, job }: FailureContext<"auth">): Promise<void> {
    await this.emails.revertToQueued(email._id, outcome.reason);
    await this.smtps.flagAuthFailed(smtp, outcome.reason);
    const until = Date.now() + this.policy.authPauseMs;
    await this.guard.pause(String(smtp._id), until);
    return job.defer(until + jitter(30_000));
  }
}

/** Network errors / unknown 4xx: BullMQ retries with exponential backoff (consumes an attempt). */
export class TransientFailureHandler implements FailureHandler<"transient"> {
  constructor(
    private readonly emails: EmailStore,
    private readonly metrics: Metrics,
  ) {}
  async handle({ email, outcome }: FailureContext<"transient">): Promise<void> {
    this.metrics.inc("transient");
    await this.emails.revertToQueued(email._id, outcome.reason);
    throw new Error(outcome.reason);
  }
}
