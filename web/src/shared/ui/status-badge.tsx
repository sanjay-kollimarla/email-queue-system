import { AlertTriangle, CheckCircle2, Clock, Loader2, MailX, ShieldOff, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import type { EmailStatus } from "../api/schemas";

type Tone = "ok" | "warn" | "bad" | "info" | "violet" | "neutral";

const TONES: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info",
  violet: "bg-violet-soft text-violet",
  neutral: "bg-subtle text-muted",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * One definition of what each delivery status looks like, used by the table, drawer, dashboard and legend.
 * Color is never the only signal: every status also has an icon and a text label.
 */
export const STATUS_META: Record<EmailStatus, { label: string; tone: Tone; icon: typeof Clock; hint: string }> = {
  queued: { label: "Queued", tone: "info", icon: Clock, hint: "Accepted and waiting for its turn within the account's rate limit" },
  sending: { label: "Sending", tone: "warn", icon: Loader2, hint: "A worker is handing it to your SMTP server right now" },
  sent: { label: "Sent", tone: "ok", icon: CheckCircle2, hint: "Your SMTP server accepted the message" },
  failed: { label: "Failed", tone: "bad", icon: XCircle, hint: "Rejected permanently or gave up after retries" },
  suppressed: { label: "Suppressed", tone: "neutral", icon: ShieldOff, hint: "Not sent: the recipient is on your suppression list" },
  bounced: { label: "Bounced", tone: "bad", icon: MailX, hint: "The recipient's server rejected it after we handed it over" },
  complained: { label: "Complaint", tone: "violet", icon: AlertTriangle, hint: "The recipient marked it as spam" },
};

export function StatusBadge({ status }: { status: EmailStatus }) {
  const m = STATUS_META[status];
  const Icon = m.icon;
  return (
    <Badge tone={m.tone}>
      <Icon className={cn("size-3.5", status === "sending" && "animate-spin")} aria-hidden="true" />
      {m.label}
    </Badge>
  );
}
