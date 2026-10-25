/**
 * Composition root: the ONLY place that knows which concrete adapter implements which port.
 * Everything else receives its collaborators through constructors (Dependency Injection), so any
 * adapter can be swapped or faked without touching the core.
 */
import { config } from "./config.ts";
import { AuthService } from "./core/api/auth-service.ts";
import { DashboardService } from "./core/api/dashboard-service.ts";
import { IntakeService } from "./core/api/intake-service.ts";
import { EmailQueryService, SuppressionService } from "./core/api/query-services.ts";
import { SmtpAccountService } from "./core/api/smtp-account-service.ts";
import { FeedbackService } from "./core/feedback/feedback-service.ts";
import { UnsubscribeService, WebhookAccess } from "./core/feedback/unsubscribe-service.ts";
import { HousekeepingService } from "./core/recovery/housekeeping-service.ts";
import { RecoveryService } from "./core/recovery/recovery-service.ts";
import { ReleaseService } from "./core/release/release-service.ts";
import {
  AuthFailureHandler,
  PermanentFailureHandler,
  QuotaHandler,
  ThrottleHandler,
  TransientFailureHandler,
  type FailureHandlers,
  type FailurePolicy,
} from "./core/send/failure-handlers.ts";
import { SendEmailService, type SendPolicy } from "./core/send/send-email-service.ts";
import { SuccessReporter } from "./core/send/success-reporter.ts";
import { MongoDeliveryActivityRepository } from "./infra/mongo/activity-repository.ts";
import { MongoAttachmentStore } from "./infra/mongo/attachment-store.ts";
import { MongoFeedbackStore } from "./infra/mongo/feedback-store.ts";
import {
  MongoAuditLog,
  MongoRefreshTokenRepository,
  MongoSmtpAccountRepository,
  MongoSuppressionRepository,
  MongoUserRepository,
} from "./infra/mongo/account-repositories.ts";
import { MongoEmailStore } from "./infra/mongo/email-store.ts";
import { MongoEmailQueryRepository, MongoIntakeRepository } from "./infra/mongo/intake-repository.ts";
import { MongoOutboxStore } from "./infra/mongo/outbox-store.ts";
import { MongoRecoveryStore } from "./infra/mongo/recovery-store.ts";
import { MongoSmtpDirectory } from "./infra/mongo/smtp-directory.ts";
import { StatusWriter } from "./infra/mongo/status-writer.ts";
import { MongoTemplateStore } from "./infra/mongo/template-store.ts";
import { NodemailerMailer } from "./infra/nodemailer-mailer.ts";
import { BullJobQueue } from "./infra/queue/bull-adapters.ts";
import { BullQueueStats, MongoRedisReadiness, RedisAttemptThrottle, RedisMetrics } from "./infra/redis/adapters.ts";
import {
  ArgonPasswordHasher,
  AesSecretBox,
  HmacCapabilityTokens,
  JwtAccessTokenSigner,
  Sha256OpaqueTokens,
} from "./infra/security/adapters.ts";
import { NodemailerConnectionTester, PublicHostPolicy } from "./infra/smtp-adapters.ts";
import { CounterMetrics, JsonLogger } from "./lib/observability.ts";
import { redis } from "./lib/redis.ts";
import { queues } from "./queue/queues.ts";
import { SmtpLimiter } from "./ratelimit/limiter.ts";
import { classifySmtpError } from "./smtp/classify.ts";

const APP_VERSION = "1.0.0";
export const AUTH_PAUSE_MS = 10 * 60_000;

let sharedLimiter: SmtpLimiter | undefined;
const limiter = () => (sharedLimiter ??= new SmtpLimiter(redis));

// ---------- API ----------
export function buildApi() {
  const signer = new JwtAccessTokenSigner(config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SEC);
  const redisMetrics = new RedisMetrics(redis);
  const audit = new MongoAuditLog();
  const tokens = new HmacCapabilityTokens();
  const suppressionRepo = new MongoSuppressionRepository();
  const smtpAccounts = new MongoSmtpAccountRepository();
  const emailQueries = new EmailQueryService(new MongoEmailQueryRepository());
  const accounts = new SmtpAccountService(
    smtpAccounts,
    new AesSecretBox(),
    new NodemailerConnectionTester(),
    new PublicHostPolicy(),
    limiter(),
    audit,
  );
  return {
    signer,
    dashboard: new DashboardService(emailQueries, accounts, new MongoDeliveryActivityRepository()),
    session: {
      refreshTtlSec: config.REFRESH_TOKEN_TTL_SEC,
      allowedOrigins: (config.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    meta: {
      demo: config.DEMO_MODE,
      version: APP_VERSION,
      ...(config.DEMO_MODE ? { demoSmtp: { host: config.DEMO_SMTP_HOST, port: config.DEMO_SMTP_PORT } } : {}),
    },
    webDist: config.WEB_DIST,
    smtpAccounts,
    unsubscribe: new UnsubscribeService(tokens, suppressionRepo, config.PUBLIC_BASE_URL),
    webhookAccess: new WebhookAccess(tokens, config.PUBLIC_BASE_URL),
    feedback: new FeedbackService(new MongoFeedbackStore(), new JsonLogger("api")),
    auth: new AuthService(
      new MongoUserRepository(),
      new MongoRefreshTokenRepository(),
      new ArgonPasswordHasher(),
      signer,
      new Sha256OpaqueTokens(),
      audit,
      config.REFRESH_TOKEN_TTL_SEC,
    ),
    accounts,
    intake: new IntakeService(new MongoIntakeRepository(), new MongoAttachmentStore(), config.MESSAGE_ID_DOMAIN),
    emailQueries,
    suppressions: new SuppressionService(suppressionRepo),
    throttle: new RedisAttemptThrottle(redis),
    readiness: new MongoRedisReadiness(redis),
    queueStats: new BullQueueStats(queues),
    metrics: redisMetrics,
    metricsToken: config.METRICS_TOKEN,
    sendRequestsPerMinute: config.SEND_REQUESTS_PER_MINUTE,
    authRateLimitScale: config.AUTH_RATE_LIMIT_SCALE,
  };
}
export type ApiServices = ReturnType<typeof buildApi>;

// ---------- workers ----------
export function buildSendWorker(serviceName = "worker") {
  const log = new JsonLogger(serviceName);
  const metrics = new CounterMetrics();
  const writer = new StatusWriter();
  const emails = new MongoEmailStore(writer);
  const smtps = new MongoSmtpDirectory();
  const rates = limiter();
  const failurePolicy: FailurePolicy = { authPauseMs: AUTH_PAUSE_MS, defaultQuotaPauseMs: 60 * 60_000 };

  const failures: FailureHandlers = {
    permanent: new PermanentFailureHandler(emails, metrics),
    throttle: new ThrottleHandler(emails, rates, smtps, metrics),
    quota: new QuotaHandler(emails, rates, failurePolicy),
    auth: new AuthFailureHandler(emails, smtps, rates, failurePolicy),
    transient: new TransientFailureHandler(emails, metrics),
  };
  const reporter = new SuccessReporter(rates, smtps, log);
  const policy: SendPolicy = {
    maxDeferrals: 200,
    authPauseMs: AUTH_PAUSE_MS,
    gateWaitMs: 15_000,
    maxGateWaiters: Math.floor(config.WORKER_CONCURRENCY / 2),
    execToleranceMs: 250,
  };
  const service = new SendEmailService({
    emails,
    smtps,
    templates: new MongoTemplateStore(),
    attachments: new MongoAttachmentStore(),
    listHeaders: new UnsubscribeService(new HmacCapabilityTokens(), new MongoSuppressionRepository(), config.PUBLIC_BASE_URL),
    guard: rates,
    mailer: new NodemailerMailer(),
    reporter,
    failures,
    classify: classifySmtpError,
    metrics,
    policy,
  });
  return { service, reporter, writer, emails, metrics, metricsSink: new RedisMetrics(redis), log };
}

export function buildRelay() {
  return new ReleaseService(
    new MongoOutboxStore(),
    new MongoSmtpDirectory(),
    limiter(),
    new BullJobQueue(),
    { maxChunk: 1000, maxIterationsPerTick: 8, maxReady: Number(process.env.RELAY_MAX_READY ?? 5000) },
    new JsonLogger("relay"),
  );
}

export function buildRecovery() {
  return {
    housekeeping: new HousekeepingService(new MongoAttachmentStore(), config.EMAIL_RETENTION_DAYS),
    log: new JsonLogger("reaper"),
    service: new RecoveryService(new MongoRecoveryStore(), new BullJobQueue(), {
      batch: 500,
      sendingLeaseMs: config.SENDING_LEASE_MS,
      reconcileAfterMs: Number(process.env.RECONCILE_AFTER_MS ?? 3 * 60_000),
    }),
  };
}
