import { cn } from "../lib/cn";

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span {...(label ? { role: "status", "aria-label": label } : { "aria-hidden": true })} className="inline-flex">
      <svg className={cn("animate-spin", className ?? "size-5")} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-subtle", className)} />;
}
