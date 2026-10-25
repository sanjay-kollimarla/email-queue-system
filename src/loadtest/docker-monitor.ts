/**
 * Samples CPU and memory of every container in a docker compose project while a load test runs, and reads back the
 * resource limits they were started with, so the report can say how close each service came to its limit.
 *
 * `docker stats` reports CPU as a percentage of ONE core (200% = two cores busy), so a container limited to
 * `cpus: 1.0` is saturated at 100%.
 */
export interface ContainerInfo {
  id: string;
  name: string;
  service: string;
  /** CPU limit in cores (0 = unlimited) */
  cpuLimit: number;
  /** hard memory limit in bytes (0 = unlimited) */
  memLimit: number;
  /** soft memory reservation in bytes (0 = none) */
  memReservation: number;
}

export interface ServiceUsage {
  service: string;
  replicas: number;
  cpuLimit: number;
  memLimit: number;
  memReservation: number;
  /** mean CPU % of one core, per replica */
  cpuAvg: number;
  /** highest CPU % any single replica reached */
  cpuPeak: number;
  memAvg: number;
  memPeak: number;
  oomKilled: number;
  restarts: number;
}

export interface UsageSummary {
  services: ServiceUsage[];
  total: { cpuAvg: number; cpuPeak: number; memAvg: number; memPeak: number };
}

const UNITS: Record<string, number> = {
  b: 1,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

export function parseBytes(text: string): number {
  const m = text.trim().match(/^([0-9.]+)\s*([A-Za-z]+)$/);
  return m ? Number(m[1]) * (UNITS[m[2]?.toLowerCase() ?? "b"] ?? 1) : 0;
}

async function docker(args: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim();
  } catch {
    return ""; // docker not installed / not running: the report simply has no resource section
  }
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const max = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), 0);

export class DockerMonitor {
  private containers: ContainerInfo[] = [];
  private readonly series = new Map<string, { cpu: number[]; mem: number[] }>();
  private readonly totals: Array<{ cpu: number; mem: number }> = [];
  private running = false;
  private loop: Promise<void> | undefined;
  /** most recent whole-project totals, for the live progress line */
  latest = { cpu: 0, mem: 0 };

  constructor(private readonly project: string) {}

  async discover(): Promise<ContainerInfo[]> {
    const listing = await docker([
      "ps",
      "--filter",
      `label=com.docker.compose.project=${this.project}`,
      "--format",
      '{{.ID}}|{{.Names}}|{{.Label "com.docker.compose.service"}}',
    ]);
    const rows = listing
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("|"));
    const ids = rows.map((r) => r[0] ?? "");
    const limits = ids.length
      ? await docker([
          "inspect",
          "--format",
          "{{.Id}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.MemoryReservation}}",
          ...ids,
        ])
      : "";
    const byId = new Map(
      limits
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.split("|")[0] ?? "", l.split("|")] as const),
    );
    this.containers = rows.map(([id = "", name = "", service = ""]) => {
      const full = [...byId.keys()].find((k) => k.startsWith(id)) ?? "";
      const [, nano = "0", mem = "0", res = "0"] = byId.get(full) ?? [];
      return {
        id: full || id,
        name,
        service,
        cpuLimit: Number(nano) / 1e9,
        memLimit: Number(mem),
        memReservation: Number(res),
      };
    });
    return this.containers;
  }

  start(): void {
    if (this.running || this.containers.length === 0) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) await this.sample();
    })();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop;
  }

  private async sample(): Promise<void> {
    // `docker stats --no-stream` itself takes ~1-2 s (it measures over an interval), which paces the loop
    const out = await docker([
      "stats",
      "--no-stream",
      "--format",
      "{{.ID}}|{{.CPUPerc}}|{{.MemUsage}}",
      ...this.containers.map((c) => c.id),
    ]);
    let cpuTotal = 0;
    let memTotal = 0;
    for (const line of out.split("\n").filter(Boolean)) {
      const [id = "", cpu = "0%", mem = ""] = line.split("|");
      const info = this.containers.find((c) => c.id.startsWith(id));
      if (!info) continue;
      const cpuPct = Number.parseFloat(cpu) || 0;
      const memBytes = parseBytes(mem.split("/")[0] ?? "");
      const s = this.series.get(info.id) ?? { cpu: [], mem: [] };
      s.cpu.push(cpuPct);
      s.mem.push(memBytes);
      this.series.set(info.id, s);
      cpuTotal += cpuPct;
      memTotal += memBytes;
    }
    if (cpuTotal > 0 || memTotal > 0) {
      this.totals.push({ cpu: cpuTotal, mem: memTotal });
      this.latest = { cpu: cpuTotal, mem: memTotal };
    }
  }

  async summary(): Promise<UsageSummary> {
    const state = this.containers.length
      ? await docker(["inspect", "--format", "{{.Id}}|{{.State.OOMKilled}}|{{.RestartCount}}", ...this.containers.map((c) => c.id)])
      : "";
    const health = new Map(
      state
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.split("|")[0] ?? "", l.split("|")] as const),
    );

    const services = new Map<string, ServiceUsage>();
    for (const c of this.containers) {
      const s = this.series.get(c.id) ?? { cpu: [], mem: [] };
      const [, oom = "false", restarts = "0"] = health.get(c.id) ?? [];
      const existing = services.get(c.service);
      const u: ServiceUsage = existing ?? {
        service: c.service,
        replicas: 0,
        cpuLimit: c.cpuLimit,
        memLimit: c.memLimit,
        memReservation: c.memReservation,
        cpuAvg: 0,
        cpuPeak: 0,
        memAvg: 0,
        memPeak: 0,
        oomKilled: 0,
        restarts: 0,
      };
      u.cpuAvg = (u.cpuAvg * u.replicas + mean(s.cpu)) / (u.replicas + 1); // running mean across replicas
      u.memAvg = (u.memAvg * u.replicas + mean(s.mem)) / (u.replicas + 1);
      u.cpuPeak = Math.max(u.cpuPeak, max(s.cpu));
      u.memPeak = Math.max(u.memPeak, max(s.mem));
      u.oomKilled += oom === "true" ? 1 : 0;
      u.restarts += Number(restarts);
      u.replicas++;
      services.set(c.service, u);
    }
    return {
      services: [...services.values()].sort((a, b) => a.service.localeCompare(b.service)),
      total: {
        cpuAvg: mean(this.totals.map((t) => t.cpu)),
        cpuPeak: max(this.totals.map((t) => t.cpu)),
        memAvg: mean(this.totals.map((t) => t.mem)),
        memPeak: max(this.totals.map((t) => t.mem)),
      },
    };
  }
}
