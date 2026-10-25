import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

/**
 * AES-256-GCM with a versioned key ring, so the encryption key can be rotated without downtime:
 *
 *   ciphertext = "v2." + keyId + "." + base64(iv[12] | tag[16] | data)
 *
 *   - new data is always written with the ACTIVE key
 *   - decryption looks the key up by the id stored in the ciphertext, so old rows keep working
 *   - `bun run rotate-keys` re-encrypts every stored secret with the active key; once it reports 0
 *     remaining, the old key can be removed from ENCRYPTION_OLD_KEYS
 *   - unprefixed ciphertext (written before versioning) is tried against every key
 */
export class Keyring {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly activeId: string,
    activeKeyHex: string,
    oldKeys: string | undefined,
  ) {
    this.keys.set(activeId, Keyring.parseKey(activeKeyHex));
    for (const entry of (oldKeys ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [id, hex] = entry.split(":");
      if (!id || !hex) throw new Error(`bad ENCRYPTION_OLD_KEYS entry (expected id:hex)`);
      this.keys.set(id, Keyring.parseKey(hex));
    }
  }

  private static parseKey(hex: string): Buffer {
    const buf = Buffer.from(hex, "hex");
    if (buf.length !== 32) throw new Error("encryption keys must be 32 bytes (64 hex chars)");
    return buf;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.activeId)!, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `v2.${this.activeId}.${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64")}`;
  }

  decrypt(payload: string): string {
    const m = /^v2\.([A-Za-z0-9_-]+)\.(.+)$/.exec(payload);
    if (m) {
      const key = this.keys.get(m[1]!);
      if (!key) throw new Error(`unknown encryption key id "${m[1]}"`);
      return Keyring.open(m[2]!, key);
    }
    for (const key of this.keys.values()) {
      try {
        return Keyring.open(payload, key); // legacy, unversioned
      } catch {
        /* try the next key */
      }
    }
    throw new Error("cannot decrypt: no matching key");
  }

  /** True when the ciphertext is not under the active key (candidate for re-encryption). */
  needsRotation(payload: string): boolean {
    return !payload.startsWith(`v2.${this.activeId}.`);
  }

  private static open(b64: string, key: Buffer): string {
    const buf = Buffer.from(b64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  }
}

const keyring = new Keyring(config.ENCRYPTION_KEY_ID, config.ENCRYPTION_KEY, config.ENCRYPTION_OLD_KEYS);
export const encrypt = (plain: string) => keyring.encrypt(plain);
export const decrypt = (payload: string) => keyring.decrypt(payload);
export const needsRotation = (payload: string) => keyring.needsRotation(payload);

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const sha256Bytes = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/**
 * Signed capability tokens (unsubscribe links, webhook URLs): `payload.signature`, HMAC-SHA256.
 * They live inside emails that have ALREADY been sent, so their key must be rotatable independently of the
 * encryption key and old keys must keep verifying (an unsubscribe link has to work for years):
 *   LINK_SIGNING_KEY       signs new tokens
 *   LINK_SIGNING_OLD_KEYS  comma-separated, verify-only
 * If LINK_SIGNING_KEY is unset a key is derived from ENCRYPTION_KEY (fine for development).
 */
export class LinkSigner {
  private readonly keys: Buffer[];

  constructor(activeSecret: string, oldSecrets: string[] = []) {
    this.keys = [activeSecret, ...oldSecrets].map((s) => createHmac("sha256", s).update("capability-tokens-v2").digest());
  }

  sign(payload: string): string {
    const body = Buffer.from(payload).toString("base64url");
    return `${body}.${createHmac("sha256", this.keys[0]!).update(body).digest("base64url")}`;
  }

  verify(token: string): string | null {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const given = Buffer.from(sig, "base64url");
    for (const key of this.keys) {
      const expected = createHmac("sha256", key).update(body).digest();
      if (given.length === expected.length && timingSafeEqual(given, expected)) return Buffer.from(body, "base64url").toString();
    }
    return null;
  }
}

const linkSigner = new LinkSigner(
  config.LINK_SIGNING_KEY ?? `derived:${config.ENCRYPTION_KEY}`,
  (config.LINK_SIGNING_OLD_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
export const signToken = (payload: string) => linkSigner.sign(payload);
export const verifyToken = (token: string) => linkSigner.verify(token);
