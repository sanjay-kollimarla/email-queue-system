import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { config } from "../config.ts";
import { type ApiServices, buildApi } from "../container.ts";
import { connectMongo, mongo } from "../db/mongo.ts";
import { JsonLogger } from "../lib/observability.ts";
import { redis } from "../lib/redis.ts";
import { closeQueues } from "../queue/queues.ts";
import { errorHandler, requestLogger } from "./middleware.ts";
import { authRoutes } from "./routes/auth.ts";
import { emailRoutes } from "./routes/emails.ts";
import { dashboardRoutes, opsRoutes, statsRoutes, suppressionRoutes } from "./routes/ops.ts";
import { publicRoutes } from "./routes/public.ts";
import { smtpRoutes } from "./routes/smtp.ts";
import { mountWebApp } from "./web-assets.ts";

/** Pure assembly: every dependency arrives through `s`, so tests can mount the app on fakes. */
export function createApp(s: ApiServices) {
  const app = new Hono();
  app.use(requestLogger(new JsonLogger("api")));
  app.use(
    secureHeaders({
      // the SPA is same-origin only: no third-party scripts, styles, fonts or connections
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // React inline style attributes; no inline <script> is allowed
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
      },
    }),
  );
  app.use("/v1/*", bodyLimit({ maxSize: 12 * 1024 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) }));
  app.use("/u/*", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "payload too large" }, 413) }));

  app.route(
    "/",
    opsRoutes({
      readiness: s.readiness,
      queueStats: s.queueStats,
      metrics: s.metrics,
      metricsToken: s.metricsToken,
      meta: s.meta,
    }),
  );
  app.route(
    "/v1/auth",
    authRoutes({ auth: s.auth, signer: s.signer, throttle: s.throttle, limitScale: s.authRateLimitScale, session: s.session }),
  );
  app.route("/v1/smtp", smtpRoutes(s.accounts, s.signer, s.webhookAccess));
  app.route(
    "/",
    publicRoutes({
      unsubscribe: s.unsubscribe,
      webhookAccess: s.webhookAccess,
      feedback: s.feedback,
      accounts: s.smtpAccounts,
      throttle: s.throttle,
    }),
  );
  app.route(
    "/v1/emails",
    emailRoutes({
      intake: s.intake,
      queries: s.emailQueries,
      accounts: s.accounts,
      signer: s.signer,
      throttle: s.throttle,
      sendRequestsPerMinute: s.sendRequestsPerMinute,
    }),
  );
  app.route("/v1/stats", statsRoutes(s.emailQueries, s.accounts, s.signer));
  app.route("/v1/dashboard", dashboardRoutes(s.dashboard, s.signer, s.webhookAccess));
  app.route("/v1/suppressions", suppressionRoutes(s.suppressions, s.signer));

  const spaFallback = s.webDist ? mountWebApp(app, s.webDist) : null;
  app.notFound((c) => {
    const html = c.req.method === "GET" ? spaFallback?.(new URL(c.req.url).pathname) : null;
    return html ? c.html(html, 200, { "Cache-Control": "no-cache" }) : c.json({ error: "not found" }, 404);
  });
  app.onError(errorHandler);
  return app;
}

if (import.meta.main) {
  await connectMongo();
  const app = createApp(buildApi());
  const server = Bun.serve({
    port: config.PORT,
    // Hono's Bun adapter reads the client address from env.server
    fetch: (req, srv) => app.fetch(req, { server: srv }),
  });
  console.log(JSON.stringify({ level: "info", service: "api", msg: "listening", port: server.port }));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop(); // stop accepting, let in-flight requests finish
    await closeQueues();
    await mongo.close();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
