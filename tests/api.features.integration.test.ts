import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { MongoClient } from "mongodb";

/** Integration tests for attachments, password change, audit log, unsubscribe and bounce webhooks. */
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const mongoUrl = process.env.MONGO_URL ?? "mongodb://localhost:27017/?directConnection=true";

async function infraUp() {
  const r = new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
  r.on("error", () => {});
  const m = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 1500 });
  try {
    await r.connect();
    await m.connect();
    return true;
  } catch {
    return false;
  } finally {
    r.disconnect();
    await m.close().catch(() => {});
  }
}
const up = await infraUp();
if (!up) console.warn("[api feature tests] MongoDB/Redis not reachable, skipping");

describe.skipIf(!up)("HTTP API features (integration)", () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response };
  const createdEmails: string[] = [];
  let teardown: () => Promise<void>;
  let db: typeof import("../src/db/mongo.ts");
  let tokens: import("../src/infra/security/adapters.ts").HmacCapabilityTokens;

  beforeAll(async () => {
    db = await import("../src/db/mongo.ts");
    const { buildApi } = await import("../src/container.ts");
    const { createApp } = await import("../src/api/server.ts");
    const { HmacCapabilityTokens } = await import("../src/infra/security/adapters.ts");
    tokens = new HmacCapabilityTokens();
    await db.connectMongo();
    app = createApp(buildApi());
    teardown = async () => {
      const users = await db.col
        .users()
        .find({ email: { $in: createdEmails } })
        .toArray();
      const ids = users.map((u) => u._id);
      await Promise.all([
        db.col.users().deleteMany({ _id: { $in: ids } }),
        db.col.refreshTokens().deleteMany({ userId: { $in: ids } }),
        db.col.smtpAccounts().deleteMany({ userId: { $in: ids } }),
        db.col.emails().deleteMany({ userId: { $in: ids } }),
        db.col.outbox().deleteMany({ userId: { $in: ids } }),
        db.col.templates().deleteMany({ userId: { $in: ids } }),
        db.col.suppressions().deleteMany({ userId: { $in: ids } }),
        db.col.auditLogs().deleteMany({ userId: { $in: ids } }),
        db.attachmentFiles().deleteMany({ "metadata.userId": { $in: ids } }),
      ]);
      // shared module-level connections are left open: other test files in this process use them too
    };
  });
  afterAll(async () => teardown?.());

  const call = async (path: string, opts: { method?: string; token?: string; body?: unknown } = {}) => {
    const res = await app.request(path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  const raw = async (path: string, init?: RequestInit) => app.request(path, init);

  async function newUser() {
    const email = `feat-${randomUUID().slice(0, 8)}@itest.local`;
    createdEmails.push(email);
    const r = await call("/v1/auth/register", { body: { email, password: "correct-horse-battery" } });
    expect(r.status).toBe(201);
    const user = await db.col.users().findOne({ email });
    return { email, userId: user!._id, ...r.json };
  }
  const smtpBody = () => ({
    name: "t",
    host: "localhost",
    port: 2525,
    username: "u",
    password: "pw",
    fromEmail: "f@itest.local",
    limits: { perSecond: 5 },
    skipVerify: true,
  });

  test("attachments: stored once in GridFS, shared by identical sends, readable back", async () => {
    const u = await newUser();
    await call("/v1/smtp", { token: u.accessToken, body: smtpBody() });
    const pdf = Buffer.from("%PDF-1.4 fake pdf bytes").toString("base64");
    const body = {
      to: "a@example.com",
      subject: "Invoice",
      text: "attached",
      attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", contentBase64: pdf }],
    };
    expect((await call("/v1/emails", { token: u.accessToken, body })).status).toBe(202);
    expect((await call("/v1/emails", { token: u.accessToken, body: { ...body, to: "b@example.com" } })).status).toBe(202);

    expect(await db.attachmentFiles().countDocuments({ "metadata.userId": u.userId })).toBe(1); // deduplicated by content hash
    expect(await db.col.templates().countDocuments({ userId: u.userId })).toBe(1); // same content -> same template
    const { MongoAttachmentStore } = await import("../src/infra/mongo/attachment-store.ts");
    const tpl = await db.col.templates().findOne({ userId: u.userId });
    const [file] = await new MongoAttachmentStore().load(tpl!.attachments!);
    expect(file!.filename).toBe("invoice.pdf");
    expect(file!.content.toString()).toBe("%PDF-1.4 fake pdf bytes");
  });

  test("attachment validation: path traversal, header injection, bad base64, too many, too large", async () => {
    const u = await newUser();
    await call("/v1/smtp", { token: u.accessToken, body: smtpBody() });
    const send = (attachments: unknown) =>
      call("/v1/emails", { token: u.accessToken, body: { to: "a@example.com", subject: "s", text: "t", attachments } });
    const ok = Buffer.from("x").toString("base64");
    expect((await send([{ filename: "../../etc/passwd", contentBase64: ok }])).status).toBe(422);
    expect((await send([{ filename: "a.txt\r\nBcc: x@y.co", contentBase64: ok }])).status).toBe(422);
    expect((await send([{ filename: "a.txt", contentBase64: "***not base64***" }])).status).toBe(422);
    expect((await send(Array.from({ length: 6 }, (_, i) => ({ filename: `f${i}.txt`, contentBase64: ok })))).status).toBe(422);
    const big = Buffer.alloc(8.5 * 1024 * 1024, 1).toString("base64"); // > 8 MB decoded, still under the 12 MB body limit
    expect((await send([{ filename: "big.bin", contentBase64: big }])).status).toBe(422);
    const huge = Buffer.alloc(10 * 1024 * 1024, 1).toString("base64"); // body limit kicks in first
    expect((await send([{ filename: "huge.bin", contentBase64: huge }])).status).toBe(413);
  });

  test("password change revokes every session; old password stops working", async () => {
    const u = await newUser();
    const changed = await call("/v1/auth/change-password", {
      token: u.accessToken,
      body: { currentPassword: "correct-horse-battery", newPassword: "another-long-password" },
    });
    expect(changed.status).toBe(200);
    expect((await call("/v1/auth/refresh", { body: { refreshToken: u.refreshToken } })).status).toBe(401);
    expect((await call("/v1/auth/login", { body: { email: u.email, password: "correct-horse-battery" } })).status).toBe(401);
    expect((await call("/v1/auth/login", { body: { email: u.email, password: "another-long-password" } })).status).toBe(200);
    const wrong = await call("/v1/auth/change-password", {
      token: changed.json.accessToken,
      body: { currentPassword: "wrong-wrong-wrong", newPassword: "yet-another-password" },
    });
    expect(wrong.status).toBe(401);
  });

  test("security events are written to the audit log", async () => {
    const u = await newUser();
    await call("/v1/auth/login", { body: { email: u.email, password: "wrong-password-123" } });
    await call("/v1/smtp", { token: u.accessToken, body: smtpBody() });
    await Bun.sleep(150); // audit writes are fire-and-forget
    const actions = (await db.col.auditLogs().find({ userId: u.userId }).toArray()).map((a) => a.action);
    expect(actions).toContain("auth.register");
    expect(actions).toContain("auth.login_failed");
    expect(actions).toContain("smtp.created");
  });

  test("unsubscribe: GET only confirms (no side effects), POST suppresses, forged links 404", async () => {
    const u = await newUser();
    const token = tokens.sign(`u|${u.userId}|reader@example.com`);

    const page = await raw(`/u/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("reader@example.com");
    expect(await db.col.suppressions().countDocuments({ userId: u.userId })).toBe(0);

    const oneClick = await raw(`/u/${token}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(oneClick.status).toBe(200);
    expect(await db.col.suppressions().countDocuments({ userId: u.userId, email: "reader@example.com" })).toBe(1);
    expect((await raw(`/u/${token.slice(0, -2)}xx`)).status).toBe(404);
  });

  test("bounce webhook: signed URL required; hard bounce suppresses and flips the email to bounced", async () => {
    const u = await newUser();
    const smtp = (await call("/v1/smtp", { token: u.accessToken, body: smtpBody() })).json;
    const accepted = (await call("/v1/emails", { token: u.accessToken, body: { to: "gone@example.com", subject: "s", text: "t" } })).json;
    await db.col.emails().updateOne({ _id: db.toObjectId(accepted.id)! }, { $set: { status: "sent" } }); // as if the worker delivered it

    const token = tokens.sign(`wh|${smtp.id}`);
    const post = (path: string, body: unknown) =>
      raw(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const payload = { events: [{ type: "bounce", email: "Gone@Example.com", reason: "550 5.1.1 unknown user" }] };

    expect((await post(`/v1/webhooks/${smtp.id}/forged-token`, payload)).status).toBe(404);
    const res = await post(`/v1/webhooks/${smtp.id}/${token}`, payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ suppressed: 1 });

    expect((await call(`/v1/emails/${accepted.id}`, { token: u.accessToken })).json.status).toBe("bounced");
    expect(await db.col.suppressions().countDocuments({ userId: u.userId, email: "gone@example.com" })).toBe(1);
    const again = await call("/v1/emails", { token: u.accessToken, body: { to: "gone@example.com", subject: "s2", text: "t" } });
    expect(again.json.status).toBe("suppressed"); // the next send to that recipient is never attempted
    expect((await post(`/v1/webhooks/${smtp.id}/${token}`, { hello: "world" })).status).toBe(422);
  });

  test("a webhook token for one account cannot post feedback for another account", async () => {
    const a = await newUser();
    const b = await newUser();
    const sa = (await call("/v1/smtp", { token: a.accessToken, body: smtpBody() })).json;
    const sb = (await call("/v1/smtp", { token: b.accessToken, body: smtpBody() })).json;
    const tokenA = tokens.sign(`wh|${sa.id}`);
    const res = await raw(`/v1/webhooks/${sb.id}/${tokenA}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(404);
  });
});
