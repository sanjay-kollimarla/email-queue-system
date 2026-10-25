import { type Collection, type Document, GridFSBucket, MongoClient, ObjectId } from "mongodb";
import { config } from "../config.ts";

// ---------- document types ----------
export interface UserDoc {
  _id: ObjectId;
  email: string;
  passwordHash: string;
  createdAt: Date;
}

export interface RefreshTokenDoc {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  family: string; // rotation family: reuse of a rotated token revokes the whole family
  expiresAt: Date;
  usedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
}

export interface SmtpLimits {
  perSecond?: number;
  perMinute?: number;
  perDay?: number;
}

export interface SmtpAccountDoc {
  _id: ObjectId;
  userId: ObjectId;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  passwordEnc: string; // AES-256-GCM, never returned by the API
  fromEmail: string;
  fromName?: string;
  provider: string; // detected from host ("gmail", "ses", ... or "custom")
  limits: SmtpLimits; // what the user declared (required: the hard ceiling)
  ceilingPerSec: number; // hard ceiling for the adaptive controller
  dailyCap?: number;
  learnedRate?: number; // last rate the adaptive controller settled on (msgs/sec)
  maxConnections: number;
  health: "ok" | "auth_failed";
  healthDetail?: string;
  verifiedAt?: Date;
  createdAt: Date;
}

/** Attachment bytes live in GridFS (content-addressed per user); mail documents only hold references. */
export interface AttachmentRef {
  fileId: ObjectId;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface TemplateDoc {
  _id: ObjectId;
  userId: ObjectId;
  hash: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: AttachmentRef[];
  createdAt: Date;
  /** refreshed on every use so retention never deletes a template that is still being sent */
  lastUsedAt: Date;
}

/**
 * queued -> sending -> sent -> (bounced | complained)   asynchronous outcomes reported by the provider
 *                  -> failed                          rejected by the SMTP server (permanent) or gave up
 * suppressed: never sent, the recipient is on the tenant's suppression list
 */
export type EmailStatus = "queued" | "sending" | "sent" | "failed" | "suppressed" | "bounced" | "complained";

export interface EmailDoc {
  _id: ObjectId;
  userId: ObjectId;
  smtpId: ObjectId;
  templateId: ObjectId;
  to: string;
  /** lower-cased recipient: exact, indexed matching for bounce/complaint feedback */
  toLower: string;
  vars?: Record<string, string>;
  idempotencyKey?: string;
  priority: "transactional" | "bulk";
  status: EmailStatus;
  attempts: number;
  messageId: string;
  lastError?: string;
  response?: string;
  createdAt: Date;
  sendingAt?: Date;
  sentAt?: Date;
  /** last time a send job for this email was (re)created or verified to exist; drives the reconciler */
  lastEnqueuedAt?: Date;
}

export interface OutboxDoc {
  _id: ObjectId;
  userId: ObjectId;
  smtpId: ObjectId;
  priority: "transactional" | "bulk";
  emailIds: ObjectId[];
  state: "pending" | "releasing" | "done";
  /** how many of emailIds were already released to the send queue (paced by the account credit bucket) */
  cursor: number;
  leaseUntil?: Date;
  createdAt: Date;
  doneAt?: Date;
}

export interface AuditLogDoc {
  _id: ObjectId;
  userId?: ObjectId;
  action: string;
  ip?: string;
  meta?: Record<string, unknown>;
  at: Date;
}

export interface SuppressionDoc {
  _id: ObjectId;
  userId: ObjectId;
  email: string;
  reason: string;
  createdAt: Date;
}

// ---------- client ----------
export const mongo = new MongoClient(config.MONGO_URL, {
  maxPoolSize: 100,
  retryWrites: true,
  ignoreUndefined: true, // `undefined` fields are omitted, not stored as null
  writeConcern: { w: "majority" },
});

const db = () => mongo.db(config.MONGO_DB);

export const col = {
  users: () => db().collection<UserDoc>("users"),
  refreshTokens: () => db().collection<RefreshTokenDoc>("refreshTokens"),
  smtpAccounts: () => db().collection<SmtpAccountDoc>("smtpAccounts"),
  templates: () => db().collection<TemplateDoc>("templates"),
  emails: () => db().collection<EmailDoc>("emails"),
  outbox: () => db().collection<OutboxDoc>("outbox"),
  suppressions: () => db().collection<SuppressionDoc>("suppressions"),
  auditLogs: () => db().collection<AuditLogDoc>("auditLogs"),
};

export const bucket = () => new GridFSBucket(db(), { bucketName: "attachments" });
export const attachmentFiles = () =>
  db().collection<{ _id: ObjectId; length: number; metadata?: { userId: ObjectId; sha256: string; lastUsedAt: Date } }>(
    "attachments.files",
  );

export async function connectMongo() {
  await mongo.connect();
  await ensureIndexes();
}

const DAY_SEC = 24 * 3600;
const RETENTION_SEC = config.EMAIL_RETENTION_DAYS * DAY_SEC;

/**
 * TTL indexes cannot be re-created with a different lifetime; when the configured retention changes,
 * fall back to collMod so the new value applies without dropping the index.
 */
async function ensureTtlIndex<T extends Document>(collection: Collection<T>, key: Record<string, 1>, seconds: number) {
  try {
    await collection.createIndex(key, { expireAfterSeconds: seconds });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 85 && code !== 86) throw e;
    await db().command({ collMod: collection.collectionName, index: { keyPattern: key, expireAfterSeconds: seconds } });
  }
}

export async function ensureIndexes() {
  await Promise.all([
    col.users().createIndex({ email: 1 }, { unique: true }),
    col.refreshTokens().createIndex({ tokenHash: 1 }, { unique: true }),
    col.refreshTokens().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    col.refreshTokens().createIndex({ family: 1 }),
    col.smtpAccounts().createIndex({ userId: 1 }),
    col.templates().createIndex({ userId: 1, hash: 1 }, { unique: true }),
    // idempotency: one email per (user, key)
    col
      .emails()
      .createIndex({ userId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }),
    col.emails().createIndex({ userId: 1, status: 1, _id: -1 }),
    col.emails().createIndex({ smtpId: 1, status: 1 }),
    // dashboard throughput: sent-per-bucket for one tenant over a recent window
    col.emails().createIndex({ userId: 1, sentAt: -1 }, { partialFilterExpression: { sentAt: { $exists: true } } }),
    col.emails().createIndex({ smtpId: 1, toLower: 1, _id: -1 }),
    col.emails().createIndex({ sendingAt: 1 }, { partialFilterExpression: { status: "sending" } }),
    col.emails().createIndex({ lastEnqueuedAt: 1 }, { partialFilterExpression: { status: "queued", lastEnqueuedAt: { $exists: true } } }),
    ensureTtlIndex(col.emails(), { createdAt: 1 }, RETENTION_SEC),
    // bounce/complaint webhooks locate the email by the Message-ID we generated
    col.emails().createIndex({ messageId: 1 }, { unique: true }),
    ensureTtlIndex(col.templates(), { lastUsedAt: 1 }, RETENTION_SEC + 7 * DAY_SEC),
    ensureTtlIndex(col.auditLogs(), { at: 1 }, 365 * DAY_SEC),
    col.auditLogs().createIndex({ userId: 1, at: -1 }),
    attachmentFiles().createIndex({ "metadata.userId": 1, "metadata.sha256": 1 }),
    attachmentFiles().createIndex({ "metadata.lastUsedAt": 1 }),
    // covers both the "which accounts have work" distinct() and the per-account claim
    col.outbox().createIndex({ state: 1, smtpId: 1, priority: 1, createdAt: 1 }),
    col.outbox().createIndex({ doneAt: 1 }, { expireAfterSeconds: 24 * 3600 }),
    col.suppressions().createIndex({ userId: 1, email: 1 }, { unique: true }),
  ]);
}

/** Multi-document transaction (requires a replica set). */
export async function withTxn<T>(fn: (session: import("mongodb").ClientSession) => Promise<T>): Promise<T> {
  const session = mongo.startSession();
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { writeConcern: { w: "majority" }, readConcern: { level: "snapshot" } },
    );
    return result;
  } finally {
    await session.endSession();
  }
}

export { ObjectId };
export type { Collection };

export const toObjectId = (id: string): ObjectId | null =>
  ObjectId.isValid(id) && String(new ObjectId(id)) === id.toLowerCase() ? new ObjectId(id) : null;
