/**
 * Asynchronous delivery feedback. A provider accepts a message (SMTP 250) and only LATER tells you it
 * bounced or that the recipient hit "report spam". Each provider posts its own JSON shape, so each gets a
 * parser (Strategy); everything downstream works on the normalized `FeedbackEvent`.
 */
export type FeedbackKind = "hard_bounce" | "soft_bounce" | "complaint";

export interface FeedbackEvent {
  kind: FeedbackKind;
  email: string;
  reason: string;
  /** our Message-ID when the provider echoes it (preferred match); otherwise we match by recipient */
  messageId?: string;
}

export interface FeedbackParser {
  readonly name: string;
  /** Cheap structural test: does this payload look like mine? */
  matches(body: unknown): boolean;
  parse(body: unknown): FeedbackEvent[];
}

// ---- tiny safe accessors: webhook payloads are untrusted JSON, never index them blindly ----
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((cur, key) => (isObj(cur) ? cur[key] : undefined), v);
const lower = (v: unknown) => String(v ?? "").toLowerCase();

/** Amazon SES -> SNS. The HTTP body is an SNS envelope whose `Message` is a JSON string. */
export class SesSnsParser implements FeedbackParser {
  readonly name = "ses-sns";
  matches(body: unknown) {
    return isObj(body) && body.Type === "Notification" && typeof body.Message === "string";
  }
  parse(body: unknown): FeedbackEvent[] {
    let msg: unknown;
    try {
      msg = JSON.parse(String(at(body, "Message")));
    } catch {
      return [];
    }
    const messageId = str(at(msg, "mail", "commonHeaders", "messageId")) ?? str(at(msg, "mail", "messageId"));
    const type = at(msg, "notificationType");

    if (type === "Bounce") {
      const permanent = at(msg, "bounce", "bounceType") === "Permanent";
      const subType = str(at(msg, "bounce", "bounceSubType")) ?? "bounce";
      return arr(at(msg, "bounce", "bouncedRecipients")).map((r) => ({
        kind: permanent ? ("hard_bounce" as const) : ("soft_bounce" as const),
        email: lower(at(r, "emailAddress")),
        reason: `${subType}: ${str(at(r, "diagnosticCode")) ?? str(at(r, "status")) ?? ""}`.trim(),
        messageId,
      }));
    }
    if (type === "Complaint") {
      const feedback = str(at(msg, "complaint", "complaintFeedbackType")) ?? "abuse";
      return arr(at(msg, "complaint", "complainedRecipients")).map((r) => ({
        kind: "complaint" as const,
        email: lower(at(r, "emailAddress")),
        reason: `complaint: ${feedback}`,
        messageId,
      }));
    }
    return [];
  }
}

/** SendGrid Event Webhook: a JSON array of events. */
export class SendGridParser implements FeedbackParser {
  readonly name = "sendgrid";
  matches(body: unknown) {
    return (
      Array.isArray(body) && body.length > 0 && body.every((e) => isObj(e) && typeof e.event === "string" && typeof e.email === "string")
    );
  }
  parse(body: unknown): FeedbackEvent[] {
    const out: FeedbackEvent[] = [];
    for (const e of arr(body)) {
      const event = at(e, "event");
      const email = lower(at(e, "email"));
      const reason = str(at(e, "reason")) ?? str(at(e, "response")) ?? String(event);
      if (event === "bounce") out.push({ kind: at(e, "type") === "blocked" ? "soft_bounce" : "hard_bounce", email, reason });
      else if (event === "dropped") out.push({ kind: "hard_bounce", email, reason: `dropped: ${reason}` });
      else if (event === "spamreport") out.push({ kind: "complaint", email, reason: "complaint: spamreport" });
    }
    return out;
  }
}

/** Mailgun webhook: `{ "event-data": { event, severity, recipient, ... } }`. */
export class MailgunParser implements FeedbackParser {
  readonly name = "mailgun";
  matches(body: unknown) {
    return typeof at(body, "event-data", "event") === "string";
  }
  parse(body: unknown): FeedbackEvent[] {
    const d = at(body, "event-data");
    const email = lower(at(d, "recipient"));
    if (!email) return [];
    const event = at(d, "event");
    const reason = str(at(d, "delivery-status", "message")) ?? str(at(d, "delivery-status", "description")) ?? String(event);
    const rawId = str(at(d, "message", "headers", "message-id"));
    if (event === "failed") {
      const kind = at(d, "severity") === "permanent" ? "hard_bounce" : "soft_bounce";
      return [{ kind, email, reason, messageId: rawId ? `<${rawId}>` : undefined }];
    }
    if (event === "complained") return [{ kind: "complaint", email, reason: "complaint: reported as spam" }];
    return [];
  }
}

/** Provider-neutral format for custom pipelines (e.g. a DSN mailbox processor). */
export class GenericParser implements FeedbackParser {
  readonly name = "generic";
  matches(body: unknown) {
    return Array.isArray(at(body, "events"));
  }
  parse(body: unknown): FeedbackEvent[] {
    const out: FeedbackEvent[] = [];
    for (const e of arr(at(body, "events"))) {
      const email = str(at(e, "email"));
      const type = at(e, "type");
      const kind = type === "bounce" ? "hard_bounce" : type === "soft_bounce" ? "soft_bounce" : type === "complaint" ? "complaint" : null;
      if (email && kind)
        out.push({ kind, email: email.toLowerCase(), reason: str(at(e, "reason")) ?? String(type), messageId: str(at(e, "messageId")) });
    }
    return out;
  }
}

export const DEFAULT_PARSERS: FeedbackParser[] = [new SesSnsParser(), new SendGridParser(), new MailgunParser(), new GenericParser()];

/** Amazon only: SNS asks the endpoint to GET a URL once to confirm the subscription. */
export function snsSubscribeUrl(body: unknown): string | null {
  if (at(body, "Type") !== "SubscriptionConfirmation") return null;
  const raw = str(at(body, "SubscribeURL"));
  if (!raw) return null;
  try {
    const u = new URL(raw);
    // SSRF guard: only ever fetch from AWS SNS itself
    return u.protocol === "https:" && /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}
