import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { requestLogger } from "../src/api/middleware.ts";

const harness = () => {
  const lines: Array<Record<string, unknown>> = [];
  const log = { info: (_m: string, f?: Record<string, unknown>) => void lines.push(f ?? {}), error() {} };
  const app = new Hono();
  app.use(requestLogger(log));
  app.get("/u/:token", (c) => c.text("ok"));
  app.post("/v1/webhooks/:id/:token", (c) => c.text("ok"));
  app.get("/healthz", (c) => c.text("ok"));
  app.get("/v1/things", (c) => c.text("ok"));
  return { app, lines };
};

describe("requestLogger", () => {
  test("adds an X-Request-Id and keeps a sane incoming one", async () => {
    const { app } = harness();
    const generated = await app.request("/v1/things");
    expect(generated.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await app.request("/v1/things", { headers: { "x-request-id": "trace-abc12345" } });
    expect(kept.headers.get("x-request-id")).toBe("trace-abc12345");
    const rejected = await app.request("/v1/things", { headers: { "x-request-id": "bad id with spaces\r\n" } });
    expect(rejected.headers.get("x-request-id")).not.toContain("bad");
  });

  test("capability tokens in URLs never reach the log", async () => {
    const { app, lines } = harness();
    await app.request("/u/SECRET-UNSUBSCRIBE-TOKEN.sig");
    await app.request("/v1/webhooks/6ade0a/SECRET-WEBHOOK-TOKEN", { method: "POST" });
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain("SECRET");
    expect(lines.map((l) => l.path)).toEqual(["/u/:token", "/v1/webhooks/6ade0a/:token"]);
  });

  test("probes are not logged; real requests are, with status and duration", async () => {
    const { app, lines } = harness();
    await app.request("/healthz");
    await app.request("/v1/things");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ method: "GET", path: "/v1/things", status: 200 });
    expect(typeof lines[0]!.ms).toBe("number");
  });
});
