import type { Counter, Logger, Metrics } from "../core/ports.ts";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = keyof typeof LEVELS;
const parseLevel = (v: string | undefined): Level => (v && v in LEVELS ? (v as Level) : "info");

/**
 * Structured (one JSON object per line) logs: greppable locally, ingestible by any log pipeline.
 * LOG_LEVEL=debug|info|warn|error|silent (default info); the test environment sets it to "silent".
 */
export class JsonLogger implements Logger {
  private readonly min: number;
  constructor(
    private readonly service: string,
    private readonly out: (line: string) => void = (l) => console.log(l),
    level: Level = parseLevel(process.env.LOG_LEVEL),
  ) {
    this.min = LEVELS[level];
  }
  private emit(level: Exclude<Level, "silent">, msg: string, fields?: Record<string, unknown>) {
    if (LEVELS[level] < this.min) return;
    this.out(JSON.stringify({ ts: new Date().toISOString(), level, service: this.service, msg, ...fields }));
  }
  info(msg: string, fields?: Record<string, unknown>) {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: Record<string, unknown>) {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: Record<string, unknown>) {
    this.emit("error", msg, fields);
  }
}

/** In-process counters; `snapshot()` backs the /metrics endpoint and the periodic stats log line. */
export class CounterMetrics implements Metrics {
  private counts: Record<Counter, number> = { sent: 0, throttled: 0, deferred: 0, failed: 0, transient: 0 };
  inc(counter: Counter, n = 1) {
    this.counts[counter] += n;
  }
  snapshot(): Readonly<Record<Counter, number>> {
    return { ...this.counts };
  }
}
