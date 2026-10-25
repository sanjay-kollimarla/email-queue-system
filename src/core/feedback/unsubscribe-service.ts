import type { ObjectId } from "mongodb";
import { ObjectId as Oid } from "mongodb";
import { NotFoundError } from "../errors.ts";
import type { CapabilityTokens, SuppressionRepository } from "../api/ports.ts";
import type { EmailDoc } from "../../db/mongo.ts";
import type { ListHeaders } from "../ports.ts";

/**
 * One-click unsubscribe (RFC 8058). Bulk mail carries
 *   List-Unsubscribe: <https://host/u/TOKEN>
 *   List-Unsubscribe-Post: List-Unsubscribe=One-Click
 * which Gmail/Yahoo require from bulk senders. TOKEN is an HMAC-signed (userId, recipient) pair, so a
 * link cannot be forged to unsubscribe someone else. Transactional mail (password resets, receipts) is
 * deliberately left without it.
 */
export class UnsubscribeService implements ListHeaders {
  constructor(
    private readonly tokens: CapabilityTokens,
    private readonly suppressions: SuppressionRepository,
    private readonly publicBaseUrl: string | undefined,
  ) {}

  linkFor(userId: ObjectId, email: string): string | undefined {
    if (!this.publicBaseUrl) return undefined;
    return `${this.publicBaseUrl.replace(/\/$/, "")}/u/${this.tokens.sign(`u|${userId}|${email.toLowerCase()}`)}`;
  }

  forEmail(email: EmailDoc): Record<string, string> {
    if (email.priority !== "bulk") return {};
    const link = this.linkFor(email.userId, email.to);
    return link ? { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {};
  }

  /** Resolve a token without side effects (the confirmation page uses this so link scanners cannot unsubscribe anyone). */
  inspect(token: string): { userId: ObjectId; email: string } {
    const payload = this.tokens.verify(token);
    const m = payload && /^u\|([0-9a-f]{24})\|(.+)$/.exec(payload);
    if (!m) throw new NotFoundError("invalid or expired unsubscribe link");
    return { userId: new Oid(m[1]!), email: m[2]! };
  }

  async unsubscribe(token: string): Promise<string> {
    const { userId, email } = this.inspect(token);
    await this.suppressions.add(userId, email, "unsubscribed");
    return email;
  }
}

/** Webhook URLs are secrets: the path carries a signature over the SMTP account id. */
export class WebhookAccess {
  constructor(
    private readonly tokens: CapabilityTokens,
    private readonly publicBaseUrl: string | undefined,
  ) {}

  urlFor(smtpId: ObjectId): string | undefined {
    if (!this.publicBaseUrl) return undefined;
    return `${this.publicBaseUrl.replace(/\/$/, "")}/v1/webhooks/${smtpId}/${this.tokens.sign(`wh|${smtpId}`)}`;
  }

  verify(smtpId: ObjectId, token: string): boolean {
    return this.tokens.verify(token) === `wh|${smtpId}`;
  }
}
