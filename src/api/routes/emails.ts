import { Hono } from "hono";
import { z } from "zod";
import type { IntakeService } from "../../core/api/intake-service.ts";
import type { AccessTokenSigner, AttemptThrottle } from "../../core/api/ports.ts";
import type { EmailQueryService } from "../../core/api/query-services.ts";
import type { SmtpAccountService } from "../../core/api/smtp-account-service.ts";
import { ValidationError } from "../../core/errors.ts";
import type { MailAttachment } from "../../core/ports.ts";
import type { EmailStatus } from "../../db/mongo.ts";
import { emailSchema, objectIdParam, parseBody, presentEmail } from "../http.ts";
import { byUser, rateLimit, requireAuth, type AuthEnv } from "../middleware.ts";

const MAX_BATCH = 1000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES_TOTAL = 8 * 1024 * 1024; // decoded; the request body limit is 12 MB incl. base64 overhead
const STATUSES: EmailStatus[] = ["queued", "sending", "sent", "failed", "suppressed", "bounced", "complained"];

const vars = z.record(z.string().min(1).max(64), z.string().max(10_000)).refine((v) => Object.keys(v).length <= 50, "max 50 vars");

// a bare file name: no path separators, quotes or control characters (it ends up in a MIME header)
const FILENAME_RE = /^[^\\/"\p{Cc}]+$/u;
const CONTENT_TYPE_RE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const BASE64_RE = /^[A-Za-z0-9+/=\s]+$/;

const attachmentSchema = z.object({
  filename: z.string().min(1).max(255).regex(FILENAME_RE, "invalid filename"),
  contentType: z.string().regex(CONTENT_TYPE_RE, "invalid content type").default("application/octet-stream"),
  contentBase64: z.string().min(1).regex(BASE64_RE, "must be base64"),
});

const content = z.object({
  subject: z.string().min(1).max(998),
  text: z.string().max(500_000).optional(),
  html: z.string().max(500_000).optional(),
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional(),
});

function decodeAttachments(items: z.infer<typeof attachmentSchema>[] | undefined): MailAttachment[] | undefined {
  if (!items?.length) return undefined;
  const files = items.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: Buffer.from(a.contentBase64, "base64"),
  }));
  if (files.reduce((n, f) => n + f.content.length, 0) > MAX_ATTACHMENT_BYTES_TOTAL) {
    throw new ValidationError(`attachments exceed ${MAX_ATTACHMENT_BYTES_TOTAL / 1024 / 1024} MB in total`);
  }
  return files;
}

const needsBody = (c: { text?: string; html?: string }) => c.text !== undefined || c.html !== undefined;

const singleSchema = content
  .extend({
    smtpId: z.string().optional(),
    to: emailSchema,
    vars: vars.optional(),
    priority: z.enum(["transactional", "bulk"]).default("transactional"),
  })
  .refine(needsBody, "text or html is required");

const batchSchema = content
  .extend({
    smtpId: z.string().optional(),
    priority: z.enum(["transactional", "bulk"]).default("bulk"),
    recipients: z
      .array(z.object({ to: emailSchema, vars: vars.optional() }))
      .min(1)
      .max(MAX_BATCH),
  })
  .refine(needsBody, "text or html is required");

function idempotencyKey(header: string | undefined) {
  if (header === undefined) return undefined;
  if (!/^[\x21-\x7e]{1,128}$/.test(header)) throw new ValidationError("Idempotency-Key must be 1-128 printable ASCII chars");
  return header;
}

export interface EmailRouteDeps {
  intake: IntakeService;
  queries: EmailQueryService;
  accounts: SmtpAccountService;
  signer: AccessTokenSigner;
  throttle: AttemptThrottle;
  sendRequestsPerMinute: number;
}

export function emailRoutes(d: EmailRouteDeps) {
  const app = new Hono<AuthEnv>();
  app.use(requireAuth(d.signer));

  // sending is limited per user: protects the pipeline from a single tenant hammering the API
  const sendLimit = rateLimit(d.throttle, { name: "send", limit: d.sendRequestsPerMinute, windowSec: 60, keyOf: byUser });

  app.post("/", sendLimit, async (c) => {
    const userId = c.get("userId");
    const body = await parseBody(c, singleSchema);
    const smtp = await d.accounts.resolveForSending(userId, body.smtpId ? objectIdParam(body.smtpId, "smtpId") : undefined);
    const [r] = await d.intake.accept({
      userId,
      smtp,
      priority: body.priority,
      template: { subject: body.subject, text: body.text, html: body.html },
      attachments: decodeAttachments(body.attachments),
      recipients: [{ to: body.to, vars: body.vars }],
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key")),
      single: true,
    });
    return c.json(r, r!.replayed ? 200 : 202);
  });

  app.post("/batch", sendLimit, async (c) => {
    const userId = c.get("userId");
    const body = await parseBody(c, batchSchema);
    const smtp = await d.accounts.resolveForSending(userId, body.smtpId ? objectIdParam(body.smtpId, "smtpId") : undefined);
    const accepted = await d.intake.accept({
      userId,
      smtp,
      priority: body.priority,
      template: { subject: body.subject, text: body.text, html: body.html },
      attachments: decodeAttachments(body.attachments),
      recipients: body.recipients,
      idempotencyKey: idempotencyKey(c.req.header("idempotency-key")),
    });
    return c.json(
      {
        count: accepted.length,
        queued: accepted.filter((a) => a.status === "queued" && !a.replayed).length,
        suppressed: accepted.filter((a) => a.status === "suppressed").length,
        replayed: accepted.filter((a) => a.replayed).length,
        accepted,
      },
      202,
    );
  });

  app.get("/", async (c) => {
    const status = c.req.query("status");
    if (status && !STATUSES.includes(status as EmailStatus)) throw new ValidationError(`status must be one of ${STATUSES.join(", ")}`);
    const before = c.req.query("before");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 100);
    const page = await d.queries.list(c.get("userId"), {
      status: status as EmailStatus | undefined,
      before: before ? objectIdParam(before, "cursor") : undefined,
      limit,
    });
    return c.json({ items: page.items.map(presentEmail), nextCursor: page.nextCursor ? String(page.nextCursor) : null });
  });

  app.get("/:id", async (c) => c.json(presentEmail(await d.queries.get(c.get("userId"), objectIdParam(c.req.param("id"), "email id")))));
  return app;
}
