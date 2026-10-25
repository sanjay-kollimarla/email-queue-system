import { Mail } from "lucide-react";
import { cn } from "../shared/lib/cn";

export function Brand({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5 text-lg font-semibold tracking-tight", className)}>
      <span className="flex size-8 items-center justify-center rounded-lg bg-accent text-on-accent" aria-hidden="true">
        <Mail className="size-4.5" />
      </span>
      Courier
    </div>
  );
}
