import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { MongoClient } from "mongodb";

/**
 * API integration tests: the real Hono app, real services and repositories, real MongoDB + Redis.
 * Skipped automatically when the infrastructure is not running (`docker compose up -d mongo redis`).
 */
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
if (!up) console.warn("[api tests] MongoDB/Redis not reachable, skipping");

describe.skipIf(!up)("HTTP API (integration)", () => {
  let app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response };
  const runId = randomUUID().slice(0, 8);
  const createdEmails: string[] = [];
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    const { connectMongo } = await import("../src/db/mongo.ts");
    const { buildApi } = await import("../src/container.ts");
    const { createApp } = await import("../src/api/server.ts");
    await connectMongo();
    app = createApp(buildApi());
    teardown = async () => {
      const { col } = await import("../src/db/mongo.ts");
      const users = await col
        .users()
        .find({ email: { $in: createdEmails } })
        .toArray();
      const ids = users.map((u) => u._id);
      await Promise.all([
        col.users().deleteMany({ _id: { $in: ids } }),
        col.refreshTokens().deleteMany({ userId: { $in: ids } }),
        col.smtpAccounts().deleteMany({ userId: { $in: ids } }),
        col.emails().deleteMany({ userId: { $in: ids } }),
        col.outbox().deleteMany({ userId: { $in: ids } }),
        col.templates().deleteMany({ userId: { $in: ids } }),
        col.suppressions().deleteMany({ userId: { $in: ids } }),
      ]);
      // shared module-level connections are left open: other test files in this process use them too
    };
  });
  afterAll(async () => teardown?.());

  const call = async (path: string, opts: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await app.request(path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any, res };
  };

  async function newUser() {
    const email = `user-${randomUUID().slice(0, 8)}@itest.local`;
    createdEmails.push(email);
    const r = await call("/v1/auth/register", { body: { email, password: "correct-horse-battery" } });
    expect(r.status).toBe(201);
    return { email, ...r.json };
  }

  const smtpBody = (over: Record<string, unknown> = {}) => ({
    name: "t",
    host: "localhost",
    port: 2525,
    username: "u",
    password: "secret-pass",
    fromEmail: "from@itest.local",
    limits: { perSecond: 5 },
    skipVerify: true,
    ...over,
  });

  test("register -> me; duplicate email conflicts; weak password rejected", async () => {
    const u = await newUser();
    expect((await call("/v1/auth/me", { token: u.accessToken })).json.email).toBe(u.email);
    expect((await call("/v1/auth/register", { body: { email: u.email, password: "correct-horse-battery" } })).status).toBe(409);
    expect((await call("/v1/auth/register", { body: { email: `x-${runId}@itest.local`, password: "short" } })).status).toBe(422);
  });

  test("login: wrong password and unknown user give the same 401", async () => {
    const u = await newUser();
    const wrong = await call("/v1/auth/login", { body: { email: u.email, password: "not-the-password-1" } });
    const unknown = await call("/v1/auth/login", { body: { email: `nobody-${runId}@itest.local`, password: "not-the-password-1" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json).toEqual(unknown.json);
  });

  test("refresh tokens rotate; reusing a rotated token revokes the whole family", async () => {
    const u = await newUser();
    const first = await call("/v1/auth/refresh", { body: { refreshToken: u.refreshToken } });
    expect(first.status).toBe(200);
    const reuse = await call("/v1/auth/refresh", { body: { refreshToken: u.refreshToken } }); // stolen token replayed
    expect(reuse.status).toBe(401);
    const afterRevoke = await call("/v1/auth/refresh", { body: { refreshToken: first.json.refreshToken } });
    expect(afterRevoke.status).toBe(401); // the legitimate child token died with the family
  });

  test("protected routes need a valid token", async () => {
    expect((await call("/v1/smtp")).status).toBe(401);
    expect((await call("/v1/smtp", { token: "garbage" })).status).toBe(401);
  });

  test("SMTP account: rate limit is mandatory, password never returned", async () => {
    const u = await newUser();
    const noRate = await call("/v1/smtp", { token: u.accessToken, body: smtpBody({ limits: {} }) });
    expect(noRate.status).toBe(422);
    const noRateGmail = await call("/v1/smtp", {
      token: u.accessToken,
      body: smtpBody({ host: "smtp.gmail.com", limits: { perDay: 400 } }),
    });
    expect(noRateGmail.status).toBe(422);

    const ok = await call("/v1/smtp", { token: u.accessToken, body: smtpBody({ limits: { perMinute: 30, perDay: 1000 } }) });
    expect(ok.status).toBe(201);
    expect(ok.json.rate.ceilingPerSec).toBe(0.5);
    expect(ok.json.rate.dailyCap).toBe(1000);
    expect(JSON.stringify(ok.json)).not.toContain("secret-pass");
    expect(ok.json.passwordEnc).toBeUndefined();
  });

  test("tenant isolation: another user cannot see, change or send through my SMTP account", async () => {
    const a = await newUser();
    const b = await newUser();
    const smtp = (await call("/v1/smtp", { token: a.accessToken, body: smtpBody() })).json;
    expect((await call(`/v1/smtp/${smtp.id}`, { token: b.accessToken })).status).toBe(404);
    expect((await call(`/v1/smtp/${smtp.id}`, { token: b.accessToken, method: "DELETE" })).status).toBe(404);
    expect(
      (await call("/v1/emails", { token: b.accessToken, body: { smtpId: smtp.id, to: "x@y.co", subject: "s", text: "t" } })).status,
    ).toBe(404);
    expect((await call("/v1/smtp", { token: b.accessToken })).json.items).toEqual([]);
  });

  test("send: accepted, idempotent replay returns the same email, tenant cannot read it", async () => {
    const a = await newUser();
    const b = await newUser();
    await call("/v1/smtp", { token: a.accessToken, body: smtpBody() });
    const body = { to: "bob@example.com", subject: "Hi {{n}}", text: "hello", vars: { n: "1" } };
    const first = await call("/v1/emails", { token: a.accessToken, body, headers: { "idempotency-key": "k-1" } });
    const second = await call("/v1/emails", { token: a.accessToken, body, headers: { "idempotency-key": "k-1" } });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ id: first.json.id, replayed: true });
    expect((await call(`/v1/emails/${first.json.id}`, { token: a.accessToken })).json.status).toBe("queued");
    expect((await call(`/v1/emails/${first.json.id}`, { token: b.accessToken })).status).toBe(404);
    expect((await call("/v1/stats", { token: a.accessToken })).json.counts.queued).toBe(1);
  });

  test("batch: counts, per-recipient idempotency on replay, suppression list honoured", async () => {
    const u = await newUser();
    await call("/v1/smtp", { token: u.accessToken, body: smtpBody() });
    await call("/v1/suppressions", { token: u.accessToken, body: { email: "Blocked@Example.com" } });
    const body = {
      subject: "News",
      text: "hi",
      recipients: [{ to: "a@example.com" }, { to: "blocked@example.com" }, { to: "c@example.com" }],
    };
    const first = await call("/v1/emails/batch", { token: u.accessToken, body, headers: { "idempotency-key": "batch-1" } });
    expect(first.status).toBe(202);
    expect(first.json).toMatchObject({ count: 3, queued: 2, suppressed: 1, replayed: 0 });
    const replay = await call("/v1/emails/batch", { token: u.accessToken, body, headers: { "idempotency-key": "batch-1" } });
    expect(replay.json).toMatchObject({ count: 3, queued: 0, replayed: 3 });
    expect((await call("/v1/stats", { token: u.accessToken })).json.total).toBe(3);
  });

  test("validation: header injection in addresses and oversize batches are rejected", async () => {
    const u = await newUser();
    await call("/v1/smtp", { token: u.accessToken, body: smtpBody() });
    const bad = await call("/v1/emails", { token: u.accessToken, body: { to: "a@b.co\r\nBcc: evil@x.com", subject: "s", text: "t" } });
    expect(bad.status).toBe(422);
    const big = await call("/v1/emails/batch", {
      token: u.accessToken,
      body: { subject: "s", text: "t", recipients: Array.from({ length: 1001 }, (_, i) => ({ to: `u${i}@example.com` })) },
    });
    expect(big.status).toBe(422);
  });

  test("an account with failed credentials refuses new sends", async () => {
    const u = await newUser();
    const smtp = (await call("/v1/smtp", { token: u.accessToken, body: smtpBody() })).json;
    const { col } = await import("../src/db/mongo.ts");
    const { toObjectId } = await import("../src/db/mongo.ts");
    await col.smtpAccounts().updateOne({ _id: toObjectId(smtp.id)! }, { $set: { health: "auth_failed", healthDetail: "535 bad login" } });
    const r = await call("/v1/emails", { token: u.accessToken, body: { to: "a@example.com", subject: "s", text: "t" } });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("auth_failed");
  });

  test("/metrics exposes Prometheus counters and queue gauges", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("# TYPE emailq_sent_total counter");
    expect(text).toContain('emailq_queue_jobs{lane="bulk",state="waiting"}');
    expect(text).toContain("emailq_queue_oldest_waiting_age_seconds");
  });

  test("health endpoints", async () => {
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);
  });
});
