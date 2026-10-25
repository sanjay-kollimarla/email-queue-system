import { ObjectId } from "mongodb";
import type { SmtpDirectory } from "../../core/ports.ts";
import { col, type SmtpAccountDoc } from "../../db/mongo.ts";

/**
 * Read-through cache over the smtpAccounts collection. The hot path needs the account for every
 * email and 3,000 mails/s must not mean 3,000 reads/s of the same few documents. Edits become
 * visible within `ttlMs`.
 */
export class MongoSmtpDirectory implements SmtpDirectory {
  private cache = new Map<string, { doc: SmtpAccountDoc | null; at: number }>();
  private inflight = new Map<string, Promise<SmtpAccountDoc | null>>();
  private lastPersisted = new Map<string, { at: number; rate: number }>();

  constructor(private readonly ttlMs = 10_000) {}

  find(id: string | ObjectId): Promise<SmtpAccountDoc | null> {
    const key = String(id);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return Promise.resolve(hit.doc);

    let p = this.inflight.get(key); // collapse concurrent misses into one query
    if (!p) {
      p = col
        .smtpAccounts()
        .findOne({ _id: new ObjectId(key) })
        .then((doc) => {
          this.cache.set(key, { doc, at: Date.now() });
          return doc;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  async flagAuthFailed(smtp: SmtpAccountDoc, detail: string): Promise<void> {
    await col.smtpAccounts().updateOne({ _id: smtp._id }, { $set: { health: "auth_failed", healthDetail: detail.slice(0, 300) } });
    this.cache.delete(String(smtp._id));
  }

  saveLearnedRate(smtp: SmtpAccountDoc, rate: number): void {
    const id = String(smtp._id);
    const prev = this.lastPersisted.get(id);
    const unchanged = prev && Date.now() - prev.at < 30_000 && Math.abs(prev.rate - rate) / Math.max(prev.rate, 0.01) < 0.1;
    if (unchanged) return;
    this.lastPersisted.set(id, { at: Date.now(), rate });
    col
      .smtpAccounts()
      .updateOne({ _id: smtp._id }, { $set: { learnedRate: rate } })
      .catch(() => {});
  }
}
