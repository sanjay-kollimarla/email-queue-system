import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { TokenPair } from "../core/api/auth-service.ts";
import { UnauthorizedError } from "../core/errors.ts";

/**
 * Browser sessions. The refresh token never touches JavaScript: it travels in an HttpOnly, SameSite=Strict
 * cookie scoped to /v1/auth, so an XSS bug cannot steal it. The short-lived access token is returned in the
 * JSON body and held in memory by the web app.
 *
 * Non-browser clients keep using the JSON refresh token (no cookie involved). Because a cookie is sent
 * automatically, a request that authenticates WITH the cookie must also prove it comes from our own site:
 * its Origin header has to be present and allowed (defence in depth on top of SameSite).
 */
export const REFRESH_COOKIE = "eq_rt";
const WEB_CLIENT_HEADER = "x-client";

export interface SessionCookieOptions {
  refreshTtlSec: number;
  /** origins (besides the request's own) allowed to use the cookie, e.g. the Vite dev server */
  allowedOrigins: string[];
}

const isHttps = (c: Context) => new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";

export const isWebClient = (c: Context) => c.req.header(WEB_CLIENT_HEADER) === "web";

/** Set the cookie; web clients also get the refresh token stripped from the JSON body. */
export function issueSession<T extends TokenPair>(c: Context, opts: SessionCookieOptions, result: T): Omit<T, "refreshToken"> | T {
  setCookie(c, REFRESH_COOKIE, result.refreshToken, {
    httpOnly: true,
    sameSite: "Strict",
    secure: isHttps(c),
    path: "/v1/auth",
    maxAge: opts.refreshTtlSec,
  });
  if (!isWebClient(c)) return result;
  const { refreshToken: _omitted, ...rest } = result;
  return rest;
}

export function clearSession(c: Context): void {
  deleteCookie(c, REFRESH_COOKIE, { path: "/v1/auth" });
}

/** The refresh token to use: the JSON one if given, else the cookie (which then requires a trusted Origin). */
export function readRefreshToken(c: Context, opts: SessionCookieOptions, fromBody: string | undefined): string {
  if (fromBody) return fromBody;
  const cookie = getCookie(c, REFRESH_COOKIE);
  if (!cookie) throw new UnauthorizedError("missing refresh token");
  const origin = c.req.header("origin");
  const own = new URL(c.req.url).origin;
  if (!origin || (origin !== own && !opts.allowedOrigins.includes(origin))) {
    throw new UnauthorizedError("cross-origin request rejected");
  }
  return cookie;
}
