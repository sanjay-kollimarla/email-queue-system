import { AlertTriangle, CheckCircle2, PauseCircle } from "lucide-react";
import { Link } from "react-router";
import type { SmtpAccount } from "../../shared/api/schemas";
import { formatDuration, formatRate } from "../../shared/lib/format";
import { useNow } from "../../shared/lib/use-now";
import { Badge } from "../../shared/ui/status-badge";
import { Meter } from "../../shared/ui/misc";

/**
 * Makes the adaptive rate controller visible: the bar is "how fast we are sending right now" against the ceiling the
 * user declared; the marker line is the provider limit the controller learned from throttling responses.
 */
export function AccountRate({ account }: { account: SmtpAccount }) {
  const now = useNow();
  const { rate } = account;
  const pausedMs = rate.pausedUntil ? new Date(rate.pausedUntil).getTime() - now : 0;
  const paused = pausedMs > 0;
  const current = rate.currentPerSec ?? 0;
  const learned = rate.learnedLimitPerSec;
  const learnedPct = learned && rate.ceilingPerSec > 0 ? Math.min(100, (learned / rate.ceilingPerSec) * 100) : null;

  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link to="/smtp" className="font-medium hover:text-accent hover:underline">
            {account.name}
          </Link>
          <p className="truncate text-xs text-muted">
            {account.host}:{account.port}
          </p>
        </div>
        {account.health === "auth_failed" ? (
          <Badge tone="bad">
            <AlertTriangle className="size-3.5" aria-hidden="true" /> Credentials rejected
          </Badge>
        ) : paused ? (
          <Badge tone="warn">
            <PauseCircle className="size-3.5" aria-hidden="true" /> Paused {formatDuration(pausedMs)}
          </Badge>
        ) : (
          <Badge tone="ok">
            <CheckCircle2 className="size-3.5" aria-hidden="true" /> Healthy
          </Badge>
        )}
      </div>

      <div className="mt-4 flex items-baseline justify-between text-sm">
        <span className="text-muted">Sending at</span>
        <span>
          <span className="text-lg font-semibold tabular">{formatRate(paused ? 0 : current)}</span>
          <span className="text-muted"> of {formatRate(rate.ceilingPerSec)} allowed</span>
        </span>
      </div>
      <div className="relative mt-2">
        <Meter
          value={paused ? 0 : current}
          max={rate.ceilingPerSec}
          label={`${account.name} send rate`}
          tone={paused ? "warn" : "accent"}
        />
        {learnedPct !== null && (
          <div
            className="absolute -top-1 h-4 w-0.5 rounded bg-warn"
            style={{ left: `${learnedPct}%` }}
            title={`Learned provider limit: ${formatRate(learned)}`}
          />
        )}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted">Learned provider limit</dt>
        <dd className="text-right font-medium tabular">{learned ? formatRate(learned) : "not throttled yet"}</dd>
        <dt className="text-muted">Daily cap (rolling 24h)</dt>
        <dd className="text-right font-medium tabular">{rate.dailyCap ? rate.dailyCap.toLocaleString() : "none"}</dd>
      </dl>
      {account.health === "auth_failed" && account.healthDetail && <p className="mt-2 text-xs text-bad">{account.healthDetail}</p>}
    </li>
  );
}
