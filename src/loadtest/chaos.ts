/**
 * Chaos harness: runs the whole pipeline and breaks it while it is under load.
 *
 *   bun run chaos -- --emails 60000
 *
 *  t+8s   SIGKILL every worker (no graceful drain), restart them 3s later
 *  t+16s  `docker restart` Redis (loses up to ~1s of AOF writes); CHAOS_WIPE=1 wipes it entirely instead
 *  t+30s  SIGKILL the relay, restart it
 *  then   wait for the load test to finish and judge it by the SMTP sink's ground truth
 *
 * PASS = every email accepted by the API was received by the sink at least once (LOSS 0).
 * Duplicates are reported but tolerated: delivery is at-least-once by design.
 * Requires `docker compose up -d mongo redis`.
 */
import { mkdirSync, openSync } from "node:fs";

const argv = process.argv.slice(2);
const emails = argv.includes("--emails") ? argv[argv.indexOf("--emails") + 1]! : "60000";
const redisContainer = process.env.REDIS_CONTAINER ?? "email-queue-system-redis-1";
const mongoContainer = process.env.MONGO_CONTAINER ?? "email-queue-system-mongo-1";

mkdirSync(".run", { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = async (cmd: string[]) => Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited;

const env = { ...process.env, SENDING_LEASE_MS: "10000", RECONCILE_AFTER_MS: "15000", WORKER_CONCURRENCY: "200" };
const spawn = (name: string, script: string) =>
  Bun.spawn([process.execPath, "run", script], {
    env,
    stdout: openSync(`.run/chaos-${name}.log`, "w"),
    stderr: openSync(`.run/chaos-${name}.log`, "a"),
  });

console.log("== resetting data ==");
await sh(["docker", "exec", redisContainer, "redis-cli", "FLUSHALL"]);
await sh(["docker", "exec", mongoContainer, "mongosh", "--quiet", "--eval", "db.getSiblingDB('emailq').dropDatabase()"]);

const procs = new Map<string, ReturnType<typeof Bun.spawn>>();
const start = (name: string, script: string) => procs.set(name, spawn(name, script));
start("sink", "src/loadtest/smtp-sink.ts");
start("api", "src/api/server.ts");
start("relay", "src/workers/outbox-relay.ts");
start("reaper", "src/workers/reaper.ts");
for (let i = 0; i < 3; i++) start(`worker${i}`, "src/workers/send-worker.ts");
await sleep(4000);

const load = Bun.spawn([process.execPath, "run", "src/loadtest/run.ts", "--emails", emails, "--per-second", "20000", "--timeout", "600"], {
  stdout: "inherit",
  stderr: "inherit",
});

const hardKill = (name: string) => {
  procs.get(name)?.kill("SIGKILL");
};
const workers = () => [...procs.keys()].filter((n) => n.startsWith("worker"));

await sleep(8000);
console.log("\n>>> CHAOS: SIGKILL all workers");
workers().forEach(hardKill);
await sleep(3000);
console.log(">>> CHAOS: restart workers");
for (const n of workers()) start(n, "src/workers/send-worker.ts");

await sleep(5000);
if (process.env.CHAOS_WIPE === "1") {
  console.log(">>> CHAOS: WIPE Redis completely (FLUSHALL): every queued job is gone");
  await sh(["docker", "exec", redisContainer, "redis-cli", "FLUSHALL"]);
} else {
  console.log(">>> CHAOS: restart Redis");
  await sh(["docker", "restart", redisContainer]);
}

await sleep(14000);
console.log(">>> CHAOS: SIGKILL relay");
hardKill("relay");
await sleep(2000);
console.log(">>> CHAOS: restart relay");
start("relay", "src/workers/outbox-relay.ts");

const code = await load.exited;
for (const p of procs.values()) p.kill("SIGKILL");
console.log(code === 0 ? "\nCHAOS TEST: PASS (no email lost)" : "\nCHAOS TEST: FAIL (see LOSS line above, logs in .run/chaos-*.log)");
process.exit(code);
