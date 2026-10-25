import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Harness, infraUp, startHarness } from "./helpers/harness.ts";

/** Browser sessions (HttpOnly refresh cookie), the dashboard feed and the public meta document. */
const up = await infraUp();
if (!up) console.warn("[web session tests] MongoDB/Redis not reachable, skipping");

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
const creds = (email: string) => ({ email, password: "correct-horse-battery" });
const WEB = { "x-client": "web" };

describe.skipIf(!up)("web session + dashboard (integration)", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => h?.cleanup());

  test("login as a web client: refresh token is a Strict HttpOnly cookie and absent from the JSON body", async () => {
    const u = await h.newUser();
    const r = await h.call("/v1/auth/login", { body: creds(u.email), headers: WEB });
    expect(r.status).toBe(200);
    expect(r.json.accessToken).toBeString();
    expect(r.json.refreshToken).toBeUndefined();
    const raw = r.res.headers.get("set-cookie") ?? "";
    expect(raw).toContain("eq_rt=");
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toContain("Path=/v1/auth");
  });

  test("API clients (no X-Client header) still get the refresh token in the body", async () => {
    const u = await h.newUser();
    const r = await h.call("/v1/auth/login", { body: creds(u.email) });
    expect(r.json.refreshToken).toBeString();
  });

  test("cookie refresh works from the same origin and rotates the cookie", async () => {
    const u = await h.newUser();
    const login = await h.call("/v1/auth/login", { body: creds(u.email), headers: WEB });
    const cookie1 = cookieOf(login.res);
    const refreshed = await h.call("/v1/auth/refresh", {
      method: "POST",
      headers: { ...WEB, cookie: cookie1, origin: "http://localhost" },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.json.accessToken).toBeString();
    const cookie2 = cookieOf(refreshed.res);
    expect(cookie2).not.toBe(cookie1);
    // the rotated-out token is single use: replaying it is detected and kills the session family
    const replay = await h.call("/v1/auth/refresh", { method: "POST", headers: { ...WEB, cookie: cookie1, origin: "http://localhost" } });
    expect(replay.status).toBe(401);
    const afterReplay = await h.call("/v1/auth/refresh", {
      method: "POST",
      headers: { ...WEB, cookie: cookie2, origin: "http://localhost" },
    });
    expect(afterReplay.status).toBe(401);
  });

  test("cookie refresh is refused without an Origin header or from another origin (CSRF defence in depth)", async () => {
    const u = await h.newUser();
    const cookie = cookieOf((await h.call("/v1/auth/login", { body: creds(u.email), headers: WEB })).res);
    const noOrigin = await h.call("/v1/auth/refresh", { method: "POST", headers: { ...WEB, cookie } });
    expect(noOrigin.status).toBe(401);
    const evil = await h.call("/v1/auth/refresh", { method: "POST", headers: { ...WEB, cookie, origin: "https://evil.example" } });
    expect(evil.status).toBe(401);
    // and the refused attempts did not burn the session
    const ok = await h.call("/v1/auth/refresh", { method: "POST", headers: { ...WEB, cookie, origin: "http://localhost" } });
    expect(ok.status).toBe(200);
  });

  test("refresh with no cookie and no body is a plain 401", async () => {
    expect((await h.call("/v1/auth/refresh", { method: "POST" })).status).toBe(401);
  });

  test("logout revokes the session and clears the cookie", async () => {
    const u = await h.newUser();
    const cookie = cookieOf((await h.call("/v1/auth/login", { body: creds(u.email), headers: WEB })).res);
    const out = await h.call("/v1/auth/logout", { method: "POST", headers: { ...WEB, cookie, origin: "http://localhost" } });
    expect(out.status).toBe(200);
    expect(out.res.headers.get("set-cookie") ?? "").toMatch(/eq_rt=;|Max-Age=0|Expires=/i);
    const after = await h.call("/v1/auth/refresh", { method: "POST", headers: { ...WEB, cookie, origin: "http://localhost" } });
    expect(after.status).toBe(401);
  });

  test("dashboard: counts, a continuous 3-minute series, accounts with live rate, recent problems", async () => {
    const u = await h.newUser();
    await h.call("/v1/smtp", {
      token: u.accessToken,
      body: {
        name: "t",
        host: "localhost",
        port: 2525,
        username: "u",
        password: "pw",
        fromEmail: "f@itest.local",
        limits: { perSecond: 5 },
        skipVerify: true,
      },
    });
    await h.call("/v1/emails/batch", {
      token: u.accessToken,
      body: { subject: "s", text: "t", recipients: [{ to: "a@example.com" }, { to: "b@example.com" }, { to: "c@example.com" }] },
    });
    // pretend two were sent just now and one failed
    const emails = await h.db.col.emails().find({ userId: u.userId }).sort({ _id: 1 }).toArray();
    await h.db.col.emails().updateOne({ _id: emails[0]!._id }, { $set: { status: "sent", sentAt: new Date() } });
    await h.db.col.emails().updateOne({ _id: emails[1]!._id }, { $set: { status: "sent", sentAt: new Date() } });
    await h.db.col.emails().updateOne({ _id: emails[2]!._id }, { $set: { status: "failed", lastError: "550 5.1.1 no such user" } });

    const d = await h.call("/v1/dashboard", { token: u.accessToken });
    expect(d.status).toBe(200);
    expect(d.json.counts).toMatchObject({ sent: 2, failed: 1, queued: 0 });
    expect(d.json.total).toBe(3);

    const pts = d.json.throughput.points as Array<{ at: string; sent: number }>;
    expect(d.json.throughput.bucketSec).toBe(5);
    expect(pts.length).toBeGreaterThanOrEqual(36); // 3 minutes of 5-second buckets, gaps filled with zeros
    const gaps = pts.slice(1).map((p, i) => Date.parse(p.at) - Date.parse(pts[i]!.at));
    expect(new Set(gaps)).toEqual(new Set([5_000])); // strictly continuous axis
    expect(pts.reduce((n, p) => n + p.sent, 0)).toBe(2);

    expect(d.json.accounts).toHaveLength(1);
    expect(d.json.accounts[0].rate.ceilingPerSec).toBe(5);
    expect(d.json.accounts[0].passwordEnc).toBeUndefined();
    expect(d.json.problems[0]).toMatchObject({ status: "failed", reason: "550 5.1.1 no such user" });
  });

  test("dashboard is tenant-scoped and needs a token", async () => {
    const a = await h.newUser();
    const b = await h.newUser();
    await h.call("/v1/smtp", {
      token: a.accessToken,
      body: {
        name: "t",
        host: "localhost",
        port: 2525,
        username: "u",
        password: "pw",
        fromEmail: "f@itest.local",
        limits: { perSecond: 5 },
        skipVerify: true,
      },
    });
    expect((await h.call("/v1/dashboard", { token: b.accessToken })).json.accounts).toEqual([]);
    expect((await h.call("/v1/dashboard")).status).toBe(401);
  });

  test("/v1/meta is public and small", async () => {
    const r = await h.call("/v1/meta");
    expect(r.status).toBe(200);
    expect(typeof r.json.demo).toBe("boolean");
    expect(typeof r.json.version).toBe("string");
    // nothing else leaks: demoSmtp appears only in demo mode
    expect(Object.keys(r.json).filter((k) => !["demo", "version", "demoSmtp"].includes(k))).toEqual([]);
    expect("demoSmtp" in r.json).toBe(r.json.demo);
  });

  test("security headers: CSP forbids third-party and inline scripts, framing is denied", async () => {
    const res = await h.app.request("/v1/meta");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});
