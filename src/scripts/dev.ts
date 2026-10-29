/**
 * One command for local development: starts the fake SMTP sink, API, relay, reaper and workers,
 * prefixes every log line with the service name, and stops everything on Ctrl+C.
 *
 *   bun run dev                       # 2 worker processes
 *   WORKER_PROCESSES=6 bun run dev
 *
 * (`cmd &` does not background processes on Windows, and PowerShell 5 has no `&` operator for it,
 * so this launcher does it portably.) It first runs `docker compose up -d --wait mongo redis` so the database and
 * queue are up (a no-op when they already are); `SKIP_INFRA=1 bun run dev` skips that if you run them yourself.
 */
const workers = Number(process.env.WORKER_PROCESSES ?? 2);

// WEB_DEV=1 also starts the Vite dev server with hot reload on http://localhost:5173 (proxied to the API)
const withWebDev = process.env.WEB_DEV === "1";

const services: Array<{ name: string; script: string; cwd?: string; cmd?: string[] }> = [
  { name: "sink", script: "src/loadtest/smtp-sink.ts" },
  { name: "api", script: "src/api/server.ts" },
  { name: "relay", script: "src/workers/outbox-relay.ts" },
  { name: "reaper", script: "src/workers/reaper.ts" },
  ...(withWebDev ? [{ name: "web", script: "vite", cwd: "web", cmd: [process.execPath, "run", "dev"] }] : []),
  ...Array.from({ length: workers }, (_, i) => ({ name: `worker${i + 1}`, script: "src/workers/send-worker.ts" })),
];

if (process.env.SKIP_INFRA !== "1") {
  console.log("starting mongo + redis (docker compose)...");
  const infra = Bun.spawnSync(["docker", "compose", "up", "-d", "--wait", "mongo", "redis"], { stdout: "inherit", stderr: "inherit" });
  if (infra.exitCode !== 0) {
    console.error("could not start mongo + redis: is Docker running? (SKIP_INFRA=1 skips this step)");
    process.exit(1);
  }
}

const COLORS = [36, 32, 33, 35, 34, 96, 92, 93, 95, 94];
const procs: Array<ReturnType<typeof Bun.spawn>> = [];
let stopping = false;

async function pipe(stream: ReadableStream<Uint8Array>, prefix: string) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`);
  }
}

services.forEach((svc, i) => {
  const prefix = `\x1b[${COLORS[i % COLORS.length]}m${svc.name.padEnd(8)}\x1b[0m|`;
  const proc = Bun.spawn(svc.cmd ?? [process.execPath, "run", svc.script], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
    cwd: svc.cwd,
  });
  procs.push(proc);
  void pipe(proc.stdout as ReadableStream<Uint8Array>, prefix);
  void pipe(proc.stderr as ReadableStream<Uint8Array>, prefix);
  void proc.exited.then((code) => {
    if (!stopping) console.log(`${prefix} exited with code ${code}`);
  });
});

console.log(`started: ${services.map((s) => s.name).join(", ")}  (Ctrl+C to stop)`);
console.log("API: http://localhost:3100   SMTP sink: localhost:2525 (stats http://localhost:2526/stats)");

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  console.log("\nstopping all services...");
  for (const p of procs) p.kill("SIGTERM");
  await Promise.race([Promise.all(procs.map((p) => p.exited)), new Promise((r) => setTimeout(r, 15_000))]);
  for (const p of procs) p.kill("SIGKILL");
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
