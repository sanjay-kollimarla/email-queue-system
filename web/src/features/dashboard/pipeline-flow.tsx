import { ArrowRight, CheckCircle2, Clock, Inbox, Send } from "lucide-react";
import type { ReactNode } from "react";
import type { StatusCounts } from "../../shared/api/schemas";
import { cn } from "../../shared/lib/cn";
import { formatCompact } from "../../shared/lib/format";
import { Badge, STATUS_META } from "../../shared/ui/status-badge";

interface StageProps {
  icon: ReactNode;
  label: string;
  value: number;
  caption: string;
  active: boolean;
  tone: string;
}

function Stage({ icon, label, value, caption, active, tone }: StageProps) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-xl border border-line bg-subtle/60 p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-muted">
        <span className={cn("flex size-6 items-center justify-center rounded-md", tone)} aria-hidden="true">
          {icon}
        </span>
        {label}
        {active && (
          <span className="ml-auto flex items-center">
            <span className="size-2 animate-[pulse-ring_1.4s_ease-out_infinite] rounded-full bg-ok" aria-hidden="true" />
            <span className="sr-only">active</span>
          </span>
        )}
      </div>
      <div className="text-2xl font-semibold tabular tracking-tight">{formatCompact(value)}</div>
      <div className="text-xs text-muted">{caption}</div>
    </div>
  );
}

function Connector({ active }: { active: boolean }) {
  return (
    <div className="flex items-center justify-center text-line-strong max-md:rotate-90" aria-hidden="true">
      <svg width="48" height="12" viewBox="0 0 48 12" className="overflow-visible" aria-hidden="true">
        <line
          x1="0"
          y1="6"
          x2="40"
          y2="6"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 4"
          className={active ? "animate-[flow_.8s_linear_infinite] text-accent" : ""}
          style={active ? { stroke: "var(--accent)" } : undefined}
        />
        <ArrowRight x="36" y="0" width="12" height="12" className={active ? "text-accent" : ""} />
      </svg>
    </div>
  );
}

const SIDE_OUTCOMES = ["failed", "bounced", "complained", "suppressed"] as const;

/** The life of an email as a diagram: where everything currently is, animated while mail is moving. */
export function PipelineFlow({ counts, total, sendingNow }: { counts: StatusCounts; total: number; sendingNow: boolean }) {
  const moving = counts.queued > 0 || counts.sending > 0 || sendingNow;
  return (
    <div>
      <div className="flex flex-col gap-1 md:flex-row md:items-stretch">
        <Stage
          icon={<Inbox className="size-3.5" />}
          label="Accepted"
          value={total}
          caption="stored durably before we answered"
          active={false}
          tone="bg-accent-soft text-accent"
        />
        <Connector active={moving} />
        <Stage
          icon={<Clock className="size-3.5" />}
          label="Queued"
          value={counts.queued}
          caption="waiting for the account's rate"
          active={counts.queued > 0}
          tone="bg-info-soft text-info"
        />
        <Connector active={moving} />
        <Stage
          icon={<Send className="size-3.5" />}
          label="Sending"
          value={counts.sending}
          caption="in a worker right now"
          active={counts.sending > 0}
          tone="bg-warn-soft text-warn"
        />
        <Connector active={moving} />
        <Stage
          icon={<CheckCircle2 className="size-3.5" />}
          label="Delivered"
          value={counts.sent}
          caption="accepted by your SMTP server"
          active={sendingNow}
          tone="bg-ok-soft text-ok"
        />
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted">
        Other outcomes:
        {SIDE_OUTCOMES.map((s) => (
          <span key={s} title={STATUS_META[s].hint}>
            <Badge tone={STATUS_META[s].tone}>
              {STATUS_META[s].label} <span className="tabular font-semibold">{formatCompact(counts[s])}</span>
            </Badge>
          </span>
        ))}
      </div>
    </div>
  );
}
