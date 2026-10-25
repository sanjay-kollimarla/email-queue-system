import { X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** `drawer` slides in from the right (detail views); `modal` is centered (forms, confirmations) */
  variant?: "modal" | "drawer";
  className?: string;
}

/**
 * Built on the native <dialog> element: focus is trapped inside, Escape closes it, the page behind is inert and
 * screen readers announce it as a modal: all provided by the browser, so there is no focus-trap code to get wrong.
 */
export function Dialog({ open, onClose, title, description, children, variant = "modal", className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the backdrop click is a pointer shortcut; Escape already closes a modal <dialog> natively
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        // click on the backdrop (the dialog element itself, outside its content box) closes it
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto max-h-[90vh] w-[min(92vw,40rem)] overflow-hidden rounded-2xl border border-line bg-surface p-0 text-fg shadow-card",
        "backdrop:bg-black/50 backdrop:backdrop-blur-[2px]",
        variant === "drawer" && "m-0 ml-auto h-full max-h-none w-[min(100vw,30rem)] rounded-none rounded-l-2xl",
        className,
      )}
    >
      {open && (
        <div className="flex h-full max-h-[90vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 id={titleId} className="text-base font-semibold tracking-tight">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close dialog" className="-mr-2 px-2">
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
  loading,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  loading?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} className="w-[min(92vw,28rem)]">
      <div className="text-sm text-muted">{message}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} loading={loading}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
