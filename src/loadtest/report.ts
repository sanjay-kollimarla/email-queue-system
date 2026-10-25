/** Plain-text report helpers for the load test: numbers, bars, sparklines, aligned tables, optional colour. */

export const fmt = (n: number, decimals = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

export function bytes(n: number): string {
  if (n <= 0) return "-";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  return `${(n / 1024 ** 2).toFixed(0)} MiB`;
}

export const bar = (fraction: number, width = 20) => {
  const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
};

const BLOCKS = "▁▂▃▄▅▆▇█";
/** One character per bucket, scaled to the largest value: the shape of throughput over time. */
export function spark(values: number[], width = 60): string {
  if (values.length === 0) return "";
  const buckets = Math.min(width, values.length);
  const size = values.length / buckets;
  const pts = Array.from({ length: buckets }, (_, i) => {
    const slice = values.slice(Math.floor(i * size), Math.max(Math.floor((i + 1) * size), Math.floor(i * size) + 1));
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
  const top = Math.max(...pts, 1e-9);
  return pts.map((p) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((p / top) * (BLOCKS.length - 1)))]).join("");
}

export function table(headers: string[], rows: string[][], align: Array<"l" | "r"> = []): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const cell = (s: string, i: number) => (align[i] === "r" ? s.padStart(widths[i] ?? 0) : s.padEnd(widths[i] ?? 0));
  const line = (cells: string[]) => cells.map(cell).join("  ");
  return [line(headers), widths.map((w) => "─".repeat(w)).join("  "), ...rows.map(line)];
}

export type Level = "ok" | "warn" | "fail";
export const MARK: Record<Level, string> = { ok: "✔", warn: "⚠", fail: "✘" };

/** ANSI colour for a terminal; the saved report file is rendered without it. */
export function painter(enabled: boolean) {
  const wrap = (code: number) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);
  const colour = { ok: wrap(32), warn: wrap(33), fail: wrap(31) };
  return {
    bold: wrap(1),
    dim: wrap(2),
    level: (level: Level, s: string) => colour[level](s),
  };
}
