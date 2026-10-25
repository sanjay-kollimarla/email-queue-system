const nf = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const formatInt = (n: number) => nf.format(Math.round(n));
export const formatCompact = (n: number) => (Math.abs(n) < 10_000 ? formatInt(n) : compact.format(n));

/** 12.4 -> "12.4/s", 0.5 -> "0.50/s", 0 -> "0/s" */
export function formatRate(perSec: number | null | undefined): string {
  if (perSec === null || perSec === undefined || !Number.isFinite(perSec)) return "—";
  if (perSec === 0) return "0/s";
  if (perSec >= 100 || Number.isInteger(perSec)) return `${formatInt(perSec)}/s`;
  if (perSec >= 10) return `${perSec.toFixed(1)}/s`;
  return `${perSec.toFixed(2)}/s`;
}

/** Human duration for pauses and countdowns: 3_000 -> "3s", 125_000 -> "2m 5s". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function formatRelative(iso: string | Date, now = Date.now()): string {
  const diffSec = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 5) return "just now";
  if (abs < 60) return rtf.format(diffSec, "second");
  if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diffSec / 3600), "hour");
  return rtf.format(Math.round(diffSec / 86_400), "day");
}

export const formatDateTime = (iso: string | Date) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
