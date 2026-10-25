import { Hono } from "hono";
import { z } from "zod";
import type { AccessTokenSigner } from "../../core/api/ports.ts";
import type { SmtpAccountService } from "../../core/api/smtp-account-service.ts";
import type { WebhookAccess } from "../../core/feedback/unsubscribe-service.ts";
import { emailSchema, objectIdParam, parseBody, presentSmtp } from "../http.ts";
import { detectProvider } from "../../smtp/presets.ts";
import { requireAuth, type AuthEnv } from "../middleware.ts";

const limitsSchema = z
  .object({
    perSecond: z.number().positive().max(100_000).optional(),
    perMinute: z.number().positive().max(6_000_000).optional(),
    perDay: z.number().int().positive().max(100_000_000).optional(),
  })
  .strict()
  .refine((l) => l.perSecond !== undefined || l.perMinute !== undefined, "perSecond or perMinute is required");

const createSchema = z.object({
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().optional(),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  fromEmail: emailSchema,
  fromName: z.string().max(120).optional(),
  limits: limitsSchema,
  maxConnections: z.number().int().min(1).max(50).default(5),
  skipVerify: z.boolean().default(false),
});
const patchSchema = createSchema.partial().omit({ skipVerify: true });

export function smtpRoutes(service: SmtpAccountService, signer: AccessTokenSigner, webhooks: WebhookAccess) {
  const app = new Hono<AuthEnv>();
  app.use(requireAuth(signer));
  const present = (v: Parameters<typeof presentSmtp>[0], extra: Record<string, unknown> = {}) =>
    presentSmtp(v, { webhookUrl: webhooks.urlFor(v.account._id), ...extra });
  const idOf = (c: { req: { param(k: string): string } }) => objectIdParam(c.req.param("id"), "smtp account id");

  app.post("/", async (c) => {
    const view = await service.create(c.get("userId"), await parseBody(c, createSchema));
    return c.json(present(view, { providerHint: view.hint }), 201);
  });
  app.get("/", async (c) => c.json({ items: (await service.list(c.get("userId"))).map((v) => present(v)) }));
  // documented limits for a known provider host, so the form can suggest values while the user types
  app.get("/hints", (c) => {
    const host = (c.req.query("host") ?? "").trim().toLowerCase();
    const preset = host ? detectProvider(host) : null;
    return c.json(
      preset
        ? { provider: preset.provider, limits: preset.limits, maxConnections: preset.maxConnections, note: preset.note }
        : { provider: "custom" },
    );
  });
  app.get("/:id", async (c) => c.json(present(await service.get(c.get("userId"), idOf(c)))));
  app.patch("/:id", async (c) => c.json(present(await service.update(c.get("userId"), idOf(c), await parseBody(c, patchSchema)))));
  app.post("/:id/verify", async (c) => {
    await service.verify(c.get("userId"), idOf(c));
    return c.json({ ok: true });
  });
  app.delete("/:id", async (c) => {
    await service.delete(c.get("userId"), idOf(c));
    return c.json({ ok: true });
  });
  return app;
}
