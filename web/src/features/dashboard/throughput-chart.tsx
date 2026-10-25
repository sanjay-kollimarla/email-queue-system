import { useId, useMemo, useState } from "react";
import { formatRate } from "../../shared/lib/format";
import { layoutSeries, nearestIndex } from "./chart-math";

const BOX = { width: 720, height: 220, padLeft: 44, padRight: 12, padTop: 12, padBottom: 26 };

interface Props {
  points: Array<{ at: string; sent: number }>;
  bucketSec: number;
}

/**
 * Hand-rolled SVG area chart (no charting dependency): scales with its container via viewBox, supports hover
 * and keyboard-free reading through a text summary for screen readers.
 */
export function ThroughputChart({ points, bucketSec }: Props) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const layout = useMemo(
    () =>
      layoutSeries(
        points.map((p) => ({ at: p.at, perSec: p.sent / bucketSec })),
        BOX,
      ),
    [points, bucketSec],
  );
  const total = points.reduce((n, p) => n + p.sent, 0);
  const active = hover !== null ? layout.points[hover] : undefined;
  const bottom = BOX.height - BOX.padBottom;

  const summary = `Emails sent per second over the last ${Math.round((points.length * bucketSec) / 60)} minutes. ${total} sent in total.`;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${BOX.width} ${BOX.height}`}
        role="img"
        aria-label={summary}
        className="h-auto w-full touch-none select-none"
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * BOX.width;
          setHover(nearestIndex(layout.points, x));
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {layout.yTicks.map((t) => {
          const y = BOX.padTop + (BOX.height - BOX.padTop - BOX.padBottom) * (1 - t / layout.yMax);
          return (
            <g key={t}>
              <line
                x1={BOX.padLeft}
                x2={BOX.width - BOX.padRight}
                y1={y}
                y2={y}
                stroke="var(--line)"
                strokeDasharray={t === 0 ? undefined : "3 4"}
              />
              <text x={BOX.padLeft - 8} y={y + 4} textAnchor="end" fontSize="11" fill="var(--muted)" className="tabular">
                {t >= 10 ? Math.round(t) : t.toFixed(t % 1 ? 1 : 0)}
              </text>
            </g>
          );
        })}
        <text x={BOX.padLeft} y={bottom + 18} fontSize="11" fill="var(--muted)">
          {Math.round((points.length * bucketSec) / 60)} min ago
        </text>
        <text x={BOX.width - BOX.padRight} y={bottom + 18} fontSize="11" fill="var(--muted)" textAnchor="end">
          now
        </text>

        {layout.areaPath && <path d={layout.areaPath} fill={`url(#${gradientId})`} />}
        {layout.linePath && (
          <path d={layout.linePath} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        )}

        {active && (
          <g pointerEvents="none">
            <line x1={active.x} x2={active.x} y1={BOX.padTop} y2={bottom} stroke="var(--line-strong)" />
            <circle cx={active.x} cy={active.y} r="4.5" fill="var(--surface)" stroke="var(--accent)" strokeWidth="2" />
          </g>
        )}
      </svg>

      {active && (
        <div
          className="pointer-events-none absolute top-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-card"
          style={{ left: `${(active.x / BOX.width) * 100}%`, transform: `translateX(${active.x > BOX.width * 0.7 ? "-105%" : "8px"})` }}
        >
          <div className="font-semibold tabular">{formatRate(active.value)}</div>
          <div className="text-muted">{active.at.toLocaleTimeString()}</div>
        </div>
      )}
    </div>
  );
}
