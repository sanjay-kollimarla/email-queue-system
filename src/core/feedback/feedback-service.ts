import type { ObjectId } from "mongodb";
import type { Logger } from "../ports.ts";
import { ValidationError } from "../errors.ts";
import { DEFAULT_PARSERS, type FeedbackEvent, type FeedbackParser } from "./parsers.ts";

export interface FeedbackStore {
  /**
   * Mark the matching SENT email as bounced/complained. Matches our Message-ID when the provider
   * echoed it, otherwise the most recent email sent to that recipient through this account.
   * Returns whether an email was updated.
   */
  applyToEmail(userId: ObjectId, smtpId: ObjectId, event: FeedbackEvent): Promise<boolean>;
  suppress(userId: ObjectId, email: string, reason: string): Promise<void>;
}

export interface FeedbackResult {
  parser: string;
  events: number;
  suppressed: number;
  ignored: number;
}

/**
 * Hard bounces and spam complaints permanently suppress the recipient for that tenant: continuing to
 * mail them is what destroys sender reputation. Soft (temporary) bounces are only counted.
 */
export class FeedbackService {
  constructor(
    private readonly store: FeedbackStore,
    private readonly log: Logger,
    private readonly parsers: FeedbackParser[] = DEFAULT_PARSERS,
  ) {}

  async handle(userId: ObjectId, smtpId: ObjectId, body: unknown): Promise<FeedbackResult> {
    const parser = this.parsers.find((p) => p.matches(body));
    if (!parser) throw new ValidationError("unrecognized webhook payload");

    const events = parser.parse(body);
    let suppressed = 0;
    for (const e of events) {
      if (e.kind === "soft_bounce" || !e.email) continue;
      await this.store.suppress(userId, e.email, e.reason.slice(0, 200));
      await this.store.applyToEmail(userId, smtpId, e);
      suppressed++;
    }
    this.log.info("delivery feedback", { parser: parser.name, events: events.length, suppressed });
    return { parser: parser.name, events: events.length, suppressed, ignored: events.length - suppressed };
  }
}
