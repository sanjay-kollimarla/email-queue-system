import { ObjectId } from "mongodb";
import { DuplicateKeyError } from "../../core/errors.ts";
import type { EmailQueryRepository, IntakeRepository } from "../../core/api/ports.ts";
import { col, withTxn, type EmailDoc, type EmailStatus, type OutboxDoc, type TemplateDoc } from "../../db/mongo.ts";
import { isDuplicateKey } from "./account-repositories.ts";

export class MongoIntakeRepository implements IntakeRepository {
  async upsertTemplate(
    userId: ObjectId,
    hash: string,
    content: Pick<TemplateDoc, "subject" | "text" | "html" | "attachments">,
  ): Promise<ObjectId> {
    const now = new Date();
    const tpl = await col.templates().findOneAndUpdate(
      { userId, hash },
      {
        $setOnInsert: { _id: new ObjectId(), userId, hash, ...content, createdAt: now },
        $set: { lastUsedAt: now }, // keeps retention from deleting a template that is still in use
      },
      { upsert: true, returnDocument: "after" },
    );
    return tpl!._id;
  }

  findByIdempotencyKeys(userId: ObjectId, keys: string[]): Promise<EmailDoc[]> {
    return col
      .emails()
      .find({ userId, idempotencyKey: { $in: keys } })
      .toArray();
  }

  async findSuppressed(userId: ObjectId, lowerCasedEmails: string[]): Promise<Set<string>> {
    const rows = await col
      .suppressions()
      .find({ userId, email: { $in: lowerCasedEmails } }, { projection: { email: 1 } })
      .toArray();
    return new Set(rows.map((r) => r.email));
  }

  /** Accepted emails are written w:majority inside a transaction: an acknowledged email is never lost. */
  async commit(emails: EmailDoc[], outbox: OutboxDoc | null): Promise<void> {
    try {
      await withTxn(async (session) => {
        await col.emails().insertMany(emails, { session, ordered: true });
        if (outbox) await col.outbox().insertOne(outbox, { session });
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw new DuplicateKeyError("idempotency key already used");
      throw e;
    }
  }
}

export class MongoEmailQueryRepository implements EmailQueryRepository {
  find(userId: ObjectId, id: ObjectId) {
    return col.emails().findOne({ _id: id, userId });
  }

  list(userId: ObjectId, f: { status?: EmailStatus; before?: ObjectId; limit: number }) {
    return col
      .emails()
      .find({ userId, ...(f.status ? { status: f.status } : {}), ...(f.before ? { _id: { $lt: f.before } } : {}) })
      .sort({ _id: -1 })
      .limit(f.limit)
      .toArray();
  }

  async countByStatus(userId: ObjectId, smtpId?: ObjectId): Promise<Record<EmailStatus, number>> {
    const rows = await col
      .emails()
      .aggregate<{ _id: EmailStatus; n: number }>([
        { $match: { userId, ...(smtpId ? { smtpId } : {}) } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ])
      .toArray();
    const counts: Record<EmailStatus, number> = { queued: 0, sending: 0, sent: 0, failed: 0, suppressed: 0, bounced: 0, complained: 0 };
    for (const r of rows) counts[r._id] = r.n;
    return counts;
  }
}
