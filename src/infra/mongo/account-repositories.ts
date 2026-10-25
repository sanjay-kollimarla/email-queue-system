import type { ObjectId } from "mongodb";
import { DuplicateKeyError } from "../../core/errors.ts";
import type {
  AuditLog,
  RefreshTokenRepository,
  SmtpAccountRepository,
  SuppressionRepository,
  UserRepository,
} from "../../core/api/ports.ts";
import { col, type RefreshTokenDoc, type SmtpAccountDoc, type SuppressionDoc, type UserDoc } from "../../db/mongo.ts";
import { ObjectId as Oid } from "../../db/mongo.ts";

/** Translate the driver's duplicate-key error into a domain error so services never see error code 11000. */
export const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;

export class MongoUserRepository implements UserRepository {
  async insert(user: UserDoc): Promise<void> {
    try {
      await col.users().insertOne(user);
    } catch (e) {
      if (isDuplicateKey(e)) throw new DuplicateKeyError("user exists");
      throw e;
    }
  }
  findByEmail(email: string) {
    return col.users().findOne({ email });
  }
  findById(id: ObjectId) {
    return col.users().findOne({ _id: id });
  }
  async updatePasswordHash(id: ObjectId, passwordHash: string): Promise<void> {
    await col.users().updateOne({ _id: id }, { $set: { passwordHash } });
  }
}

export class MongoRefreshTokenRepository implements RefreshTokenRepository {
  async insert(doc: RefreshTokenDoc): Promise<void> {
    await col.refreshTokens().insertOne(doc);
  }
  consume(tokenHash: string) {
    return col
      .refreshTokens()
      .findOneAndUpdate(
        { tokenHash, usedAt: { $exists: false }, revokedAt: { $exists: false }, expiresAt: { $gt: new Date() } },
        { $set: { usedAt: new Date() } },
        { returnDocument: "before" },
      );
  }
  findByHash(tokenHash: string) {
    return col.refreshTokens().findOne({ tokenHash });
  }
  async deleteFamily(family: string): Promise<void> {
    await col.refreshTokens().deleteMany({ family });
  }
  async deleteAllForUser(userId: ObjectId): Promise<void> {
    await col.refreshTokens().deleteMany({ userId });
  }
}

export class MongoSmtpAccountRepository implements SmtpAccountRepository {
  async insert(doc: SmtpAccountDoc): Promise<void> {
    await col.smtpAccounts().insertOne(doc);
  }
  count(userId: ObjectId) {
    return col.smtpAccounts().countDocuments({ userId });
  }
  list(userId: ObjectId) {
    return col.smtpAccounts().find({ userId }).sort({ _id: 1 }).toArray();
  }
  find(userId: ObjectId, id: ObjectId) {
    return col.smtpAccounts().findOne({ _id: id, userId });
  }
  findById(id: ObjectId) {
    return col.smtpAccounts().findOne({ _id: id });
  }
  firstN(userId: ObjectId, limit: number) {
    return col.smtpAccounts().find({ userId }).limit(limit).toArray();
  }
  update(userId: ObjectId, id: ObjectId, changes: { set: Partial<SmtpAccountDoc>; unset?: string[] }) {
    const unset = Object.fromEntries((changes.unset ?? []).map((k) => [k, "" as const]));
    return col.smtpAccounts().findOneAndUpdate(
      { _id: id, userId },
      {
        ...(Object.keys(changes.set).length ? { $set: changes.set } : {}),
        ...(Object.keys(unset).length ? { $unset: unset } : {}),
      },
      { returnDocument: "after" },
    );
  }
  async delete(id: ObjectId): Promise<void> {
    await col.smtpAccounts().deleteOne({ _id: id });
  }
}

export class MongoSuppressionRepository implements SuppressionRepository {
  list(userId: ObjectId, limit: number): Promise<SuppressionDoc[]> {
    return col.suppressions().find({ userId }).sort({ _id: -1 }).limit(limit).toArray();
  }
  async add(userId: ObjectId, email: string, reason: string): Promise<void> {
    await col
      .suppressions()
      .updateOne({ userId, email }, { $setOnInsert: { _id: new Oid(), reason, createdAt: new Date() } }, { upsert: true });
  }
  async remove(userId: ObjectId, email: string): Promise<boolean> {
    return (await col.suppressions().deleteOne({ userId, email })).deletedCount > 0;
  }
}

export class MongoAuditLog implements AuditLog {
  record(action: string, entry: { userId?: Oid; ip?: string; meta?: Record<string, unknown> } = {}): void {
    // never let auditing break (or slow) the request it describes
    col
      .auditLogs()
      .insertOne({ _id: new Oid(), action, ...entry, at: new Date() })
      .catch(() => {});
  }
}
