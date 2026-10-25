import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Hono } from "hono";
import { serveStatic } from "hono/bun";

/** Paths that belong to the API: an unknown one is a JSON 404, never the web app's index.html. */
const API_PREFIXES = ["/v1/", "/u/", "/metrics", "/healthz", "/readyz"];
export const isApiPath = (path: string) => API_PREFIXES.some((p) => path === p.replace(/\/$/, "") || path.startsWith(p));

/**
 * A request for /assets/foo.js or /logo.png that does not exist must be a real 404. Answering it with index.html
 * (status 200, text/html) is what makes a browser tab that was open during a redeploy fail with the cryptic
 * "Failed to fetch dynamically imported module": it asked for an old chunk and got HTML back.
 */
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
export const looksLikeFile = (path: string) => path.startsWith("/assets/") || FILE_EXTENSION.test(path.split("/").pop() ?? "");

/**
 * Serves the built single-page app from the API process, so the whole product is ONE deployable on ONE origin
 * (which is also what makes SameSite cookie sessions work without any CORS configuration).
 *
 *  - /assets/*  content-hashed by the bundler  -> cached for a year, immutable
 *  - everything else under the app             -> revalidated (index.html must never be stale)
 *  - unknown non-API GET paths                  -> index.html (client-side routing, deep links, refresh)
 *
 * Returns the SPA-fallback renderer, or null when no build exists (API-only deployments keep working).
 */
export function mountWebApp(app: Hono, distDir: string): ((path: string) => string | null) | null {
  const abs = resolve(distDir);
  const indexPath = join(abs, "index.html");
  if (!existsSync(indexPath)) return null;

  // re-read when the file changes (a redeploy swaps index.html and the hashed asset names it points to)
  let cached = { mtime: 0, html: "" };
  const indexHtml = () => {
    const mtime = statSync(indexPath).mtimeMs;
    if (mtime !== cached.mtime) cached = { mtime, html: readFileSync(indexPath, "utf8") };
    return cached.html;
  };
  const root = `./${relative(process.cwd(), abs).replaceAll("\\", "/")}`;

  app.use("/assets/*", async (c, next) => {
    c.header("Cache-Control", "public, max-age=31536000, immutable");
    await next();
  });
  app.use("/*", async (c, next) => {
    if (isApiPath(new URL(c.req.url).pathname)) return next();
    if (!c.req.path.startsWith("/assets/")) c.header("Cache-Control", "no-cache");
    return serveStatic({ root })(c, next);
  });

  return (path) => (isApiPath(path) || looksLikeFile(path) ? null : indexHtml());
}
