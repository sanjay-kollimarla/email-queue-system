import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-accent-soft text-accent" aria-hidden="true">
        {icon}
      </div>
      <h3 className="text-base font-semibold">{title}</h3>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action}
    </div>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={copied ? "Copied" : `${label} to clipboard`}
      icon={copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard can be blocked (insecure context); the value stays visible and selectable */
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Radio-group segmented control (keyboard: arrow keys move the selection natively). */
export function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; hint?: string }>;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 text-sm font-medium">{label}</legend>
      <div className="inline-flex rounded-lg border border-line-strong bg-subtle p-0.5">
        {options.map((o) => (
          <label
            key={o.value}
            title={o.hint}
            className={cn(
              "cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              "has-[:focus-visible]:shadow-[var(--ring)]",
              value === o.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
            )}
          >
            <input
              type="radio"
              name={label}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Meter({
  value,
  max,
  label,
  tone = "accent",
}: {
  value: number;
  max: number;
  label: string;
  tone?: "accent" | "ok" | "warn" | "bad";
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const color = { accent: "bg-accent", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" }[tone];
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot be styled into this rounded, animated bar consistently across browsers
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100) / 100}
      className="h-2 w-full overflow-hidden rounded-full bg-subtle"
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}
