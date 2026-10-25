# Load testing

How to measure what the system can do, what it costs in CPU and RAM, and what happens when the SMTP provider is slow,
throttling or changing. Everything here is reproducible with the commands shown.

* [Which test do I run?](#which-test-do-i-run)
* [The capacity model](#the-capacity-model)
* [`bun run loadtest`: options](#bun-run-loadtest-options)
* [Resource-limited stack (CPU / RAM min and max)](#resource-limited-stack-cpu--ram-min-and-max)
* [Reading the report](#reading-the-report)
* [Scenario cookbook](#scenario-cookbook)
* [The fake SMTP server (sink)](#the-fake-smtp-server-sink)
* [Other test tools: smoke, chaos, requeue](#other-test-tools)
* [Troubleshooting](#troubleshooting)

## Which test do I run?

| I want to know... | Run |
|---|---|
| Does one real delivery work end to end (headers, MIME, unsubscribe, bounce)? | `bun run smoke` |
| What throughput does my laptop reach, and does it lose mail? | `bun run loadtest -- --emails 100000 --per-second 20000` |
| Does it send **exactly** the rate I declare (e.g. 1,000/s)? | `bun run loadtest -- --emails 60000 --per-second 1000 --connections 50 --workers 4` |
| How much **CPU and RAM** does it use, and which service hits its limit first? | `bun run lt:up` then `bun run loadtest -- --docker ...` |
| What if the SMTP server is slow (3 s per mail), jittery or changing? | `--sink-latency`, `--sink-jitter`, `--timeline` |
| Does the controller find a provider's limit and recover when it is lifted? | `--sink-limit`, `--timeline "0:0:0:50,20:0:0:10,40:0:0:0"` |
| Does it survive crashes, a Redis wipe, a Mongo failover? | `bun run chaos` (and the production topology, see the [runbook](RUNBOOK.md)) |

## The capacity model

Each test prints what the system **should** reach so you compare a measurement with an expectation, not with a hope:

```
expected = min( declared rate ceiling ,  workers x connections / latency ,  SMTP server's own limit )
```

* **Declared rate** (`--per-second`): the ceiling the tenant promises the provider. The system never exceeds it.
* **Workers x connections / latency**: each worker process keeps a pool of `--connections` SMTP connections and a
  connection carries one message at a time. A server that needs 3 s per mail therefore absorbs at most
  `workers x connections / 3` per second no matter how high the declared rate is. *The declared rate is a ceiling,
  not a throughput.*
* **Sink limit** (`--sink-limit`): the fake provider rejects (451) anything above this per second; the adaptive
  controller must find it.

With zero latency and no sink limit, the expected rate is simply the declared ceiling, and the test shows how close the
pipeline gets to it.

## `bun run loadtest` options

`bun run loadtest -- <flags>` (the `--` is required so Bun passes the flags through). Flags are `--name value`.

### What to send

| Flag | Default | Meaning |
|---|---|---|
| `--emails` | `20000` | Total emails to submit (sent to the API in batches). |
| `--per-second` | `5000` | The **declared rate ceiling** of the test SMTP account (`limits.perSecond`). |
| `--connections` | `10` | The account's `maxConnections` (SMTP connections per worker process, max 50). |
| `--batch` | `1000` | Emails per API request (max 1000). |
| `--concurrency` | `8` | Parallel API requests while submitting. |

### What the SMTP server (sink) does

| Flag | Default | Meaning |
|---|---|---|
| `--sink-latency` | `0` | Milliseconds the fake server takes to answer each message (use `3000` for a 3 s provider). |
| `--sink-jitter` | `0` | Random ± milliseconds added to every answer (`3000` and `1500` gives 1.5 to 4.5 s). |
| `--sink-limit` | `0` | Provider-side rate limit per second; above it the sink replies `451` (0 = none). |
| `--timeline` | none | Changes the sink **during the run**. See below. |

**`--timeline "seconds:latencyMs[:jitterMs[:limitPerSec]],..."`** applies each step when the run reaches that second
(counted from the start of delivery). A missing `limitPerSec` leaves the limit unchanged; `0` removes it.

```
--timeline "0:200,15:3000,40:500,60:200"        latency 0.2 s, then 3 s at 15 s, 0.5 s at 40 s, 0.2 s at 60 s
--timeline "0:0:0:50,20:0:0:10,40:0:0:0"        provider limit 50/s, then 10/s at 20 s, then lifted at 40 s
--timeline "0:200:0:100,15:3000:500:20"         both at once: latency and limit change together
```

Each step prints a `>>>` line when it is applied. With a timeline there is no single expected rate, so the verdict does
not judge throughput (read the sparkline instead).

### Where and how to run it

| Flag | Default | Meaning |
|---|---|---|
| `--docker` | off | Use the resource-limited stack: API `http://localhost:3200`, sink control `http://localhost:2626`, SMTP host `sink`, project `emailq-lt`; samples CPU/RAM of every container; counts the worker containers for the model. |
| `--docker-project` | `emailq-lt` with `--docker` | Compose project to sample (any project works, for example your own deployment). |
| `--workers` | auto with `--docker`, else `1` | Number of worker **processes**, used only for the capacity model. Set it to what is really running. |
| `--api` | `http://localhost:3100` | API base URL. |
| `--sink-http` | `http://localhost:2526` | The sink's control port (`/stats`, `/config`, `/reset`). |
| `--sink-host` | `localhost` (`sink` with `--docker`) | The host the **API and workers** use to reach the sink (as seen from where they run). |
| `--sink-port` | `2525` | The sink's SMTP port as seen from the workers. |
| `--metrics-token` | `$METRICS_TOKEN` | Bearer token for `/metrics` if you protected it (queue gauges come from there). |
| `--timeout` | `1800` | Give up after this many seconds. |
| `--report` | none | Also save the final report as plain text to this file. |

Exit code: `0` when every email was delivered exactly as accounted for, `1` otherwise (usable in CI).

## Resource-limited stack (CPU / RAM min and max)

`docker-compose.loadtest.yml` runs the **whole system in containers, each with production-style limits**, next to your
normal dev setup (API on `3200`, sink on `2625`/`2626`; MongoDB and Redis are not published).

```bash
bun run lt:up                                                      # build, start, wait until healthy
bun run loadtest -- --docker --emails 60000 --per-second 1000 --connections 50 --report report.txt
bun run lt:down                                                    # stop and delete its data
```

Every limit is an environment variable and applies **per container**:

| Service | Variables (defaults) | Notes |
|---|---|---|
| worker | `WORKER_REPLICAS` (4), `WORKER_CPUS` (1.0), `WORKER_CPUS_MIN` (0.5), `WORKER_MEM` (512m), `WORKER_MEM_MIN` (256m) | total worker capacity = replicas x cpus |
| api | `API_CPUS` (1.0), `API_CPUS_MIN` (0.25), `API_MEM` (512m), `API_MEM_MIN` (128m) | |
| relay | `RELAY_CPUS` (0.5), `RELAY_CPUS_MIN` (0.1), `RELAY_MEM` (384m), `RELAY_MEM_MIN` (128m) | |
| reaper | `REAPER_CPUS` (0.25), `REAPER_CPUS_MIN` (0.05), `REAPER_MEM` (256m), `REAPER_MEM_MIN` (64m) | |
| mongo | `MONGO_CPUS` (2.0), `MONGO_CPUS_MIN` (1.0), `MONGO_MEM` (2g), `MONGO_MEM_MIN` (1g) | |
| redis | `REDIS_CPUS` (1.0), `REDIS_CPUS_MIN` (0.25), `REDIS_MEM` (512m), `REDIS_MEM_MIN` (128m) | |
| sink | `SINK_CPUS` (1.0), `SINK_CPUS_MIN` (0.25), `SINK_MEM` (256m), `SINK_MEM_MIN` (64m) | the fake SMTP server |
| ports | `API_PORT` (3200), `SINK_SMTP_PORT` (2625), `SINK_HTTP_PORT` (2626) | change if a port is taken |
| app tuning | `WORKER_CONCURRENCY` (200), `LOG_LEVEL` (warn) | |

* **MAX** is a hard cap: CPU is throttled at it, and a container that exceeds its memory max is OOM-killed (the
  report names it).
* **MIN** is a reservation. Docker enforces the memory reservation; outside Swarm it does not enforce a CPU minimum, so
  the `*_CPUS_MIN` values document intent.

Set variables for one run in the same line (Windows `cmd`; use `export` on macOS/Linux):

```
set WORKER_CPUS=0.5&& set WORKER_MEM=256m&& set WORKER_REPLICAS=8&& bun run lt:up
```

Changing a limit means recreating the stack: `bun run lt:down` then `bun run lt:up` with the new values.

## Reading the report

The run prints one line per second while it works, then a report. Real output (60,000 emails, 8 workers at 0.5 CPU /
256 MB, MongoDB 2 CPU / 2 GB):

```
╔══ LOAD TEST phu6yj ═════════════════════════════════════════════════════════════════════════
  scenario          60,000 emails · ceiling 1,000/s · 8 worker(s) × 50 SMTP connections
  SMTP server       latency 0 ms · limit none

THROUGHPUT ─────────────────────────────────────────────────────────────────────────────────
  steady-state          924.1 /s   ██████████████████░░ 92% of the 1,000.0/s this setup should reach  ✔
  overall               855.9 /s   (60,000 in 70.1 s, includes ramp-up and tail)
  per second        min 835 · median 926 · max 1,000   (steady window)
  API intake        15,092 emails/s   (60 batches, p50 523 ms, p95 748 ms)
  over time         ▃▄▆█▇▇▇▇▇▇▇▇▇▆▇▇▇▇▇▇█▇▇▇▇▇▇▇▇▇▇██▇▇▇▇▇▇██▇▇▇▇▇▇█▇█▇▇▇▇▇▇█▇▇▇

DELIVERY ───────────────────────────────────────────────────────────────────────────────────
  delivered         60,000 / 60,000   ✔
  lost              0   ✔
  duplicates        0   ✔
  failed            0   ✔
  retries           deferred 0 · throttled 0 · transient 0
  adaptive rate     settled at 1,000.0/s of the 1,000/s ceiling

PIPELINE ───────────────────────────────────────────────────────────────────────────────────
  queue             peak ready 64 · oldest ready job waited 0 s · peak "sending" 111
  SMTP server saw   peak 217 connections · peak 62 messages in flight (pool cap 400)

RESOURCES (docker stats; CPU 100% = one full core) ─────────────────────────────────────────
  SERVICE  ×    CPU MAX   AVG  PEAK  PEAK / MAX           RAM MIN – MAX      AVG     PEAK  PEAK / MAX
  api      1  1.00 core    4%   48%  ████░░░░ 48%     128 MiB – 512 MiB   68 MiB  126 MiB  ██░░░░░░ 25%
  mongo    1  2.00 core  114%  209%  ████████ 105%  1.00 GiB – 2.00 GiB  419 MiB  580 MiB  ██░░░░░░ 28%
  worker   8  0.50 core   24%   48%  ████████ 95%     256 MiB – 256 MiB   94 MiB  125 MiB  ████░░░░ 49%
  ...
  whole stack: CPU avg 363% (≈ 3.6 cores) · peak 542%   RAM avg 1.35 GiB · peak 1.54 GiB
  cost: the app used 2.07 cores on average ≈ 447 emails/s per core
⚠ mongo used 105% of its CPU limit: it is the likely bottleneck, raise its cpus or add replicas

⚠ PASS WITH WARNINGS
```

| Section | What it tells you |
|---|---|
| **steady-state** | Rate over the middle half of the run (skips ramp-up and tail), against what the setup should reach. The bar and the ✔ / ⚠ / ✘ are green at 90% and above, warning from 70%, failure below. |
| **overall** | Total emails divided by total time; lower than steady-state because of ramp-up and the tail. |
| **per second / over time** | Spread of the one-second rates in the steady window, and a sparkline of the whole run. |
| **delivered / lost / duplicates** | Judged by the **sink's own count of unique messages**, not by the app's claim. `lost = emails sent to the API - unique received`. |
| **retries** | `deferred` (waiting for a slot or pause), `throttled` (provider said slow down), `transient` (temporary errors retried). |
| **adaptive rate** | Where the controller ended up versus the ceiling. Below the ceiling after a throttling scenario is expected. |
| **queue** | `ready` = jobs waiting for a worker (should stay near 0 when workers keep up); `oldest` = age of the oldest waiting job; `sending` = emails currently claimed. |
| **SMTP server saw** | The concurrency the provider actually experienced, against the pool cap (`workers x connections`). |
| **RESOURCES** | Per service: replicas, CPU and RAM limits, average and peak use, and **peak as a percentage of the limit**. CPU % is of one core, so 200% is two cores busy. A restart or OOM kill is shown in the last column. |
| **whole stack / cost** | Total CPU and RAM, and emails per second per CPU core used by the app (use it to size production: cores needed ≈ target rate ÷ that number, plus headroom). |
| **warnings** | A service at 85% of its CPU limit or 90% of its RAM limit; the verdict is **PASS**, **PASS WITH WARNINGS** or **FAIL** (loss, duplicates, failures, an OOM kill or throughput below 70%). |

How the resource numbers are obtained: while the test runs, the script calls `docker stats --no-stream` for every
container in the compose project about once every 1 to 2 seconds, and reads each container's configured limits with
`docker inspect`. The report is built from those samples.

## Scenario cookbook

Use a clean stack (`bun run lt:up`, or the isolated dev stack below) so leftovers from an earlier run cannot affect the numbers.

```bash
# 1. Does it hold exactly the declared rate? (peak load)
bun run loadtest -- --docker --emails 60000 --per-second 1000 --connections 50

# 2. Where does it flatten? Raise the ceiling until steady-state stops growing: that is your hardware's limit.
bun run loadtest -- --docker --emails 150000 --per-second 3000 --connections 50

# 3. A slow provider: 3 s per email, 10 connections, 2 workers  ->  expect workers x connections / latency = 6.7/s
bun run loadtest -- --emails 300 --per-second 100 --sink-latency 3000 --connections 10 --workers 2

# 4. Slow and jittery
bun run loadtest -- --emails 300 --per-second 100 --sink-latency 3000 --sink-jitter 1500 --connections 10 --workers 2

# 5. Latency that changes mid-run (fast, then slow, then medium, then fast)
bun run loadtest -- --emails 1200 --per-second 100 --connections 10 --workers 2 --timeline "0:200,5:3000,30:500,45:200"

# 6. The provider throttles at 50/s although you declared 500/s: the controller must find it
bun run loadtest -- --emails 20000 --per-second 500 --sink-limit 50

# 7. The provider's limit changes live: 50/s, then 10/s, then lifted (watch the 451s and the recovery)
bun run loadtest -- --emails 3000 --per-second 500 --timeline "0:0:0:50,20:0:0:10,40:0:0:0"

# 8. A provider with few connections (Microsoft 365 allows 3): only 2 x 3 emails are ever claimed, no duplicates
bun run loadtest -- --emails 320 --per-second 100 --sink-latency 3000 --connections 3 --workers 2

# 9. Squeeze the workers and watch the CPU limit become the bottleneck
set WORKER_CPUS=0.25&& set WORKER_MEM=128m&& bun run lt:up
bun run loadtest -- --docker --emails 20000 --per-second 1000 --connections 50
```

Measured results for these are in the [README](../README.md#measured).

**What to expect**

* After a throttle, recovery is gradual by design (about 5% per second above the learned limit): a run shorter than a
  minute will end before the rate is back to the ceiling. That is the controller protecting the provider, not a stall.
* A server slower than the 30 s SMTP socket timeout cannot be served: every attempt times out on our side while the
  provider may still accept the mail, so retries create duplicates (same `Message-ID`, so receivers can dedupe).
* The declared rate limits the system, but the workers' CPU, MongoDB's CPU and the connection pool can limit it first.
  The RESOURCES table shows which.

### An isolated dev stack (no Docker limits)

To keep a load test away from your normal development data, give it its own database, Redis DB and ports:

```
set MONGO_DB=emailq_lt&& set REDIS_URL=redis://localhost:6379/5&& set AUTH_RATE_LIMIT_SCALE=100&& set PORT=3200&& set SINK_PORT=2625&& set SINK_HTTP_PORT=2626&& set DEMO_SMTP_PORT=2625&& set WORKER_PROCESSES=4&& bun run dev
```

then pass `--api http://localhost:3200 --sink-http http://localhost:2626 --sink-port 2625 --workers 4`.
Stopping the load test script does **not** stop delivery: emails already accepted keep sending until done. Start the
next run on a clean stack.

## The fake SMTP server (sink)

`bun run sink` (started automatically by `bun run dev` and the load-test stack) is a raw-socket SMTP server that
accepts everything, remembers each message, and can behave like a slow or throttling provider. It also counts unique
messages itself, which is how loss and duplicates are judged.

| Environment variable | Default | Meaning |
|---|---|---|
| `SINK_PORT` | `2525` | SMTP port |
| `SINK_HTTP_PORT` | `2526` | Control port |
| `SINK_LIMIT_PER_SEC` | `0` | Reply `451` above this many messages per second (0 = unlimited) |
| `SINK_LATENCY_MS` | `0` | Delay before accepting each message |
| `SINK_JITTER_MS` | `0` | Random ± added to that delay |

Control port (change behaviour while it runs, no restart):

```bash
curl -X POST "http://localhost:2526/config?limit=20&latency=3000&jitter=1000"   # any subset of limit, latency, jitter
curl -X POST "http://localhost:2526/config?limit=0"                             # remove the limit
curl http://localhost:2526/stats                                                # accepted, unique, duplicates, 451s, peaks
curl http://localhost:2526/last                                                 # the most recent raw messages
curl -X POST http://localhost:2526/reset                                        # zero the counters
```

## Other test tools

| Command | What it does |
|---|---|
| `bun run smoke` | Registers, adds an SMTP account, sends a bulk mail with an attachment and variables, then verifies the **raw message** the server received (headers, MIME, rendered template, one-click unsubscribe, stable Message-ID), posts the unsubscribe and a bounce webhook, and checks the API reacts. Options: `--api`, `--sink-http`, `--sink-host` (use `host.docker.internal` when the workers run in Docker). |
| `bun run chaos -- --emails 60000` | Runs a load test and breaks the system while it runs: SIGKILL all workers at +8 s, restart Redis at +16 s, SIGKILL the relay at +30 s. PASS means **0 emails lost** (duplicates are tolerated; delivery is at-least-once). `CHAOS_WIPE=1` wipes Redis entirely instead of restarting it. `REDIS_CONTAINER` / `MONGO_CONTAINER` name the containers (default `email-queue-system-redis-1` / `-mongo-1`). |
| `bun run requeue [-- --older-than <minutes>]` | Disaster recovery: rebuilds queue jobs from MongoDB for `queued` emails older than N minutes (default 5; `0` = all). Safe to run twice. |
| `bun run rotate-keys [-- --dry-run]` | Re-encrypts stored SMTP passwords under the current key (see the runbook). |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ports are not available ... 2626` on `lt:up` | Another process holds the port (often a leftover dev stack). Stop it, or change `API_PORT`, `SINK_SMTP_PORT`, `SINK_HTTP_PORT`. Find the owner with `netstat -ano \| findstr :2626`. |
| `LOSS` is negative, or the sink's `unique` is larger than `--emails` | Mail from an earlier run is still being delivered to the same sink. Wait until `curl localhost:2626/stats` stops changing, or use `lt:down` / a fresh stack. |
| The first seconds show `0/s` after the sink limit appears | The provider rejected a burst; the controller paused and is recovering. Expected after a throttle; look at `451s=` and the adaptive rate. |
| Throughput stays below the ceiling and the workers are idle | Look at the RESOURCES table: MongoDB (or the load script / sink on the same machine) is usually at its CPU limit. Raise `MONGO_CPUS`. |
| `no running containers found for compose project` | `--docker` found nothing. Run `bun run lt:up` first, or pass the right `--docker-project`. |
| After `FLUSHALL` on Redis, old emails reappear | MongoDB still holds them as `queued` and the reaper re-creates their jobs by design. Delete the old test accounts or use a fresh database (`lt:down`). |
| Docker build is slow the first time | It builds the web app and the server image once; later runs reuse the cache. |
