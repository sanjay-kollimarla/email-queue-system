import type { ObjectId } from "mongodb";
import type { TemplateStore } from "../../core/ports.ts";
import { col, type TemplateDoc } from "../../db/mongo.ts";

/** Templates are immutable (content-addressed by hash), so a plain bounded cache is always correct. */
export class MongoTemplateStore implements TemplateStore {
  private cache = new Map<string, TemplateDoc>();
  constructor(private readonly maxEntries = 2000) {}

  async find(id: ObjectId): Promise<TemplateDoc | null> {
    const key = String(id);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const doc = await col.templates().findOne({ _id: id });
    if (doc) {
      if (this.cache.size >= this.maxEntries) this.cache.clear();
      this.cache.set(key, doc);
    }
    return doc;
  }
}
