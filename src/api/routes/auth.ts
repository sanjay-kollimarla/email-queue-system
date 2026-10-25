import { Hono } from "hono";
import { z } from "zod";
import type { AuthService } from "../../core/api/auth-service.ts";
import type { AccessTokenSigner, AttemptThrottle } from "../../core/api/ports.ts";
import { emailSchema, parseBody } from "../http.ts";
import { clientIp, rateLimit, requireAuth, type AuthEnv } from "../middleware.ts";
import { clearSession, issueSession, readRefreshToken, type SessionCookieOptions } from "../session-cookie.ts";

const credentials = z.object({
  email: emailSchema.transform((e) => e.toLowerCase()),
  password: z.string().min(10, "min 10 characters").max(128),
});
const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(10, "min 10 characters").max(128),
});
// the refresh token may be omitted: browsers send it in an HttpOnly cookie instead
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200).optional() });

export interface AuthRouteDeps {
  auth: AuthService;
  signer: AccessTokenSigner;
  throttle: AttemptThrottle;
  limitScale: number;
  session: SessionCookieOptions;
}

/** Body is optional for refresh/logout (cookie sessions send none). */
async function optionalBody(c: Parameters<typeof parseBody>[0]) {
  const text = await c.req.text();
  if (!text.trim()) return {} as z.infer<typeof refreshBody>;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return parseBody(c, refreshBody); // reuse the standard "must be valid JSON" error
  }
  const parsed = refreshBody.safeParse(raw);
  return parsed.success ? parsed.data : ({} as z.infer<typeof refreshBody>);
}

export function authRoutes({ auth, signer, throttle, limitScale, session }: AuthRouteDeps) {
  const app = new Hono<AuthEnv>();
  // credential endpoints are limited per client IP (brute force / signup abuse)
  const limit = (name: string, perMinute: number) =>
    rateLimit(throttle, { name: `auth-${name}`, limit: Math.ceil(perMinute * limitScale), windowSec: 60 });

  app.post("/register", limit("register", 20), async (c) => {
    const { email, password } = await parseBody(c, credentials);
    const result = await auth.register(email, password, { ip: clientIp(c) });
    return c.json(issueSession(c, session, result), 201);
  });

  app.post("/login", limit("login", 30), async (c) => {
    const { email, password } = await parseBody(c, credentials);
    const result = await auth.login(email, password, { ip: clientIp(c) });
    return c.json(issueSession(c, session, result));
  });

  app.post("/refresh", limit("refresh", 60), async (c) => {
    const body = await optionalBody(c);
    const token = readRefreshToken(c, session, body.refreshToken);
    try {
      return c.json(issueSession(c, session, await auth.refresh(token, { ip: clientIp(c) })));
    } catch (e) {
      clearSession(c); // a dead/reused token must not linger in the browser
      throw e;
    }
  });

  app.post("/logout", async (c) => {
    const body = await optionalBody(c);
    try {
      await auth.logout(readRefreshToken(c, session, body.refreshToken));
    } catch {
      /* logging out with no/invalid session is fine: the goal state (no session) already holds */
    }
    clearSession(c);
    return c.json({ ok: true });
  });

  app.post("/change-password", requireAuth(signer), limit("change-password", 10), async (c) => {
    const { currentPassword, newPassword } = await parseBody(c, changePasswordBody);
    const result = await auth.changePassword(c.get("userId"), currentPassword, newPassword, { ip: clientIp(c) });
    return c.json(issueSession(c, session, result));
  });

  app.get("/me", requireAuth(signer), async (c) => c.json(await auth.me(c.get("userId"))));
  return app;
}
