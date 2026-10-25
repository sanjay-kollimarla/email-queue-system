import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Hono } from "hono";
import { isApiPath, looksLikeFile, mountWebApp } from "../src/api/web-assets.ts";

/**
 * The web app is served by the API process. These tests pin the behaviour that matters in production:
 * deep links work, but a missing asset is a REAL 404 (so a stale browser tab fails cleanly instead of receiving
 * index.html as JavaScript), and a redeploy that swaps index.html is picked up without restarting the server.
 */
describe("web app serving", () => {
  let dir: string;
  let app: Hono;

  beforeAll(() => {
    // serveStatic resolves relative to the working directory, so create the fixture inside it
    dir = mkdtempSync(join(process.cwd(), ".webtest-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>v1</title><script src=/assets/app-1.js></script>");
    writeFileSync(join(dir, "assets", "app-1.js"), "console.log('app-1')");
    writeFileSync(join(dir, "favicon.svg"), "<svg/>");

    app = new Hono();
    app.get("/v1/ping", (c) => c.json({ ok: true }));
    const fallback = mountWebApp(app, relative(process.cwd(), dir));
    expect(fallback).not.toBeNull();
    app.notFound((c) => {
      const html = c.req.method === "GET" ? fallback?.(new URL(c.req.url).pathname) : null;
      return html ? c.html(html, 200, { "Cache-Control": "no-cache" }) : c.json({ error: "not found" }, 404);
    });
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const get = (path: string) => app.request(path);

  test("the app shell is served at / and for deep links (client-side routing, refresh on any page)", async () => {
    for (const path of ["/", "/emails", "/smtp/anything/deep"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("<title>v1</title>");
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  test("an existing hashed asset is served with a one-year immutable cache", async () => {
    const res = await get("/assets/app-1.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toContain("app-1");
  });

  test("a MISSING asset is a real 404, never index.html (the stale-tab bug)", async () => {
    for (const path of ["/assets/compose-page-OLDHASH.js", "/assets/old.css", "/logo.png", "/robots.txt"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).not.toContain("text/html");
    }
  });

  test("unknown API paths stay JSON 404s", async () => {
    const res = await get("/v1/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect((await get("/v1/ping")).status).toBe(200);
  });

  test("non-GET requests to unknown paths are not answered with the app shell", async () => {
    expect((await app.request("/some/page", { method: "POST" })).status).toBe(404);
  });

  test("redeploying (index.html replaced) is picked up without restarting", async () => {
    const index = join(dir, "index.html");
    writeFileSync(index, "<!doctype html><title>v2</title>");
    const later = new Date(Date.now() + 5000);
    utimesSync(index, later, later); // make the mtime change unmistakable on coarse-grained file systems
    expect(await (await get("/emails")).text()).toContain("<title>v2</title>");
  });

  test("path classification", () => {
    expect(isApiPath("/v1/emails")).toBe(true);
    expect(isApiPath("/u/token")).toBe(true);
    expect(isApiPath("/metrics")).toBe(true);
    expect(isApiPath("/emails")).toBe(false);
    expect(looksLikeFile("/assets/x")).toBe(true);
    expect(looksLikeFile("/app.js")).toBe(true);
    expect(looksLikeFile("/emails")).toBe(false);
    expect(looksLikeFile("/settings/profile")).toBe(false);
    expect(looksLikeFile("/")).toBe(false);
  });
});

describe("no web build present", () => {
  test("mountWebApp returns null so an API-only deployment keeps working", () => {
    expect(mountWebApp(new Hono(), "./definitely-not-a-directory")).toBeNull();
  });
});
