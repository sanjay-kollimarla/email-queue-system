import { Hono } from "hono";
import { z } from "zod";
import type { AccessTokenSigner, MetricsReader, QueueStats, Readiness } from "../../core/api/ports.ts";
import type { DashboardService } from "../../core/api/dashboard-service.ts";
import type { EmailQueryService, SuppressionService } from "../../core/api/query-services.ts";
import type { SmtpAccountService } from "../../core/api/smtp-account-service.ts";
import type { WebhookAccess } from "../../core/feedback/unsubscribe-service.ts";
import { emailSchema, objectIdParam, parseBody, presentSmtp } from "../http.ts";
import { metricsAuth, requireAuth, type AuthEnv } from "../middleware.ts";

export function statsRoutes(queries: EmailQueryService, accounts: SmtpAccountService, signer: AccessTokenSigner) {
  const app = new Hono<AuthEnv>();
  app.use(requireAuth(signer));
  app.get("/", async (c) => {
    const userId = c.get("userId");
    const smtpId = c.req.query("smtpId");
    const smtp = smtpId ? (await accounts.get(userId, objectIdParam(smtpId, "smtpId"))).account._id : undefined;
    return c.json(await queries.stats(userId, smtp));
  });
  return app;
}

/** One call that feeds the whole dashboard screen (counts, throughput series, accounts and their live rate state). */
export function dashboardRoutes(service: DashboardService, signer: AccessTokenSigner, webhooks: WebhookAccess) {
  const app = new Hono<AuthEnv>();
  app.use(requireAuth(signer));
  app.get("/", async (c) => {
    const snap = await service.snapshot(c.get("userId"));
    return c.json({ ...snap, accounts: snap.accounts.map((a) => presentSmtp(a, { webhookUrl: webhooks.urlFor(a.account._id) })) });
  });
  return app;
}

export function suppressionRoutes(service: SuppressionService, signer: AccessTokenSigner) {
  const app = new Hono<AuthEnv>();
  app.use(requireAuth(signer));
  app.get("/", async (c) => {
    const items = await service.list(c.get("userId"));
    return c.json({ items: items.map((s) => ({ email: s.email, reason: s.reason, createdAt: s.createdAt })) });
  });
  app.post("/", async (c) => {
    const { email, reason } = await parseBody(
      c,
      z.object({ email: emailSchema.transform((e) => e.toLowerCase()), reason: z.string().max(200).default("manual") }),
    );
    await service.add(c.get("userId"), email, reason);
    return c.json({ ok: true }, 201);
  });
  app.delete("/:email", async (c) => {
    await service.remove(c.get("userId"), c.req.param("email").toLowerCase());
    return c.json({ ok: true });
  });
  return app;
}

const COUNTER_HELP: Record<string, string> = {
  sent: "Emails accepted by the SMTP server",
  throttled: "Sends rejected with a rate-limit response (adaptive controller backed off)",
  deferred: "Jobs re-scheduled without consuming an attempt",
  failed: "Emails that ended as failed",
  transient: "Transient failures that were retried",
};

export function opsRoutes(deps: {
  readiness: Readiness;
  queueStats: QueueStats;
  metrics: MetricsReader;
  metricsToken?: string;
  meta: { demo: boolean; version: string; demoSmtp?: { host: string; port: number } };
}) {
  const app = new Hono();
  // public, tiny: lets the web app adapt (demo helpers) without an account
  app.get("/v1/meta", (c) => c.json(deps.meta));
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    try {
      await deps.readiness.check();
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 503);
    }
  });

  /** Prometheus exposition format. Alert on oldest_waiting_age (growing = under-provisioned) and failed. */
  app.get("/metrics", metricsAuth(deps.metricsToken), async (c) => {
    const [lanes, totals] = await Promise.all([deps.queueStats.perLane(), deps.metrics.totals()]);
    const lines: string[] = [];
    for (const [name, help] of Object.entries(COUNTER_HELP)) {
      lines.push(`# HELP emailq_${name}_total ${help}`, `# TYPE emailq_${name}_total counter`, `emailq_${name}_total ${totals[name] ?? 0}`);
    }
    lines.push("# HELP emailq_queue_jobs Jobs per lane and state", "# TYPE emailq_queue_jobs gauge");
    for (const [lane, s] of Object.entries(lanes)) {
      for (const state of ["waiting", "active", "delayed", "failed"] as const) {
        lines.push(`emailq_queue_jobs{lane="${lane}",state="${state}"} ${s[state]}`);
      }
    }
    lines.push(
      "# HELP emailq_queue_oldest_waiting_age_seconds Age of the oldest ready job",
      "# TYPE emailq_queue_oldest_waiting_age_seconds gauge",
    );
    for (const [lane, s] of Object.entries(lanes)) {
      lines.push(`emailq_queue_oldest_waiting_age_seconds{lane="${lane}"} ${s.oldestWaitingAgeSec.toFixed(1)}`);
    }
    return c.text(lines.join("\n") + "\n", 200, { "content-type": "text/plain; version=0.0.4" });
  });
  return app;
}
