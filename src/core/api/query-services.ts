import type { ObjectId } from "mongodb";
import type { EmailDoc, EmailStatus } from "../../db/mongo.ts";
import { NotFoundError } from "../errors.ts";
import type { EmailQueryRepository, SuppressionRepository } from "./ports.ts";

export class EmailQueryService {
  constructor(private readonly emails: EmailQueryRepository) {}

  async get(userId: ObjectId, id: ObjectId): Promise<EmailDoc> {
    const email = await this.emails.find(userId, id);
    if (!email) throw new NotFoundError("email not found");
    return email;
  }

  async list(userId: ObjectId, filter: { status?: EmailStatus; before?: ObjectId; limit: number }) {
    const items = await this.emails.list(userId, filter);
    return { items, nextCursor: items.length === filter.limit ? items.at(-1)!._id : null };
  }

  /**
   * Exact per-status counts from MongoDB (indexed on userId+status). Fine up to millions of rows per
   * tenant; beyond that switch to counters maintained by the status writer.
   */
  async stats(userId: ObjectId, smtpId?: ObjectId) {
    const counts = await this.emails.countByStatus(userId, smtpId);
    return { counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }
}

export class SuppressionService {
  constructor(private readonly repo: SuppressionRepository) {}
  list(userId: ObjectId) {
    return this.repo.list(userId, 200);
  }
  add(userId: ObjectId, email: string, reason: string) {
    return this.repo.add(userId, email, reason);
  }
  async remove(userId: ObjectId, email: string): Promise<void> {
    if (!(await this.repo.remove(userId, email))) throw new NotFoundError("not suppressed");
  }
}
