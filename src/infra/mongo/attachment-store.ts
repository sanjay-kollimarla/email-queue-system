import type { ObjectId } from "mongodb";
import type { AttachmentStore, MailAttachment } from "../../core/ports.ts";
import { attachmentFiles, bucket, type AttachmentRef } from "../../db/mongo.ts";
import { sha256Bytes } from "../../lib/crypto.ts";

/**
 * Attachment bytes in GridFS, content-addressed per user: a 5 MB PDF sent to 1M recipients is stored
 * once, and every email only carries a reference through its (also shared) template. Reads go through
 * a small size-bounded LRU because one campaign reads the same file for every recipient.
 */
export class MongoAttachmentStore implements AttachmentStore {
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;

  constructor(private readonly maxCacheBytes = 64 * 1024 * 1024) {}

  async put(userId: ObjectId, file: MailAttachment): Promise<AttachmentRef> {
    const sha256 = sha256Bytes(file.content);
    const ref = (fileId: ObjectId): AttachmentRef => ({
      fileId,
      filename: file.filename,
      contentType: file.contentType,
      size: file.content.length,
      sha256,
    });

    const existing = await attachmentFiles().findOneAndUpdate(
      { "metadata.userId": userId, "metadata.sha256": sha256 },
      { $set: { "metadata.lastUsedAt": new Date() } },
    );
    if (existing) return ref(existing._id);

    const stream = bucket().openUploadStream(sha256, { metadata: { userId, sha256, lastUsedAt: new Date() } });
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject).once("finish", () => resolve());
      stream.end(file.content);
    });
    return ref(stream.id as ObjectId);
  }

  async load(refs: AttachmentRef[]): Promise<MailAttachment[]> {
    return Promise.all(refs.map(async (r) => ({ filename: r.filename, contentType: r.contentType, content: await this.read(r.fileId) })));
  }

  private async read(fileId: ObjectId): Promise<Buffer> {
    const key = String(fileId);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh recency
      this.cache.set(key, hit);
      return hit;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of bucket().openDownloadStream(fileId)) chunks.push(chunk as Buffer);
    const content = Buffer.concat(chunks);
    this.remember(key, content);
    return content;
  }

  private remember(key: string, content: Buffer) {
    if (content.length > this.maxCacheBytes) return;
    this.cache.set(key, content);
    this.cacheBytes += content.length;
    for (const [k, v] of this.cache) {
      if (this.cacheBytes <= this.maxCacheBytes) break;
      this.cache.delete(k);
      this.cacheBytes -= v.length;
    }
  }

  async purgeUnusedSince(cutoff: Date): Promise<number> {
    let removed = 0;
    for await (const f of attachmentFiles().find({ "metadata.lastUsedAt": { $lt: cutoff } }, { projection: { _id: 1 } })) {
      await bucket()
        .delete(f._id)
        .catch(() => {});
      removed++;
    }
    return removed;
  }
}
