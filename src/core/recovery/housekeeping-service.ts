import type { AttachmentStore } from "../ports.ts";

/**
 * Periodic cleanup of data nothing references any more. Attachment bytes are content-addressed and
 * shared, so they cannot be deleted with an email; instead each use refreshes `lastUsedAt` and files
 * unused for longer than the email retention window (plus a safety margin) are removed.
 */
export class HousekeepingService {
  constructor(
    private readonly attachments: AttachmentStore,
    private readonly retentionDays: number,
    private readonly safetyMarginDays = 7,
  ) {}

  async purgeAttachments(now = Date.now()): Promise<number> {
    const cutoff = new Date(now - (this.retentionDays + this.safetyMarginDays) * 86_400_000);
    return this.attachments.purgeUnusedSince(cutoff);
  }
}
