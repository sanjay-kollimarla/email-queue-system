import type { Context } from "hono";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { ValidationError } from "../core/errors.ts";
import type { EmailDoc, SmtpAccountDoc } from "../db/mongo.ts";
import type { SmtpAccountView } from "../core/api/smtp-account-service.ts";

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ValidationError("request body must be valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ValidationError("validation failed", z.flattenError(parsed.error));
  return parsed.data;
}

/** Plain email check that also rejects CR/LF and anything header-injection-shaped. */
export const emailSchema = z
  .string()
  .max(254)
  .regex(/^[^\s@<>(),;:\\"[\]]+@[^\s@<>(),;:\\"[\]]+\.[^\s@<>(),;:\\"[\]]+$/, "invalid email address");

export function objectIdParam(raw: string, what: string): ObjectId {
  if (!ObjectId.isValid(raw) || String(new ObjectId(raw)) !== raw.toLowerCase()) throw new ValidationError(`invalid ${what}`);
  return new ObjectId(raw);
}

// ---------- presenters: the only place that decides what leaves the API ----------
export const presentSmtp = (v: SmtpAccountView, extra: Record<string, unknown> = {}) => {
  const a: SmtpAccountDoc = v.account;
  return {
    id: String(a._id),
    name: a.name,
    host: a.host,
    port: a.port,
    secure: a.secure,
    username: a.username, // the password is never returned
    fromEmail: a.fromEmail,
    fromName: a.fromName,
    provider: a.provider,
    maxConnections: a.maxConnections,
    health: a.health,
    healthDetail: a.healthDetail,
    verifiedAt: a.verifiedAt,
    createdAt: a.createdAt,
    rate: {
      declared: a.limits,
      ceilingPerSec: a.ceilingPerSec,
      dailyCap: a.dailyCap ?? null,
      currentPerSec: v.rate.currentPerSec ?? null, // what the adaptive controller is sending at right now
      learnedLimitPerSec: v.rate.learnedLimitPerSec ?? null, // the limit it inferred from throttling
      pausedUntil: v.rate.pausedUntil,
    },
    ...extra,
  };
};

export const presentEmail = (e: EmailDoc) => ({
  id: String(e._id),
  to: e.to,
  status: e.status,
  priority: e.priority,
  smtpId: String(e.smtpId),
  attempts: e.attempts,
  messageId: e.messageId,
  lastError: e.lastError,
  response: e.response,
  createdAt: e.createdAt,
  sentAt: e.sentAt,
});
