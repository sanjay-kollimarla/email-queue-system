import { z } from "zod";

const bool = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const schema = z.object({
  MONGO_URL: z.string().default("mongodb://localhost:27017/?directConnection=true"),
  MONGO_DB: z.string().default("emailq"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  /** Redis Sentinel (HA): "host1:26379,host2:26379"; when set, REDIS_URL is ignored */
  REDIS_SENTINELS: z.string().optional(),
  REDIS_MASTER_NAME: z.string().default("mymaster"),
  REDIS_PASSWORD: z.string().optional(),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 chars"),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "ENCRYPTION_KEY must be 64 hex chars (32 bytes)"),
  /** id stored inside every ciphertext; change it together with ENCRYPTION_KEY when rotating */
  ENCRYPTION_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,16}$/)
    .default("k1"),
  /** previous keys, decrypt-only: "k0:<64 hex>,kX:<64 hex>" */
  ENCRYPTION_OLD_KEYS: z.string().optional(),
  /** signs unsubscribe links + webhook URLs; rotate independently of ENCRYPTION_KEY (see docs/RUNBOOK.md) */
  LINK_SIGNING_KEY: z.string().min(32).optional(),
  LINK_SIGNING_OLD_KEYS: z.string().optional(),
  PORT: z.coerce.number().default(3000),
  /** public base URL of the API (used in List-Unsubscribe links and webhook URLs), e.g. https://mail.example.com */
  PUBLIC_BASE_URL: z.string().url().optional(),
  EMAIL_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  MESSAGE_ID_DOMAIN: z.string().default("emailq.local"),
  ALLOW_PRIVATE_SMTP_HOSTS: bool.default(false),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(200),
  RELAY_CONCURRENCY: z.coerce.number().int().positive().default(4),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().default(15 * 60),
  REFRESH_TOKEN_TTL_SEC: z.coerce.number().default(30 * 24 * 3600),
  /** multiplies the per-IP limits on credential endpoints (tests raise it; leave at 1 in production) */
  AUTH_RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  /** extra browser origins allowed to use the cookie session (e.g. the Vite dev server: http://localhost:5173) */
  ALLOWED_ORIGINS: z.string().optional(),
  /** directory of the built web app; when it exists the API serves it (single deployable) */
  WEB_DIST: z.string().default("./web/dist"),
  /** enables demo helpers in the UI: one-click demo SMTP account and a synthetic batch sender */
  DEMO_MODE: bool.default(false),
  /** where the demo SMTP account points (the bundled fake SMTP sink); "sink" inside docker compose */
  DEMO_SMTP_HOST: z.string().default("localhost"),
  DEMO_SMTP_PORT: z.coerce.number().default(2525),
  METRICS_TOKEN: z.string().min(16).optional(),
  /** per-user cap on send requests (single or batch) per minute */
  SEND_REQUESTS_PER_MINUTE: z.coerce.number().int().positive().default(600),
  // how long a mail may sit in `sending` before the reaper assumes the worker died
  SENDING_LEASE_MS: z.coerce.number().default(2 * 60_000),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
