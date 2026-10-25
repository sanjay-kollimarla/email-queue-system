import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Keyring, LinkSigner, decrypt, encrypt, signToken, verifyToken } from "../src/lib/crypto.ts";
import { renderTemplate } from "../src/lib/template.ts";

describe("crypto", () => {
  test("roundtrip, ciphertext hides plaintext, IV is random", () => {
    const a = encrypt("s3cret-smtp-password");
    expect(a).not.toContain("s3cret");
    expect(decrypt(a)).toBe("s3cret-smtp-password");
    expect(encrypt("s3cret-smtp-password")).not.toBe(a);
  });
  test("tampering is detected", () => {
    const buf = Buffer.from(encrypt("hello"), "base64");
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 1;
    expect(() => decrypt(buf.toString("base64"))).toThrow();
  });
  test("wrong key fails", () => {
    const other = new Keyring("kx", randomBytes(32).toString("hex"), undefined);
    expect(() => other.decrypt(encrypt("hello"))).toThrow();
  });
  test("key rotation: old ciphertext still decrypts, new writes use the active key", () => {
    const oldHex = randomBytes(32).toString("hex");
    const newHex = randomBytes(32).toString("hex");
    const before = new Keyring("k1", oldHex, undefined);
    const stored = before.encrypt("smtp-password");
    const after = new Keyring("k2", newHex, `k1:${oldHex}`);
    expect(after.decrypt(stored)).toBe("smtp-password");
    expect(after.needsRotation(stored)).toBe(true);
    const rotated = after.encrypt(after.decrypt(stored));
    expect(rotated.startsWith("v2.k2.")).toBe(true);
    expect(after.needsRotation(rotated)).toBe(false);
    expect(() => new Keyring("k2", newHex, undefined).decrypt(stored)).toThrow(); // old key removed -> unreadable
  });
  test("unversioned legacy ciphertext is still readable", async () => {
    const { createCipheriv } = await import("node:crypto");
    const hex = randomBytes(32).toString("hex");
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv);
    const data = Buffer.concat([c.update("legacy", "utf8"), c.final()]);
    const legacy = Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
    expect(new Keyring("k1", hex, undefined).decrypt(legacy)).toBe("legacy");
  });
  test("signed capability tokens: roundtrip, tamper and forgery rejected", () => {
    const t = signToken("user:42|a@b.co");
    expect(verifyToken(t)).toBe("user:42|a@b.co");
    expect(verifyToken(t.replace(/.$/, (ch) => (ch === "A" ? "B" : "A")))).toBeNull();
    expect(verifyToken("garbage")).toBeNull();
    expect(verifyToken(signToken("x").split(".")[0] + ".AAAA")).toBeNull();
  });
});

describe("LinkSigner", () => {
  test("rotating the signing key keeps links in already-sent emails valid", () => {
    const before = new LinkSigner("old-secret-old-secret-old-secret-123");
    const linkInOldEmail = before.sign("u|42|a@b.co");
    const after = new LinkSigner("new-secret-new-secret-new-secret-123", ["old-secret-old-secret-old-secret-123"]);
    expect(after.verify(linkInOldEmail)).toBe("u|42|a@b.co"); // old link still works
    expect(before.verify(after.sign("x"))).toBeNull(); // new links are not accepted by the old key alone
    expect(new LinkSigner("new-secret-new-secret-new-secret-123").verify(linkInOldEmail)).toBeNull(); // once the old key is dropped
  });
});

describe("template", () => {
  test("substitutes and html-escapes the html part only", () => {
    const out = renderTemplate({ subject: "Hi {{name}}", text: "Hi {{name}}", html: "<p>Hi {{name}}</p>" }, { name: "<b>Bob</b>" });
    expect(out.text).toBe("Hi <b>Bob</b>");
    expect(out.html).toBe("<p>Hi &lt;b&gt;Bob&lt;/b&gt;</p>");
  });
  test("subject cannot inject headers", () => {
    const out = renderTemplate({ subject: "Hi {{name}}" }, { name: "Bob\r\nBcc: evil@x.com" });
    expect(out.subject).not.toMatch(/[\r\n]/);
  });
  test("missing vars become empty", () => {
    expect(renderTemplate({ subject: "x{{nope}}y" }).subject).toBe("xy");
  });
});
