import type { SmtpLimits } from "../db/mongo.ts";

/**
 * SMTP has no protocol-level way to ask "what is my rate limit?", so the USER declares it. These
 * presets exist only to show a hint when they do. Figures checked against the providers' documentation:
 *   Microsoft 365 / Exchange Online  learn.microsoft.com (smtp-submission-improvements, outbound-spam-sending-limits)
 *   Google Workspace                 knowledge.workspace.google.com (Gmail sending limits)
 *   Amazon SES                       docs.aws.amazon.com/ses (service quotas, sending quotas)
 * Daily limits at all three are a ROLLING 24-hour window and count recipients (we send 1 per email).
 * Providers marked "plan dependent" have no single figure: use your own plan's numbers.
 */
interface Preset {
  provider: string;
  match: RegExp;
  limits: SmtpLimits;
  maxConnections?: number;
  note: string;
}

const PRESETS: Preset[] = [
  {
    provider: "gmail",
    match: /(^|.)smtp.gmail.com$/i,
    limits: { perDay: 500 },
    note: "Google Workspace: 2,000 messages/day per user (1,500 for mail merge, 500 trial), rolling 24h. Free Gmail is commonly reported as ~500/day (not published by Google). Google may throttle below these; declare what your account really gets.",
  },
  {
    provider: "gmail-relay",
    match: /(^|.)smtp-relay.gmail.com$/i,
    limits: { perDay: 10000 },
    note: "Workspace SMTP relay: reported up to 10,000 recipients/day per user; intended for known IP ranges",
  },
  {
    provider: "microsoft365",
    match: /(^|.)smtp.office365.com$|(^|.)smtp-mail.outlook.com$/i,
    limits: { perMinute: 30, perDay: 10000 },
    maxConnections: 3,
    note: "SMTP AUTH: 30 messages/minute and 10,000 recipients/day (rolling 24h) per mailbox, at most 3 concurrent connections (more get 432). Hard limits, not raisable.",
  },
  {
    provider: "ses",
    match: /^email-smtp.[a-z0-9-]+.amazonaws.com$/i,
    limits: { perSecond: 1, perDay: 200 },
    note: "SES sandbox: 200 emails per rolling 24h and 1/second. After production access use the quota shown in your SES console (per region).",
  },
  { provider: "sendgrid", match: /(^|.)smtp.sendgrid.net$/i, limits: {}, note: "Plan dependent: see your SendGrid plan" },
  { provider: "mailgun", match: /(^|.)smtp.(eu.)?mailgun.org$/i, limits: {}, note: "Plan dependent: see your Mailgun plan" },
  {
    provider: "brevo",
    match: /(^|.)smtp-relay.(brevo|sendinblue).com$/i,
    limits: {},
    note: "Plan dependent: free plan has a daily cap, see your Brevo plan",
  },
  { provider: "postmark", match: /(^|.)smtp.postmarkapp.com$/i, limits: {}, note: "Plan dependent: see your Postmark plan" },
  { provider: "zoho", match: /(^|.)smtp.zoho.[a-z.]+$/i, limits: {}, note: "Plan dependent: see your Zoho plan" },
  { provider: "yahoo", match: /(^|.)smtp.mail.yahoo.com$/i, limits: {}, note: "Consumer limits are not published; declare conservatively" },
];

export function detectProvider(host: string): Preset | null {
  return PRESETS.find((p) => p.match.test(host.trim())) ?? null;
}

export interface ResolvedRate {
  provider: string;
  ceilingPerSec: number;
  dailyCap?: number;
  /** what this provider usually allows: shown to the user as a hint, never applied */
  hint?: { limits: SmtpLimits; maxConnections?: number; note: string };
}

export class MissingRateError extends Error {
  constructor(host: string, hint?: string) {
    super(
      `limits.perSecond or limits.perMinute is required (the rate your SMTP account "${host}" allows)` +
        (hint ? `. Typical for this provider: ${hint}` : ""),
    );
  }
}

/**
 * The USER declares the rate; we never guess it. The declared rate is the hard ceiling the adaptive
 * controller may not exceed (it can still slow down below it if the provider throttles).
 * Provider presets are only returned as a hint to help the user pick a number.
 */
export function resolveRate(host: string, declared: SmtpLimits = {}): ResolvedRate {
  const preset = detectProvider(host);
  if (declared.perSecond === undefined && declared.perMinute === undefined) {
    throw new MissingRateError(host, preset ? `${JSON.stringify(preset.limits)} (${preset.note})` : undefined);
  }
  const ceilingPerSec = Math.min(declared.perSecond ?? Infinity, declared.perMinute !== undefined ? declared.perMinute / 60 : Infinity);
  return {
    provider: preset?.provider ?? "custom",
    ceilingPerSec,
    dailyCap: declared.perDay,
    hint: preset ? { limits: preset.limits, maxConnections: preset.maxConnections, note: preset.note } : undefined,
  };
}
