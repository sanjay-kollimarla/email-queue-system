# Runbook

Operational guide for the email queue system. Architecture and data flow: see the [README](../README.md).

## The one rule that explains every recovery

**MongoDB is the system of record. Redis is a cache that may lose data.** Every accepted email is in MongoDB
(written `w:majority` inside a transaction) before the API answers. Anything Redis loses is rebuilt from MongoDB
automatically by the reaper (see *Redis lost data*).

## Topology (`docker-compose.prod.yml`)

| Component | Layout | Survives |
|---|---|---|
| MongoDB | 3-node replica set, keyfile + auth | loss of any one node (verified: primary killed under load, 0 emails lost) |
| Redis | master + replica + 3 Sentinels, password, AOF | loss of the master (verified: failover under load, 0 emails lost) |
| API / relay / reaper / workers | stateless containers, healthchecks, 40s drain period | any of them restarting; workers can be added or removed at any time |

Put TLS termination (reverse proxy / load balancer) in front of the API; set `PUBLIC_BASE_URL` to its public URL
(used in `List-Unsubscribe` links and webhook URLs).

## Deploy / upgrade

```bash
cp .env.prod.example .env.prod        # fill every secret: openssl rand -hex 32
docker compose -p eqprod -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Rolling upgrade: rebuild, then restart services one group at a time (`worker` last). Workers receive SIGTERM, finish
in-flight sends (they stop within seconds), and exit; **a graceful stop never causes a duplicate** (verified).
A hard kill (OOM, power loss) can cause a rare duplicate for emails that were mid-send; the reaper re-queues them
after `SENDING_LEASE_MS` (default 2 min). Duplicates carry the same `Message-ID` and `X-Email-Id`.

Smoke-test a deployment end to end: `bun run smoke -- --sink-host <host>` (needs the fake SMTP sink,
`bun run sink`, or point it at a real SMTP and read the inbox).

## Capacity and scaling

* One worker process saturates one CPU core, roughly 1,000 emails/s of SMTP + queue + database work.
* Throughput = worker processes x ~1k/s, **capped per SMTP account by its declared rate**. The provider, not this
  system, is normally the limit.
* Scale out by adding worker replicas (`docker compose ... up -d --scale worker=8`) or `WORKER_PROCESSES=N bun run worker:cluster`.
* The API accepts ~15-30k emails/s (batches of 1,000); the backlog waits in MongoDB, so a spike never fills Redis.
* **Slow SMTP server**: each account sends at most `maxConnections` messages at once per worker process, so
  throughput = processes x maxConnections / latency (3 s latency, 10 connections, 4 processes = 13/s). Raise
  `maxConnections` (provider permitting) or add processes. Only ~2 x maxConnections emails per process are marked
  `sending`; the rest wait unclaimed. A server slower than the 30 s socket timeout cannot be served: every attempt
  times out client-side yet may still be accepted, so retries produce duplicates (the Message-ID is stable for receiver dedupe).
* Alert on **oldest waiting job age** (`emailq_queue_oldest_waiting_age_seconds`), not on depth.

### Sizing from measurements

Measured with the resource-limited load-test stack ([LOAD-TESTING.md](LOAD-TESTING.md)): declared 1,000/s, 60,000 emails,
8 workers at 0.5 CPU / 256 MB, MongoDB 2 CPU / 2 GB.

| Service | CPU avg / peak (cores) | RAM avg / peak |
|---|---|---|
| 8 workers (each) | 0.12 / 0.24 | 94 MiB / 125 MiB |
| MongoDB | 1.14 / 2.09 | 419 MiB / 580 MiB |
| Redis | 0.28 / 0.35 | 10 MiB / 13 MiB |
| API · relay · reaper | 0.04 · 0.10 · ~0 | 68 · 66 · 41 MiB |
| **Whole stack (excluding the fake SMTP server)** | **about 3.5 / 5.4** | **about 1.3 GiB / 1.5 GiB** |

Rules of thumb: the app (API, relay, workers, reaper) costs about 450 emails/s per CPU core, so plan
`cores = target emails/s ÷ 450` plus 30–50% headroom; **MongoDB is the first component to saturate**, so give it more CPU
than the app tier; workers need little RAM (about 100 MB each at 200 concurrent jobs); set memory limits at 2x the
observed peak. Re-measure on your own hardware: `bun run lt:up && bun run loadtest -- --docker ...`.

## Alerts and metrics

`GET /metrics` (Prometheus, `Authorization: Bearer $METRICS_TOKEN`), rules in [`deploy/alerts.yml`](../deploy/alerts.yml).
Logs are one JSON object per line (`service`, `level`, `msg`, fields); workers log a `stats` line every 5 s.

## Backups

MongoDB is the only thing to back up.

```bash
MONGO_URI='mongodb://user:pass@mongo1:27017,mongo2:27017,mongo3:27017/?replicaSet=rs0&authSource=admin' \
  ./deploy/backup.sh /backups          # reads from a secondary; schedule it and ship the file off-host
```

**Restore** (tested: 140,007 emails restored identically):

```bash
mongorestore --uri "$MONGO_URI" --archive=/backups/emailq-<time>.archive.gz --gzip --drop
```

Restore into a scratch namespace first to check a backup: add `--nsFrom 'emailq.*' --nsTo 'emailq_restored.*'`.
After a restore, run `bun run requeue` so emails that were `queued` get jobs again (Redis does not need restoring).
Retention: emails are deleted after `EMAIL_RETENTION_DAYS` (default 30) by a TTL index; templates and attachment files
follow automatically.

## Incident playbooks

### Queue falling behind
`emailq_queue_oldest_waiting_age_seconds` high. 1) Are workers running (`docker ps`, `emailq_sent_total` rising)?
2) Is one account the cause? A tenant at its declared rate is *supposed* to wait (that is rate limiting); other
tenants are unaffected. 3) Otherwise add workers.

### Nothing is sending
In order: workers up? -> `/readyz` (MongoDB/Redis reachable)? -> SMTP accounts `health: "auth_failed"` or
`rate.pausedUntil` in the future (`GET /v1/smtp`)? Auth failures hold the account's mail (it is not lost): fix the
credentials with `PATCH /v1/smtp/:id`, which re-verifies and resumes sending.

### Redis lost data (wipe, failed disk, bad failover)
Nothing to do: the reaper notices released emails that are still `queued` with no live job (after
`RECONCILE_AFTER_MS`, default 3 min) and re-creates the jobs. Verified by wiping Redis during a 60k-email run
(`CHAOS_WIPE=1 bun run chaos`): 0 lost. To force it immediately: `bun run requeue -- --older-than 0`.

### MongoDB primary lost
The driver re-elects and retries writes automatically; API requests during the ~10 s election may return 5xx
(clients should retry with the same `Idempotency-Key`: replays are safe). Verified under load: 0 lost.

### Throttling (`emailq_throttled_total` rising)
The provider is rejecting faster than the declared rate. The adaptive controller already slows down and remembers
the limit it found (`rate.learnedLimitPerSec`); lower `limits.perSecond`/`perMinute` so it starts there.

### Failures rising
Permanent failures (`status: failed`, `lastError`) are bad recipients (auto-suppressed for that tenant) or provider
policy rejections. Hard bounces and spam complaints reported later arrive through the webhook as `bounced` /
`complained` and also suppress the recipient. Retried-out jobs stay in the BullMQ failed set for 7 days.

### Duplicates reported
Expected only after a hard kill of a worker. Confirm with the `X-Email-Id` header; graceful restarts produce none.

### API down
`/healthz` (process) vs `/readyz` (MongoDB + Redis). The API is stateless: restart or scale it freely.

## Secrets

* `JWT_SECRET`: rotating it signs everyone out (access tokens are 15 min; refresh tokens are opaque and unaffected).
* `ENCRYPTION_KEY` (protects stored SMTP passwords): rotate without downtime:
  1. `openssl rand -hex 32` -> new key.
  2. Deploy with `ENCRYPTION_KEY=<new> ENCRYPTION_KEY_ID=k2 ENCRYPTION_OLD_KEYS=k1:<old>`. Everything keeps working.
  3. `bun run rotate-keys` (idempotent, resumable; `--dry-run` counts).
  4. When it reports `remaining 0`, remove the old key from `ENCRYPTION_OLD_KEYS`.
* `LINK_SIGNING_KEY` signs unsubscribe links and webhook URLs. Those links live inside emails already delivered, so
  rotate by moving the current value into `LINK_SIGNING_OLD_KEYS` (verify-only) and setting a new `LINK_SIGNING_KEY`;
  old links keep working. Never drop an old key while mail carrying its links may still be read.

## Onboarding an SMTP provider

The tenant must declare `limits.perSecond` and/or `limits.perMinute` (and optionally `perDay`): SMTP cannot report
its own limits. Documented provider limits (Microsoft 365: 30/min, 10,000/day, 3 connections; Gmail Workspace:
2,000/day; SES sandbox: 1/s, 200/day) are shown as a hint in the create response. Daily limits at all three are rolling
24-hour windows, which is how the daily cap is enforced here.

For bounce/complaint feedback, configure the provider to POST to the `webhookUrl` returned for the account:
SES (via SNS HTTPS subscription, auto-confirmed), SendGrid Event Webhook, Mailgun webhooks, or the generic JSON format.

## Known quirk of the single-host Docker layout

After `docker kill` of a node that has a static IP (the Redis pair), Docker Desktop can keep the address reserved and
refuse to start the node again ("Address already in use"). That is a Docker networking artifact, not a Redis problem
(the replica was already promoted and traffic continued). Fix: `docker compose -p eqprod -f docker-compose.prod.yml --env-file .env.prod down && ... up -d`
(volumes persist; Sentinel demotes the returning node to a replica). On separate hosts or managed Redis this does not occur.

## Deploying the web app while people have it open

Every build gets new content-hashed file names, so a browser tab opened before the deploy still points at chunks that no
longer exist. Two safeguards make this a non-event: the API answers a missing `/assets/*` (or any path that looks like a
file) with a real **404**, never `index.html`; and the app, on a failed lazy chunk, **reloads once straight into the page
the user was opening**. If the chunk is still missing 30 seconds later it shows "A new version is available" with a Reload
button instead of looping. `index.html` is re-read when it changes, so a redeploy needs no API restart.
