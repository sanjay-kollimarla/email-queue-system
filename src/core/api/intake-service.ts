import { ObjectId } from "mongodb";
import type { EmailDoc, OutboxDoc, SmtpAccountDoc } from "../../db/mongo.ts";
import { sha256 } from "../../lib/crypto.ts";
import { DuplicateKeyError } from "../errors.ts";
import type { AttachmentStore, MailAttachment } from "../ports.ts";
import type { IntakeRepository } from "./ports.ts";

export interface Recipient {
  to: string;
  vars?: Record<string, string>;
}

export interface IntakeInput {
  userId: ObjectId;
  smtp: SmtpAccountDoc;
  priority: "transactional" | "bulk";
  template: { subject: string; text?: string; html?: string };
  recipients: Recipient[];
  attachments?: MailAttachment[];
  /** batch idempotency: recipient i gets key `${key}:${i}`; a single send uses the key as is */
  idempotencyKey?: string;
  single?: boolean;
}

export interface AcceptedEmail {
  id: string;
  to: string;
  status: EmailDoc["status"];
  replayed: boolean;
}

/**
 * The write path of the API. Everything the pipeline needs to deliver is committed in ONE
 * transaction (transactional outbox): the emails (status=queued) and one outbox batch listing their
 * ids. The API never touches Redis here; the relay releases the batch at the account's rate, so a
 * Redis outage can neither lose nor half-accept a request.
 */
export class IntakeService {
  constructor(
    private readonly repo: IntakeRepository,
    private readonly attachments: AttachmentStore,
    private readonly messageIdDomain: string,
  ) {}

  async accept(input: IntakeInput): Promise<AcceptedEmail[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.acceptOnce(input);
      } catch (e) {
        // lost a race with a concurrent request carrying the same Idempotency-Key: re-evaluate
        if (e instanceof DuplicateKeyError && attempt < 2) continue;
        throw e;
      }
    }
  }

  private async acceptOnce(input: IntakeInput): Promise<AcceptedEmail[]> {
    const { userId, smtp, priority, recipients } = input;

    const refs = input.attachments?.length ? await Promise.all(input.attachments.map((f) => this.attachments.put(userId, f))) : undefined;
    const hash = sha256(
      JSON.stringify([
        input.template.subject,
        input.template.text ?? null,
        input.template.html ?? null,
        (refs ?? []).map((r) => [r.sha256, r.filename, r.contentType]),
      ]),
    );
    const templateId = await this.repo.upsertTemplate(userId, hash, { ...input.template, ...(refs ? { attachments: refs } : {}) });

    const keyOf = (i: number) =>
      input.idempotencyKey === undefined ? undefined : input.single ? input.idempotencyKey : `${input.idempotencyKey}:${i}`;

    const prior = new Map<string, EmailDoc>();
    if (input.idempotencyKey !== undefined) {
      const keys = recipients.map((_, i) => keyOf(i)!);
      for (const doc of await this.repo.findByIdempotencyKeys(userId, keys)) prior.set(doc.idempotencyKey!, doc);
    }

    const lower = recipients.map((r) => r.to.toLowerCase());
    const suppressed = await this.repo.findSuppressed(userId, [...new Set(lower)]);

    const result: AcceptedEmail[] = new Array(recipients.length);
    const docs: EmailDoc[] = [];
    const queuedIds: ObjectId[] = [];
    const now = new Date();

    recipients.forEach((r, i) => {
      const key = keyOf(i);
      const existing = key ? prior.get(key) : undefined;
      if (existing) {
        result[i] = { id: String(existing._id), to: existing.to, status: existing.status, replayed: true };
        return;
      }
      const _id = new ObjectId();
      const status = suppressed.has(lower[i]!) ? "suppressed" : "queued";
      docs.push({
        _id,
        userId,
        smtpId: smtp._id,
        templateId,
        to: r.to,
        toLower: lower[i]!,
        ...(r.vars && Object.keys(r.vars).length ? { vars: r.vars } : {}),
        ...(key ? { idempotencyKey: key } : {}),
        priority,
        status,
        attempts: 0,
        messageId: `<${_id}@${this.messageIdDomain}>`,
        createdAt: now,
      });
      if (status === "queued") queuedIds.push(_id);
      result[i] = { id: String(_id), to: r.to, status, replayed: false };
    });

    if (docs.length > 0) {
      const outbox: OutboxDoc | null =
        queuedIds.length > 0
          ? { _id: new ObjectId(), userId, smtpId: smtp._id, priority, emailIds: queuedIds, state: "pending", cursor: 0, createdAt: now }
          : null;
      await this.repo.commit(docs, outbox);
    }
    return result;
  }
}
