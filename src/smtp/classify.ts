/**
 * Maps an SMTP / nodemailer error to what the pipeline should DO about it.
 *  - throttle  : provider says "slow down"  -> AIMD multiplicative decrease + pause, retry (no attempt consumed)
 *  - quota     : daily quota hit            -> pause the whole SMTP account, retry later (no attempt consumed)
 *  - auth      : credentials rejected       -> pause + flag the account, retry later (no attempt consumed)
 *  - transient : network / 4xx / unknown    -> BullMQ exponential-backoff retry (consumes an attempt)
 *  - permanent : 5xx / bad recipient        -> fail immediately, never retry (maybe suppress recipient)
 */
export type SendOutcome =
  | { kind: "throttle"; reason: string; retryAfterMs?: number }
  | { kind: "quota"; reason: string; retryAfterMs?: number }
  | { kind: "auth"; reason: string }
  | { kind: "transient"; reason: string }
  | { kind: "permanent"; reason: string; suppress: boolean };

const QUOTA_RE =
  /(daily|per[- ]?day|24[- ]hour)[^.]*(quota|limit|maximum)|(quota|limit)[^.]*(daily|per[- ]?day)|sending (quota|limit)|quota exceeded|\b5\.4\.5\b/i;
const THROTTLE_RE = /rate|throttl|too many|too fast|slow down|exceed|limit|try again later|temporarily deferred|\b4\.7\.\d+\b/i;
const NETWORK_CODES = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "ECONNREFUSED", "EDNS", "ENOTFOUND", "EPIPE", "ETLS"]);
const BAD_RECIPIENT_RE =
  /user unknown|no such user|unknown user|mailbox (not found|unavailable|does not exist)|does not exist|invalid (recipient|mailbox)|recipient (address )?rejected|address rejected/i;

export function parseRetryAfterMs(text: string): number | undefined {
  const m = text.match(/retry(?:ing)?[ -]?(?:after|in)\s*(\d+)\s*(s|sec|secs|seconds|m|min|mins|minutes)?/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  return n * (unit.startsWith("m") ? 60_000 : 1000);
}

export function classifySmtpError(err: unknown): SendOutcome {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
  const code = typeof e?.responseCode === "number" ? e.responseCode : undefined;
  const text = String(e?.response ?? e?.message ?? "unknown error");
  const reason = code ? `${code} ${text}`.slice(0, 500) : text.slice(0, 500);
  const enhanced = text.match(/\b([245])\.(\d{1,3})\.(\d{1,3})\b/);
  const retryAfterMs = parseRetryAfterMs(text);

  if (e?.code === "EAUTH" || code === 530 || code === 534 || code === 535) {
    return { kind: "auth", reason };
  }
  if ((code === undefined || code >= 400) && QUOTA_RE.test(text)) {
    return { kind: "quota", reason, retryAfterMs };
  }
  if (e?.code && NETWORK_CODES.has(e.code)) {
    return { kind: "transient", reason };
  }
  if (e?.code === "EENVELOPE") {
    return { kind: "permanent", reason, suppress: false };
  }
  if (code !== undefined && code >= 400 && code < 500) {
    if (code === 421 || (enhanced?.[1] === "4" && enhanced?.[2] === "7") || THROTTLE_RE.test(text)) {
      return { kind: "throttle", reason, retryAfterMs };
    }
    return { kind: "transient", reason };
  }
  if (code !== undefined && code >= 500) {
    const badRecipient = (enhanced?.[1] === "5" && enhanced?.[2] === "1") || BAD_RECIPIENT_RE.test(text);
    return { kind: "permanent", reason, suppress: badRecipient };
  }
  return { kind: "transient", reason };
}
