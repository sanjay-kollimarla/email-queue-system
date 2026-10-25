import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { byUser, errorHandler, rateLimit } from "../src/api/middleware.ts";
import type { AttemptThrottle } from "../src/core/api/ports.ts";

const memoryThrottle = (): AttemptThrottle & { counts: Map<string, number> } => {
  const counts = new Map<string, number>();
  return { counts, hit: async (key) => counts.set(key, (counts.get(key) ?? 0) + 1).get(key)! };
};

describe("rateLimit middleware", () => {
  test("allows up to the limit, then 429 with Retry-After", async () => {
    const t = memoryThrottle();
    const app = new Hono();
    app.use(rateLimit(t, { name: "x", limit: 3, windowSec: 60 }));
    app.get("/", (c) => c.text("ok"));
    app.onError(errorHandler);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await app.request("/")).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const limited = await app.request("/");
    expect(limited.headers.get("retry-after")).toBe("60");
  });

  test("limits are per key: one user cannot exhaust another's budget", async () => {
    const t = memoryThrottle();
    const app = new Hono<{ Variables: { userId: string } }>();
    app.use(async (c, next) => {
      c.set("userId", c.req.header("x-user") ?? "anon");
      await next();
    });
    app.use(rateLimit(t, { name: "send", limit: 1, windowSec: 60, keyOf: byUser }));
    app.get("/", (c) => c.text("ok"));
    app.onError(errorHandler);
    const as = async (u: string) => (await app.request("/", { headers: { "x-user": u } })).status;
    expect(await as("alice")).toBe(200);
    expect(await as("alice")).toBe(429);
    expect(await as("bob")).toBe(200);
  });
});
