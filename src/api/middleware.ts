import type { ErrorHandler, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import type { ObjectId } from "mongodb";
import { ZodError, z } from "zod";
import type { AccessTokenSigner, AttemptThrottle } from "../core/api/ports.ts";
import { ConflictError, DomainError, NotFoundError, RateLimitedError, UnauthorizedError, ValidationError } from "../core/errors.ts";

export type AuthEnv = { Variables: { userId: ObjectId } };

export const requireAuth =
  (signer: AccessTokenSigner): MiddlewareHandler<AuthEnv> =>
  async (c, next) => {
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedError("missing bearer token");
    try {
      c.set("userId", await signer.verify(token));
    } catch {
      throw new UnauthorizedError("invalid or expired token");
    }
    await next();
  };

export const clientIp = (c: Parameters<MiddlewareHandler>[0]) => {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown"; // not running under Bun.serve (tests)
  }
};

/** Fixed-window limiter. `keyOf` decides who is being limited (client IP for credentials, user id for sending). */
export const rateLimit =
  (
    throttle: AttemptThrottle,
    opts: { name: string; limit: number; windowSec: number; keyOf?: (c: Parameters<MiddlewareHandler>[0]) => string },
  ): MiddlewareHandler =>
  async (c, next) => {
    const who = opts.keyOf ? opts.keyOf(c) : clientIp(c);
    const n = await throttle.hit(`${opts.name}:${who}`, opts.windowSec);
    if (n > opts.limit) throw new RateLimitedError("too many requests, slow down", opts.windowSec);
    await next();
  };

/** Requests in the userId-authenticated area are limited per user, not per IP. */
export const byUser = (c: Parameters<MiddlewareHandler>[0]) => String((c as unknown as { get(k: string): unknown }).get("userId"));

export const metricsAuth =
  (token: string | undefined): MiddlewareHandler =>
  async (c, next) => {
    if (token && c.req.header("authorization") !== `Bearer ${token}`) throw new UnauthorizedError("metrics token required");
    await next();
  };

/** The single place where domain errors become HTTP responses. */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof RateLimitedError) {
    c.header("Retry-After", String(err.retryAfterSec));
    return c.json({ error: err.message }, 429);
  }
  if (err instanceof ValidationError) return c.json({ error: err.message, details: err.details }, 422);
  if (err instanceof UnauthorizedError) return c.json({ error: err.message }, 401);
  if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
  if (err instanceof ConflictError) return c.json({ error: err.message }, 409);
  if (err instanceof ZodError) return c.json({ error: "validation failed", details: z.flattenError(err) }, 422);
  if (err instanceof DomainError) return c.json({ error: err.message }, 400);
  console.error(JSON.stringify({ level: "error", service: "api", msg: "unhandled", error: String(err) }));
  return c.json({ error: "internal error" }, 500);
};

const UNSUBSCRIBE_PATH = /^\/u\/.+/;
const WEBHOOK_PATH = /^(\/v1\/webhooks\/[^/]+)\/.+/;
const REQUEST_ID_RE = /^[\w.-]{8,64}$/;

/**
 * Access log + correlation id: every request gets an X-Request-Id (an incoming one is kept when it looks sane),
 * and one JSON line is written when it finishes. Probes and scrapes are skipped to keep the log useful.
 */
export const requestLogger =
  (log: {
    info(msg: string, f?: Record<string, unknown>): void;
    error(msg: string, f?: Record<string, unknown>): void;
  }): MiddlewareHandler =>
  async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
    c.header("X-Request-Id", requestId);
    const start = performance.now();
    await next();
    const path = new URL(c.req.url).pathname;
    if (path === "/healthz" || path === "/readyz" || path === "/metrics") return;
    // tokens in /u/:token and /v1/webhooks/:id/:token are capabilities: never write them to logs
    const safePath = path.replace(UNSUBSCRIBE_PATH, "/u/:token").replace(WEBHOOK_PATH, "$1/:token");
    log.info("request", {
      requestId,
      method: c.req.method,
      path: safePath,
      status: c.res.status,
      ms: Math.round(performance.now() - start),
      ip: clientIp(c),
      userId: (c as unknown as { get(k: string): unknown }).get("userId")
        ? String((c as unknown as { get(k: string): unknown }).get("userId"))
        : undefined,
    });
  };
