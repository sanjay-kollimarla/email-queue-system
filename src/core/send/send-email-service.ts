import { ObjectId } from "mongodb";
import type { EmailDoc, SmtpAccountDoc } from "../../db/mongo.ts";
import { renderTemplate } from "../../lib/template.ts";
import type { SendOutcome } from "../../smtp/classify.ts";
import type {
  AttachmentStore,
  EmailStore,
  ListHeaders,
  Mailer,
  Metrics,
  SendJob,
  SendRateGuard,
  SmtpDirectory,
  TemplateStore,
} from "../ports.ts";
import type { FailureHandlers } from "./failure-handlers.ts";
import { GateRegistry } from "./gate.ts";
import type { SuccessReporter } from "./success-reporter.ts";

export interface SendPolicy {
  maxDeferrals: number;
  authPauseMs: number;
  /** a job may park this long in-process for a free connection before yielding its slot (it is NOT claimed meanwhile) */
  gateWaitMs: number;
  /** jobs allowed to park (unclaimed) per account beyond the active tier */
  maxGateWaiters: number;
  /** burst the execution guard tolerates before deferring */
  execToleranceMs: number;
}

export interface SendDeps {
  emails: EmailStore;
  smtps: SmtpDirectory;
  templates: TemplateStore;
  attachments: AttachmentStore;
  listHeaders: ListHeaders;
  guard: SendRateGuard;
  mailer: Mailer;
  reporter: SuccessReporter;
  failures: FailureHandlers;
  classify: (err: unknown) => SendOutcome;
  metrics: Metrics;
  policy: SendPolicy;
}

const jitter = (maxMs: number) => Math.floor(Math.random() * maxMs);

/**
 * Use case: deliver one queued email through its owner's SMTP account.
 *
 *   resolve account -> bulkhead -> rate guard -> claim -> render -> send -> (success | failure strategy)
 *
 * Pure orchestration: every collaborator is injected through a port, so each step is unit-testable
 * with fakes and no MongoDB / Redis / SMTP.
 */
export class SendEmailService {
  private readonly gates = new GateRegistry();

  constructor(private readonly d: SendDeps) {}

  async handle(job: SendJob): Promise<void> {
    const { emailId, smtpId } = job.data;
    const emailOid = new ObjectId(emailId);
    const { policy } = this.d;

    const smtp = await this.d.smtps.find(smtpId);
    if (!smtp) return this.fail(emailOid, "smtp account was deleted");
    if ((job.data.deferrals ?? 0) > policy.maxDeferrals) {
      return this.fail(emailOid, `gave up after ${policy.maxDeferrals} deferrals (account throttled/paused/unreachable)`);
    }
    if (smtp.health === "auth_failed") return job.defer(Date.now() + policy.authPauseMs + jitter(30_000));

    const gate = this.gates.for(smtpId);
    // 2x the pool: the extra jobs overlap their claim/rate-check round trips with sends already in progress,
    // yet each waits at most about one send duration for a connection (far below the reaper's lease)
    const activeLimit = smtp.maxConnections * 2;
    if (!(await gate.acquire(activeLimit, policy.maxGateWaiters, policy.gateWaitMs))) {
      return job.defer(Date.now() + 100 + jitter(150), { countDeferral: false });
    }
    try {
      await this.deliver(job, smtp, emailOid);
    } finally {
      gate.release();
    }
  }

  private async deliver(job: SendJob, smtp: SmtpAccountDoc, emailOid: ObjectId): Promise<void> {
    const { emails, guard, policy } = this.d;

    // rate guard: enforce the account's CURRENT adaptive rate and any pause
    if (job.data.pre) {
      const until = await guard.pausedUntil(String(smtp._id));
      if (until > Date.now()) return job.defer(until + jitter(1000));
      await job.patch({ pre: false }); // so a later retry is charged again
    } else {
      const g = await guard.acquire(smtp);
      if (g.paused) return job.defer(g.until + jitter(1000));
      if (g.waitMs > policy.execToleranceMs) {
        return job.defer(Date.now() + g.waitMs, { patch: { pre: true }, countDeferral: false });
      }
    }

    // claim + fetch in one round trip; only a `queued` email can be claimed, so duplicate/stale jobs are no-ops
    const email = await emails.claimForSending(emailOid);
    if (!email) return;

    const tpl = await this.d.templates.find(email.templateId);
    if (!tpl) return this.fail(emailOid, "template missing");

    let outcome: SendOutcome | undefined;
    try {
      const msg = renderTemplate(tpl, email.vars);
      const attachments = tpl.attachments?.length ? await this.d.attachments.load(tpl.attachments) : undefined;
      const receipt = await this.d.mailer.send(smtp, {
        emailId: String(email._id),
        messageId: email.messageId,
        to: email.to,
        ...msg,
        attachments,
        headers: this.d.listHeaders.forEmail(email),
      });
      if (receipt.rejected.length > 0) {
        outcome = { kind: "permanent", reason: `recipient rejected: ${receipt.response}`.slice(0, 500), suppress: true };
      } else {
        emails.recordSent(email._id, receipt.response);
        this.d.reporter.note(smtp);
        this.d.metrics.inc("sent");
        return;
      }
    } catch (err) {
      outcome = this.d.classify(err);
    }
    await this.applyFailure(outcome, { email, smtp, job });
  }

  /** Dispatch to the strategy registered for this outcome kind. */
  private applyFailure(outcome: SendOutcome, ctx: { email: EmailDoc; smtp: SmtpAccountDoc; job: SendJob }) {
    // the mapped type FailureHandlers guarantees a handler exists for every kind
    const handler = this.d.failures[outcome.kind] as { handle(c: unknown): Promise<void> };
    return handler.handle({ ...ctx, outcome });
  }

  private async fail(id: ObjectId, reason: string): Promise<void> {
    this.d.metrics.inc("failed");
    await this.d.emails.markFailed(id, reason);
  }
}
