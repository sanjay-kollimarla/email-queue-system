import { Hono } from "hono";
import { ObjectId } from "mongodb";
import type { AttemptThrottle, SmtpAccountRepository } from "../../core/api/ports.ts";
import { snsSubscribeUrl } from "../../core/feedback/parsers.ts";
import type { FeedbackService } from "../../core/feedback/feedback-service.ts";
import type { UnsubscribeService, WebhookAccess } from "../../core/feedback/unsubscribe-service.ts";
import { NotFoundError, ValidationError } from "../../core/errors.ts";
import { rateLimit } from "../middleware.ts";

const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
  `<style>body{font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;text-align:center}button{font:inherit;padding:.6rem 1.2rem}</style></head><body>${body}</body></html>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface PublicRouteDeps {
  unsubscribe: UnsubscribeService;
  webhookAccess: WebhookAccess;
  feedback: FeedbackService;
  accounts: SmtpAccountRepository;
  throttle: AttemptThrottle;
  fetchImpl?: typeof fetch;
}

/**
 * Unauthenticated endpoints. None uses a session: each is guarded by a signed capability in its URL
 * (unsubscribe link, webhook secret), and is rate limited.
 */
export function publicRoutes(d: PublicRouteDeps) {
  const app = new Hono();
  const doFetch = d.fetchImpl ?? fetch;

  // GET only shows a confirmation: mail scanners that prefetch links must never unsubscribe anyone.
  app.get("/u/:token", rateLimit(d.throttle, { name: "unsub", limit: 120, windowSec: 60 }), (c) => {
    const { email } = d.unsubscribe.inspect(c.req.param("token"));
    return c.html(
      page(
        "Unsubscribe",
        `<h1>Unsubscribe</h1><p>Stop emails to <b>${escapeHtml(email)}</b>?</p>` +
          `<form method="post"><button type="submit">Yes, unsubscribe me</button></form>`,
      ),
    );
  });

  // POST is both the confirmation form and the RFC 8058 one-click request from mail clients.
  app.post("/u/:token", rateLimit(d.throttle, { name: "unsub", limit: 120, windowSec: 60 }), async (c) => {
    const email = await d.unsubscribe.unsubscribe(c.req.param("token"));
    const wantsHtml = (c.req.header("accept") ?? "").includes("text/html");
    return wantsHtml
      ? c.html(page("Unsubscribed", `<h1>Done</h1><p><b>${escapeHtml(email)}</b> will no longer receive these emails.</p>`))
      : c.json({ ok: true });
  });

  app.post(
    "/v1/webhooks/:smtpId/:token",
    rateLimit(d.throttle, { name: "webhook", limit: 600, windowSec: 60, keyOf: (c) => c.req.param("smtpId") ?? "x" }),
    async (c) => {
      const raw = c.req.param("smtpId");
      if (!ObjectId.isValid(raw)) throw new NotFoundError("not found");
      const smtpId = new ObjectId(raw);
      // same 404 for "no such account" and "bad token": do not reveal which account ids exist
      if (!d.webhookAccess.verify(smtpId, c.req.param("token"))) throw new NotFoundError("not found");
      const account = await d.accounts.findById(smtpId);
      if (!account) throw new NotFoundError("not found");

      let body: unknown;
      try {
        body = JSON.parse(await c.req.text());
      } catch {
        throw new ValidationError("body must be JSON (SNS posts text/plain JSON; that is accepted too)");
      }

      const confirmUrl = snsSubscribeUrl(body);
      if (confirmUrl) {
        await doFetch(confirmUrl); // AWS SNS subscription handshake (host-restricted in snsSubscribeUrl)
        return c.json({ ok: true, confirmed: true });
      }
      return c.json({ ok: true, ...(await d.feedback.handle(account.userId, smtpId, body)) });
    },
  );
  return app;
}
