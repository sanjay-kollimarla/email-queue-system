import { z } from "zod";

/**
 * The API contract, validated at the network boundary. One schema is the single source of truth for both the
 * runtime check and the TypeScript type, so a server change that breaks the UI fails loudly in one place
 * (ApiError "unexpected response") instead of rendering `undefined` somewhere deep in a component.
 */
export const emailStatus = z.enum(["queued", "sending", "sent", "failed", "suppressed", "bounced", "complained"]);
export type EmailStatus = z.infer<typeof emailStatus>;
export const EMAIL_STATUSES = emailStatus.options;

export const user = z.object({ id: z.string(), email: z.string() });
export type User = z.infer<typeof user>;

export const authResult = z.object({
  user: user.optional(),
  accessToken: z.string(),
  expiresIn: z.number(),
});

export const me = z.object({ id: z.string(), email: z.string(), createdAt: z.string() });

export const limits = z.object({
  perSecond: z.number().optional(),
  perMinute: z.number().optional(),
  perDay: z.number().optional(),
});
export type Limits = z.infer<typeof limits>;

export const providerHint = z.object({
  limits: limits,
  maxConnections: z.number().optional(),
  note: z.string(),
});
export type ProviderHint = z.infer<typeof providerHint>;

export const smtpAccount = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  secure: z.boolean(),
  username: z.string(),
  fromEmail: z.string(),
  fromName: z.string().optional(),
  provider: z.string(),
  maxConnections: z.number(),
  health: z.enum(["ok", "auth_failed"]),
  healthDetail: z.string().optional(),
  verifiedAt: z.string().optional(),
  createdAt: z.string(),
  webhookUrl: z.string().optional(),
  providerHint: providerHint.optional(),
  rate: z.object({
    declared: limits,
    ceilingPerSec: z.number(),
    dailyCap: z.number().nullable(),
    currentPerSec: z.number().nullable(),
    learnedLimitPerSec: z.number().nullable(),
    pausedUntil: z.string().nullable(),
  }),
});
export type SmtpAccount = z.infer<typeof smtpAccount>;
export const smtpList = z.object({ items: z.array(smtpAccount) });

export const smtpHint = z.object({
  provider: z.string(),
  limits: limits.optional(),
  maxConnections: z.number().optional(),
  note: z.string().optional(),
});
export type SmtpHint = z.infer<typeof smtpHint>;

export const email = z.object({
  id: z.string(),
  to: z.string(),
  status: emailStatus,
  priority: z.enum(["transactional", "bulk"]),
  smtpId: z.string(),
  attempts: z.number(),
  messageId: z.string(),
  lastError: z.string().optional(),
  response: z.string().optional(),
  createdAt: z.string(),
  sentAt: z.string().optional(),
});
export type Email = z.infer<typeof email>;
export const emailPage = z.object({ items: z.array(email), nextCursor: z.string().nullable() });

export const accepted = z.object({ id: z.string(), to: z.string(), status: emailStatus, replayed: z.boolean() });
export const batchAccepted = z.object({
  count: z.number(),
  queued: z.number(),
  suppressed: z.number(),
  replayed: z.number(),
  accepted: z.array(accepted),
});
export type BatchAccepted = z.infer<typeof batchAccepted>;

export const statusCounts = z.object({
  queued: z.number(),
  sending: z.number(),
  sent: z.number(),
  failed: z.number(),
  suppressed: z.number(),
  bounced: z.number(),
  complained: z.number(),
});
export type StatusCounts = z.infer<typeof statusCounts>;

export const dashboard = z.object({
  now: z.string(),
  counts: statusCounts,
  total: z.number(),
  throughput: z.object({
    bucketSec: z.number(),
    points: z.array(z.object({ at: z.string(), sent: z.number() })),
    sentPerSecNow: z.number(),
    peakPerSec: z.number(),
  }),
  accounts: z.array(smtpAccount),
  problems: z.array(z.object({ id: z.string(), to: z.string(), status: emailStatus, reason: z.string().optional(), at: z.string() })),
});
export type Dashboard = z.infer<typeof dashboard>;

export const suppressionList = z.object({
  items: z.array(z.object({ email: z.string(), reason: z.string(), createdAt: z.string() })),
});
export type Suppression = z.infer<typeof suppressionList>["items"][number];

export const meta = z.object({
  demo: z.boolean(),
  version: z.string(),
  demoSmtp: z.object({ host: z.string(), port: z.number() }).optional(),
});
export type Meta = z.infer<typeof meta>;

export const ok = z.object({ ok: z.boolean() });
