/** Pure geometry for the throughput chart: kept out of the component so it can be unit-tested. */

/** Smallest "nice" number (1, 2, 5 x 10^n) that is >= value, for readable axis maxima. */
export function niceCeil(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const frac = value / base;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * base;
}

export interface ChartPoint {
  x: number;
  y: number;
  value: number;
  at: Date;
}

export interface ChartLayout {
  points: ChartPoint[];
  yMax: number;
  yTicks: number[];
  linePath: string;
  areaPath: string;
}

export function layoutSeries(
  series: Array<{ at: string | Date; perSec: number }>,
  box: { width: number; height: number; padLeft: number; padRight: number; padTop: number; padBottom: number },
): ChartLayout {
  const peak = series.reduce((m, p) => Math.max(m, p.perSec), 0);
  const yMax = niceCeil(peak * 1.1);
  const innerW = box.width - box.padLeft - box.padRight;
  const innerH = box.height - box.padTop - box.padBottom;
  const n = series.length;

  const points: ChartPoint[] = series.map((p, i) => ({
    x: box.padLeft + (n <= 1 ? 0 : (i / (n - 1)) * innerW),
    y: box.padTop + innerH - (p.perSec / yMax) * innerH,
    value: p.perSec,
    at: new Date(p.at),
  }));

  const baseY = box.padTop + innerH;
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = points.length ? `${linePath} L${points.at(-1)!.x.toFixed(1)},${baseY} L${points[0]!.x.toFixed(1)},${baseY} Z` : "";
  const yTicks = [0, yMax / 2, yMax];
  return { points, yMax, yTicks, linePath, areaPath };
}

/** Index of the point whose x is closest to `x` (for hover tooltips). */
export function nearestIndex(points: ChartPoint[], x: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  points.forEach((p, i) => {
    const d = Math.abs(p.x - x);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  });
  return best;
}
