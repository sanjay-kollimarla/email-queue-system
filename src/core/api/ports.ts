/**
 * Ports for the HTTP-facing use cases (accounts, SMTP settings, intake, queries). Same rule as
 * core/ports.ts: services depend on these small interfaces; src/infra/* implements them.
 */
import type { ObjectId } from "mongodb";
import type {
  EmailDoc,
  EmailStatus,
  OutboxDoc,
  RefreshTokenDoc,
  SmtpAccountDoc,
  SuppressionDoc,
  TemplateDoc,
  UserDoc,
} from "../../db/mongo.ts";

// ---------- security primitives ----------
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, hash: string): Promise<boolean>;
  /** Burn the same time as a real verify so login timing does not reveal which emails exist. */
  verifyDummy(plain: string): Promise<void>;
}

export interface AccessTokenSigner {
  sign(userId: ObjectId): Promise<{ token: string; expiresInSec: number }>;
  /** Throws if the token is invalid or expired. */
  verify(token: string): Promise<ObjectId>;
}

export interface SecretBox {
  encrypt(plain: string): string;
}

/** Signed, non-expiring capability tokens: unsubscribe links and webhook URLs. */
export interface CapabilityTokens {
  sign(payload: string): string;
  verify(token: string): string | null;
}

export interface OpaqueTokens {
  generate(): string;
  hash(token: string): string;
}

// ---------- persistence ----------
export interface UserRepository {
  insert(user: UserDoc): Promise<void>; // throws DuplicateKeyError
  findByEmail(email: string): Promise<UserDoc | null>;
  findById(id: ObjectId): Promise<UserDoc | null>;
  updatePasswordHash(id: ObjectId, passwordHash: string): Promise<void>;
}

export interface RefreshTokenRepository {
  insert(doc: RefreshTokenDoc): Promise<void>;
  /** Atomically mark a live (unused, unrevoked, unexpired) token as used and return it. */
  consume(tokenHash: string): Promise<RefreshTokenDoc | null>;
  findByHash(tokenHash: string): Promise<RefreshTokenDoc | null>;
  deleteFamily(family: string): Promise<void>;
  deleteAllForUser(userId: ObjectId): Promise<void>;
}

export interface SmtpAccountRepository {
  insert(doc: SmtpAccountDoc): Promise<void>;
  count(userId: ObjectId): Promise<number>;
  list(userId: ObjectId): Promise<SmtpAccountDoc[]>;
  find(userId: ObjectId, id: ObjectId): Promise<SmtpAccountDoc | null>;
  /** Owner-agnostic lookup, only for capability-authenticated callers (webhooks). */
  findById(id: ObjectId): Promise<SmtpAccountDoc | null>;
  /** The user's accounts, at most `limit`: used to default the account when there is exactly one. */
  firstN(userId: ObjectId, limit: number): Promise<SmtpAccountDoc[]>;
  update(userId: ObjectId, id: ObjectId, changes: { set: Partial<SmtpAccountDoc>; unset?: string[] }): Promise<SmtpAccountDoc | null>;
  delete(id: ObjectId): Promise<void>;
}

export interface IntakeRepository {
  /** Content-addressed: identical content returns the same template. */
  upsertTemplate(
    userId: ObjectId,
    hash: string,
    content: Pick<TemplateDoc, "subject" | "text" | "html" | "attachments">,
  ): Promise<ObjectId>;
  findByIdempotencyKeys(userId: ObjectId, keys: string[]): Promise<EmailDoc[]>;
  findSuppressed(userId: ObjectId, lowerCasedEmails: string[]): Promise<Set<string>>;
  /** One transaction: all emails + (optionally) their outbox batch. Throws DuplicateKeyError on a key race. */
  commit(emails: EmailDoc[], outbox: OutboxDoc | null): Promise<void>;
}

export interface EmailQueryRepository {
  find(userId: ObjectId, id: ObjectId): Promise<EmailDoc | null>;
  list(userId: ObjectId, filter: { status?: EmailStatus; before?: ObjectId; limit: number }): Promise<EmailDoc[]>;
  countByStatus(userId: ObjectId, smtpId?: ObjectId): Promise<Record<EmailStatus, number>>;
}

export interface ThroughputPoint {
  /** start of the bucket */
  at: Date;
  sent: number;
}

/** Time-series reads for the dashboard. */
export interface DeliveryActivityRepository {
  /** Emails marked sent per `bucketSec` bucket since `since` (empty buckets are NOT returned). */
  sentPerBucket(userId: ObjectId, since: Date, bucketSec: number): Promise<ThroughputPoint[]>;
  recentProblems(
    userId: ObjectId,
    limit: number,
  ): Promise<Array<{ id: ObjectId; to: string; status: EmailStatus; reason?: string; at: Date }>>;
}

export interface SuppressionRepository {
  list(userId: ObjectId, limit: number): Promise<SuppressionDoc[]>;
  add(userId: ObjectId, email: string, reason: string): Promise<void>;
  remove(userId: ObjectId, email: string): Promise<boolean>;
}

// ---------- SMTP-related collaborators ----------
export interface SmtpConnectionTester {
  /** Resolves if we can connect and authenticate; rejects with a readable error otherwise. */
  verify(account: SmtpAccountDoc): Promise<void>;
}

export interface HostPolicy {
  /** Rejects hosts we must never connect to (private/loopback addresses: SSRF guard). */
  assertAllowed(host: string): Promise<void>;
}

export interface RateStateReader {
  state(smtpId: string): Promise<{ rate?: number; ssthresh?: number; pauseUntil: number }>;
  reset(smtpId: string): Promise<void>;
}

// ---------- infrastructure helpers ----------
export interface AttemptThrottle {
  /** Count one hit in a fixed window and return the new count. */
  hit(key: string, windowSec: number): Promise<number>;
}

export interface QueueStats {
  perLane(): Promise<Record<string, { waiting: number; active: number; delayed: number; failed: number; oldestWaitingAgeSec: number }>>;
}

export interface MetricsReader {
  totals(): Promise<Record<string, number>>;
}

export interface MetricsWriter {
  add(counter: string, n: number): Promise<void>;
}

export interface Readiness {
  check(): Promise<void>;
}

/** Security-relevant events (logins, credential changes, SMTP account changes): append-only, best effort. */
export interface AuditLog {
  record(action: string, entry?: { userId?: ObjectId; ip?: string; meta?: Record<string, unknown> }): void;
}
