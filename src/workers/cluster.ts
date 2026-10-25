/**
 * One send-worker process saturates one CPU core (~1k emails/s: SMTP serialization, BullMQ and
 * MongoDB driver work are all single-threaded JS). To use a whole machine, run one process per core:
 *
 *   WORKER_PROCESSES=6 bun run worker:cluster
 *
 * Processes share nothing but Redis/MongoDB, so the same thing scales across machines too
 * (docker compose `deploy.replicas`, Kubernetes HPA on queue depth, ...). Crashed children restart.
 */
import os from "node:os";

const count = Number(process.env.WORKER_PROCESSES ?? Math.max(1, Math.floor(os.availableParallelism() / 2)));
const children = new Map<number, ReturnType<typeof Bun.spawn>>();
let stopping = false;

function spawnOne(slot: number) {
  const child = Bun.spawn([process.execPath, "run", "src/workers/send-worker.ts"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  children.set(slot, child);
  void child.exited.then((code) => {
    children.delete(slot);
    if (stopping) return;
    console.error(`[cluster] worker ${slot} exited (${code}), restarting in 1s`);
    setTimeout(() => !stopping && spawnOne(slot), 1000);
  });
}

for (let i = 0; i < count; i++) spawnOne(i);
console.log(`[cluster] started ${count} send-worker processes`);

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  for (const c of children.values()) c.kill("SIGTERM"); // each child drains its in-flight jobs
  await Promise.all([...children.values()].map((c) => c.exited));
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
