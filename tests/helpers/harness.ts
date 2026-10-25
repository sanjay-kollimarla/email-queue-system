import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { MongoClient } from "mongodb";

/** True when the local MongoDB + Redis (docker compose up -d mongo redis) are reachable. */
export async function infraUp(): Promise<boolean> {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const mongoUrl = process.env.MONGO_URL ?? "mongodb://localhost:27017/?directConnection=true";
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

export interface Harness {
  app: { request: (path: string, init?: RequestInit) => Promise<Response> | Response };
  db: typeof import("../../src/db/mongo.ts");
  call: (
    path: string,
    opts?: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> },
  ) => Promise<{ status: number; json: Record<string, any>; res: Response }>;
  newUser: () => Promise<{ email: string; userId: import("mongodb").ObjectId; accessToken: string; refreshToken: string }>;
  cleanup: () => Promise<void>;
}

/** Real Hono app + real services + real MongoDB/Redis, with per-test-run user cleanup. */
export async function startHarness(): Promise<Harness> {
  const db = await import("../../src/db/mongo.ts");
  const { buildApi } = await import("../../src/container.ts");
  const { createApp } = await import("../../src/api/server.ts");
  await db.connectMongo();
  const app = createApp(buildApi());
  const created: string[] = [];

  const call: Harness["call"] = async (path, opts = {}) => {
    const res = await app.request(path, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...opts.headers,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return {
      status: res.status,
      json: (await res
        .clone()
        .json()
        .catch(() => ({}))) as Record<string, any>,
      res,
    };
  };

  return {
    app,
    db,
    call,
    async newUser() {
      const email = `h-${randomUUID().slice(0, 8)}@itest.local`;
      created.push(email);
      const r = await call("/v1/auth/register", { body: { email, password: "correct-horse-battery" } });
      if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.json)}`);
      const user = await db.col.users().findOne({ email });
      return { email, userId: user!._id, accessToken: r.json.accessToken, refreshToken: r.json.refreshToken };
    },
    async cleanup() {
      const users = await db.col
        .users()
        .find({ email: { $in: created } })
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
      ]);
    },
  };
}
