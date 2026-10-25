/**
 * End-to-end load test against a running stack (api + relay + worker(s) + mongo + redis + smtp-sink).
 *
 *   bun run loadtest -- --emails 100000 --per-second 5000
 *   bun run loadtest -- --emails 20000 --per-second 500 --sink-limit 50          # adaptive-rate demo
 *   bun run loadtest -- --emails 300 --per-second 100 --sink-latency 3000 --connections 10 --workers 2
 *       # a SLOW SMTP server (3 s per email): throughput is bound by connections / latency, not by the rate limit
 *   bun run loadtest -- --emails 600 --sink-latency 200 --timeline "0:200,15:3000,40:500,60:200"
 *       # latency that CHANGES during the run (seconds:latencyMs[:jitterMs[:sinkLimitPerSec]], relative to the start of delivery)
 *   bun run loadtest -- --emails 3000 --per-second 500 --timeline "0:0:0:50,20:0:0:10,40:0:0:0"
 *       # the SMTP server's rate limit changes live: 50/s, then 10/s, then none (0)
 *
 * With resource limits (CPU / RAM per container, like production):
 *   bun run lt:up                                  # docker-compose.loadtest.yml: every service has min/max CPU and RAM
 *   bun run loadtest -- --docker --emails 60000 --per-second 1000 --connections 50
 *   (--docker = the loadtest stack's ports + sampling docker stats; see docker-compose.loadtest.yml for the knobs)
 *
 * Reports: throughput vs the capacity model, delivery correctness (the sink's ground truth), queue behaviour, the
 * concurrency the SMTP server saw, and, with --docker, CPU / memory per service against its limits.
 * loss = emails sent to the API - unique received. --report <file> also saves the report as text.
 */
import { writeFileSync } from "node:fs";
import { DockerMonitor } from "./docker-monitor.ts";
import { bar, bytes, fmt, type Level, MARK, painter, spark, table } from "./report.ts";

// The API and the sink return loosely typed JSON; a load test only reads a few fields, so a loose type is deliberate.
// biome-ignore lint/suspicious/noExplicitAny: loadtest reads untyped JSON
type ApiJson = Record<string, any>;
interface SinkStats {
  unique: number;
  duplicates: number;
  rateLimited: number;
  peakPerSec: number;
  inflight: number;
  peakInflight: number;
  openConnections: number;
  peakConnections: number;
  latencyMs: number;
  jitterMs: number;
}
const argv = process.argv.slice(2);
const arg = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? (argv[i + 1] ?? def) : def;
};

const DOCKER = argv.includes("--docker");
const API = arg("api", DOCKER ? "http://localhost:3200" : "http://localhost:3100");
const SINK_HTTP = arg("sink-http", DOCKER ? "http://localhost:2626" : "http://localhost:2526");
const SINK_HOST = arg("sink-host", DOCKER ? "sink" : "localhost"); // the host the API/worker uses to reach the sink
const SINK_PORT = Number(arg("sink-port", "2525"));
const DOCKER_PROJECT = arg("docker-project", DOCKER ? "emailq-lt" : "");
const N = Number(arg("emails", "20000"));
const PER_SECOND = Number(arg("per-second", "5000"));
const SINK_LIMIT = Number(arg("sink-limit", "0"));
const SINK_LATENCY = Number(arg("sink-latency", "0"));
const SINK_JITTER = Number(arg("sink-jitter", "0"));
const TIMELINE = arg("timeline", "");
const BATCH = Math.min(Number(arg("batch", "1000")), 1000);
const CONCURRENCY = Number(arg("concurrency", "8"));
const CONNECTIONS = Number(arg("connections", "10"));
const TIMEOUT_S = Number(arg("timeout", "1800"));
const METRICS_TOKEN = arg("metrics-token", process.env.METRICS_TOKEN ?? "");
const REPORT_FILE = arg("report", "");

const monitor = DOCKER_PROJECT ? new DockerMonitor(DOCKER_PROJECT) : undefined;
const containers = (await monitor?.discover()) ?? [];
if (DOCKER_PROJECT && containers.length === 0) {
  console.warn(`! no running containers found for compose project "${DOCKER_PROJECT}": resource usage will not be reported`);
}
// worker PROCESSES running (each has its own SMTP pool); used for the capacity model. Detected from docker when possible.
const WORKERS = Number(arg("workers", String(containers.filter((c) => c.service === "worker").length || 1)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;

async function api(path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const res = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json as ApiJson;
}

const sinkStats = async () => (await (await fetch(`${SINK_HTTP}/stats`)).json()) as SinkStats;
const setSink = (q: Record<string, number>) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) params.set(k, String(v));
  return fetch(`${SINK_HTTP}/config?${params}`, { method: "POST" });
};

/** Prometheus text -> { "name{labels}": value }. Only what we need; returns {} when /metrics is protected or down. */
async function readMetrics(): Promise<Record<string, number>> {
  try {
    const res = await fetch(`${API}/metrics`, { headers: METRICS_TOKEN ? { authorization: `Bearer ${METRICS_TOKEN}` } : {} });
    if (!res.ok) return {};
    const out: Record<string, number> = {};
    for (const line of (await res.text()).split("\n")) {
      const m = line.match(/^(emailq_[^ ]+) ([0-9.eE+-]+)$/);
      if (m) out[m[1]!] = Number(m[2]);
    }
    return out;
  } catch {
    return {};
  }
}

/** "0:200,15:3000:500:20" -> at +15s latency 3000ms, jitter 500ms, sink limit 20/s (limit omitted = unchanged) */
const timeline = TIMELINE.split(",")
  .filter(Boolean)
  .map((p) => {
    const [at, latency, jitter, limit] = p.split(":").map(Number);
    return { at: at ?? 0, latency: latency ?? 0, jitter: jitter ?? 0, limit };
  })
  .sort((a, b) => a.at - b.at);

/**
 * The capacity model. Each worker process keeps a pool of `connections` SMTP connections and a connection handles one
 * message at a time, so a server that takes L seconds per message can absorb at most workers x connections / L per
 * second no matter how high the declared rate limit is. The declared rate is a ceiling, not a throughput.
 */
const capacity = (latencyMs: number) => (latencyMs <= 0 ? PER_SECOND : Math.min(PER_SECOND, (WORKERS * CONNECTIONS) / (latencyMs / 1000)));

const runId = Math.random().toString(36).slice(2, 8);
console.log(
  `== load test ${runId}: ${fmt(N)} emails, declared ceiling ${fmt(PER_SECOND)}/s, ${CONNECTIONS} connections x ${WORKERS} worker process(es), ` +
    `sink latency ${SINK_LATENCY}ms${SINK_JITTER ? ` +/-${SINK_JITTER}` : ""}, sink limit ${SINK_LIMIT || "none"}/s ==`,
);
console.log(
  `capacity model: min(${PER_SECOND}/s, ${WORKERS} x ${CONNECTIONS} / latency) = ${capacity(SINK_LATENCY).toFixed(1)}/s at the start`,
);
for (const t of timeline)
  console.log(
    `  timeline: at +${t.at}s latency ${t.latency}ms${t.jitter ? ` +/-${t.jitter}` : ""}${t.limit === undefined ? "" : `, sink limit ${t.limit || "none"}/s`} -> capacity ${capacity(t.latency).toFixed(1)}/s`,
  );

await fetch(`${SINK_HTTP}/reset`, { method: "POST" });
await setSink({ limit: SINK_LIMIT, latency: SINK_LATENCY, jitter: SINK_JITTER });

const reg = await api("/v1/auth/register", { email: `load-${runId}@example.com`, password: "load-test-password-123" });
const token: string = reg.accessToken;
const smtp = await api(
  "/v1/smtp",
  {
    name: "sink",
    host: SINK_HOST,
    port: SINK_PORT,
    secure: false,
    username: "load",
    password: "load",
    fromEmail: "sender@example.com",
    limits: { perSecond: PER_SECOND },
    maxConnections: CONNECTIONS,
  },
  token,
);
console.log(`smtp account ${smtp.id}: ceiling=${smtp.rate.ceilingPerSec}/s startingAt=${smtp.rate.currentPerSec ?? "n/a"}/s`);

const before = await readMetrics();
monitor?.start();

// ---- phase 1: blast the API ----
const batches = Math.ceil(N / BATCH);
const latencies: number[] = [];
let next = 0;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const b = next++;
      if (b >= batches) return;
      const from = b * BATCH;
      const count = Math.min(BATCH, N - from);
      const s = performance.now();
      await api(
        "/v1/emails/batch",
        {
          smtpId: smtp.id,
          priority: "bulk",
          subject: "Load test {{n}}",
          text: "Hello {{name}}, this is load test message {{n}}.",
          recipients: Array.from({ length: count }, (_, i) => ({
            to: `user${from + i}@example.com`,
            vars: { name: `User ${from + i}`, n: String(from + i) },
          })),
        },
        token,
        { "idempotency-key": `${runId}-batch-${b}` },
      );
      latencies.push(performance.now() - s);
    }
  }),
);
const acceptSec = (performance.now() - t0) / 1000;
console.log(
  `API accepted ${fmt(N)} emails in ${acceptSec.toFixed(2)}s = ${fmt(N / acceptSec)} emails/s ` +
    `(${batches} batch requests, p50=${pct(latencies, 0.5).toFixed(0)}ms p95=${pct(latencies, 0.95).toFixed(0)}ms)`,
);

// ---- phase 2: wait for delivery, applying the latency timeline and sampling the whole pipeline ----
const samples: Array<{ t: number; sent: number }> = [];
const rates: number[] = []; // emails/s for each one-second sample
let maxReady = 0;
let maxOldest = 0;
let maxSending = 0;
let appliedStep = -1;
let lastSent = 0;
let lastT = performance.now();
let done = false;

while (!done && (performance.now() - t0) / 1000 < TIMEOUT_S) {
  await sleep(1000);
  const elapsed = (performance.now() - t0) / 1000;
  while (appliedStep + 1 < timeline.length && timeline[appliedStep + 1]!.at <= elapsed) {
    const step = timeline[++appliedStep]!;
    await setSink({ latency: step.latency, jitter: step.jitter, ...(step.limit === undefined ? {} : { limit: step.limit }) });
    console.log(
      `  >>> t=${elapsed.toFixed(0)}s sink latency is now ${step.latency}ms${step.jitter ? ` +/-${step.jitter}` : ""}${step.limit === undefined ? "" : `, limit ${step.limit || "none"}/s`} (model: ${capacity(step.latency).toFixed(1)}/s)`,
    );
  }

  const [{ counts }, sink, metrics] = await Promise.all([api("/v1/stats", undefined, token), sinkStats(), readMetrics()]);
  const now = performance.now();
  const rate = ((counts.sent - lastSent) / (now - lastT)) * 1000;
  lastSent = counts.sent;
  lastT = now;
  samples.push({ t: elapsed, sent: counts.sent });
  rates.push(rate);

  const ready = metrics['emailq_queue_jobs{lane="bulk",state="waiting"}'] ?? 0;
  const delayed = metrics['emailq_queue_jobs{lane="bulk",state="delayed"}'] ?? 0;
  const oldest = metrics['emailq_queue_oldest_waiting_age_seconds{lane="bulk"}'] ?? 0;
  maxReady = Math.max(maxReady, ready);
  maxOldest = Math.max(maxOldest, oldest);
  maxSending = Math.max(maxSending, counts.sending);

  const live = monitor && monitor.latest.mem > 0 ? ` | cpu=${fmt(monitor.latest.cpu)}% mem=${bytes(monitor.latest.mem)}` : "";
  console.log(
    `  t=${elapsed.toFixed(0).padStart(3)}s sent=${String(counts.sent).padStart(6)} (${rate.toFixed(1).padStart(6)}/s) queued=${counts.queued} sending=${counts.sending} failed=${counts.failed} | ` +
      `ready=${ready} delayed=${delayed} oldest=${oldest.toFixed(0)}s | sink: inflight=${sink.inflight} conns=${sink.openConnections} 451s=${sink.rateLimited} dup=${sink.duplicates}${live}`,
  );
  done = counts.queued === 0 && counts.sending === 0 && counts.sent + counts.failed === N;
}

const total = (performance.now() - t0) / 1000;
await monitor?.stop();
const { counts } = await api("/v1/stats", undefined, token);
const sink = await sinkStats();
const finalSmtp = await api(`/v1/smtp/${smtp.id}`, undefined, token);
await sleep(6000); // workers flush their counters to Redis every 5 s
const after = await readMetrics();
const delta = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
const usage = monitor ? await monitor.summary() : undefined;

// steady-state throughput: the middle half of the run (skips ramp-up and the tail)
const lo = samples[Math.floor(samples.length * 0.25)];
const hi = samples[Math.floor(samples.length * 0.75)];
const steady = lo && hi && hi.t > lo.t ? (hi.sent - lo.sent) / (hi.t - lo.t) : counts.sent / total;
const midRates = rates.slice(Math.floor(rates.length * 0.25), Math.max(Math.ceil(rates.length * 0.75), 1));
// what the system should be able to do: the lowest of declared ceiling, connections / latency and the sink's own limit
const expected = timeline.length === 0 ? Math.min(capacity(SINK_LATENCY), SINK_LIMIT > 0 ? SINK_LIMIT : Number.POSITIVE_INFINITY) : null;

const lost = N - sink.unique - counts.failed;

// ---- the report ----
function render(color: boolean): string[] {
  const p = painter(color);
  const mark = (level: Level, text: string) => p.level(level, `${MARK[level]} ${text}`);
  const W = 100;
  const title = ` LOAD TEST ${runId} `;
  const out: string[] = [];
  const section = (name: string) => out.push("", p.bold(`${name} ${"─".repeat(Math.max(W - name.length - 1, 4))}`));
  const kv = (k: string, v: string) => out.push(`  ${k.padEnd(18)}${v}`);

  out.push(p.bold(`╔${"═".repeat(2)}${title}${"═".repeat(Math.max(W - title.length - 3, 4))}`));
  kv("scenario", `${fmt(N)} emails · ceiling ${fmt(PER_SECOND)}/s · ${WORKERS} worker(s) × ${CONNECTIONS} SMTP connections`);
  kv(
    "SMTP server",
    `latency ${SINK_LATENCY} ms${SINK_JITTER ? ` ±${SINK_JITTER}` : ""} · limit ${SINK_LIMIT ? `${SINK_LIMIT}/s` : "none"}${timeline.length ? ` · ${timeline.length} timed changes` : ""}`,
  );

  // throughput
  section("THROUGHPUT");
  const ratio = expected ? steady / expected : null;
  const tpLevel: Level = ratio === null ? "ok" : ratio >= 0.9 ? "ok" : ratio >= 0.7 ? "warn" : "fail";
  kv(
    "steady-state",
    `${fmt(steady, 1).padStart(9)} /s   ${ratio === null ? "" : `${bar(ratio)} ${fmt(ratio * 100)}% of the ${fmt(expected ?? 0, 1)}/s this setup should reach  ${mark(tpLevel, "")}`}`.trimEnd(),
  );
  kv(
    "overall",
    `${fmt(counts.sent / total, 1).padStart(9)} /s   (${fmt(counts.sent)} in ${total.toFixed(1)} s, includes ramp-up and tail)`,
  );
  if (midRates.length > 0)
    kv(
      "per second",
      `min ${fmt(Math.min(...midRates))} · median ${fmt(pct(midRates, 0.5))} · max ${fmt(Math.max(...midRates))}   (steady window)`,
    );
  kv(
    "API intake",
    `${fmt(N / acceptSec)} emails/s   (${batches} batches, p50 ${pct(latencies, 0.5).toFixed(0)} ms, p95 ${pct(latencies, 0.95).toFixed(0)} ms)`,
  );
  if (rates.length > 1) kv("over time", spark(rates));

  // delivery
  section("DELIVERY");
  const okDelivery = lost === 0 && sink.duplicates === 0 && counts.failed === 0;
  kv("delivered", `${fmt(counts.sent)} / ${fmt(N)}   ${mark(counts.sent === N ? "ok" : "fail", "")}`.trimEnd());
  kv("lost", `${fmt(lost)}   ${mark(lost === 0 ? "ok" : "fail", "")}`.trimEnd());
  kv("duplicates", `${fmt(sink.duplicates)}   ${mark(sink.duplicates === 0 ? "ok" : "fail", "")}`.trimEnd());
  kv("failed", `${fmt(counts.failed)}   ${mark(counts.failed === 0 ? "ok" : "fail", "")}`.trimEnd());
  kv(
    "retries",
    `deferred ${fmt(delta("emailq_deferred_total"))} · throttled ${fmt(delta("emailq_throttled_total"))} · transient ${fmt(delta("emailq_transient_total"))}`,
  );
  kv("adaptive rate", `settled at ${fmt(finalSmtp.rate.currentPerSec ?? 0, 1)}/s of the ${fmt(finalSmtp.rate.ceilingPerSec)}/s ceiling`);
  out.push(p.dim("  (the SMTP sink counts unique messages itself, so loss and duplicates are ground truth, not the app's own claim)"));

  // pipeline
  section("PIPELINE");
  kv("queue", `peak ready ${fmt(maxReady)} · oldest ready job waited ${maxOldest.toFixed(0)} s · peak "sending" ${fmt(maxSending)}`);
  kv(
    "SMTP server saw",
    `peak ${fmt(sink.peakConnections)} connections · peak ${fmt(sink.peakInflight)} messages in flight (pool cap ${fmt(WORKERS * CONNECTIONS)})`,
  );

  // resources
  let resourceWarn = false;
  let resourceFail = false;
  if (usage && usage.services.length > 0) {
    section("RESOURCES (docker stats; CPU 100% = one full core)");
    const rows = usage.services.map((s) => {
      const cpuFrac = s.cpuLimit > 0 ? s.cpuPeak / (s.cpuLimit * 100) : 0;
      const memFrac = s.memLimit > 0 ? s.memPeak / s.memLimit : 0;
      if (cpuFrac >= 0.85) resourceWarn = true;
      if (memFrac >= 0.9) resourceWarn = true;
      if (s.oomKilled > 0) resourceFail = true;
      return [
        s.service,
        String(s.replicas),
        s.cpuLimit > 0 ? `${s.cpuLimit.toFixed(2)} core` : "none",
        `${fmt(s.cpuAvg)}%`,
        `${fmt(s.cpuPeak)}%`,
        s.cpuLimit > 0 ? `${bar(cpuFrac, 8)} ${fmt(cpuFrac * 100)}%` : "-",
        s.memLimit > 0 ? `${s.memReservation > 0 ? bytes(s.memReservation) : "-"} – ${bytes(s.memLimit)}` : "none",
        bytes(s.memAvg),
        bytes(s.memPeak),
        s.memLimit > 0 ? `${bar(memFrac, 8)} ${fmt(memFrac * 100)}%` : "-",
        s.oomKilled > 0 ? `OOM-killed ×${s.oomKilled}` : s.restarts > 0 ? `${s.restarts} restarts` : "",
      ];
    });
    out.push(
      ...table(["SERVICE", "×", "CPU MAX", "AVG", "PEAK", "PEAK / MAX", "RAM MIN – MAX", "AVG", "PEAK", "PEAK / MAX", ""], rows, [
        "l",
        "r",
        "r",
        "r",
        "r",
        "l",
        "r",
        "r",
        "r",
        "l",
        "l",
      ]).map((l) => `  ${l}`),
    );
    out.push(
      "",
      `  whole stack: CPU avg ${fmt(usage.total.cpuAvg)}% (≈ ${(usage.total.cpuAvg / 100).toFixed(1)} cores) · peak ${fmt(usage.total.cpuPeak)}%   ` +
        `RAM avg ${bytes(usage.total.memAvg)} · peak ${bytes(usage.total.memPeak)}`,
    );
    const appServices = usage.services.filter((s) => ["api", "relay", "worker", "reaper"].includes(s.service));
    const appCores = appServices.reduce((a, s) => a + (s.cpuAvg * s.replicas) / 100, 0);
    if (appCores > 0.05 && steady > 0) {
      out.push(
        `  cost: the app (api + relay + workers + reaper) used ${appCores.toFixed(2)} cores on average ≈ ${fmt(steady / appCores)} emails/s per core`,
        p.dim("        (size production from this: cores needed ≈ target emails/s ÷ that number, plus headroom)"),
      );
    }
    for (const s of usage.services) {
      if (s.cpuLimit > 0 && s.cpuPeak / (s.cpuLimit * 100) >= 0.85)
        out.push(
          mark(
            "warn",
            `${s.service} used ${fmt((s.cpuPeak / (s.cpuLimit * 100)) * 100)}% of its CPU limit: it is the likely bottleneck, raise its cpus or add replicas`,
          ),
        );
      if (s.memLimit > 0 && s.memPeak / s.memLimit >= 0.9)
        out.push(mark("warn", `${s.service} used ${fmt((s.memPeak / s.memLimit) * 100)}% of its memory limit: close to being OOM-killed`));
      if (s.oomKilled > 0) out.push(mark("fail", `${s.service} was OOM-killed: raise its memory limit`));
    }
  }

  // verdict
  const level: Level = !okDelivery || resourceFail || tpLevel === "fail" ? "fail" : tpLevel === "warn" || resourceWarn ? "warn" : "ok";
  const text = { ok: "PASS", warn: "PASS WITH WARNINGS", fail: "FAIL" }[level];
  out.push("", p.bold(p.level(level, `${MARK[level]} ${text}`)), "");
  return out;
}

console.log(`\n${render(Boolean(process.stdout.isTTY) && !process.env.NO_COLOR).join("\n")}`);
if (REPORT_FILE) {
  writeFileSync(REPORT_FILE, `${render(false).join("\n")}\n`);
  console.log(`report saved to ${REPORT_FILE}`);
}
process.exit(done && sink.unique + counts.failed === N ? 0 : 1);
