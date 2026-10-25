import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from "react";
import { cn } from "../lib/cn";

const CONTROL =
  "w-full rounded-lg border bg-surface text-fg placeholder:text-muted/70 transition-colors " +
  "border-line-strong hover:border-accent/60 focus:border-accent disabled:opacity-60 disabled:bg-subtle";

interface FieldShellProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  /** visually hide the label but keep it for screen readers */
  hideLabel?: boolean;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
  className?: string;
}

/** Label + control + hint + error, wired with htmlFor / aria-describedby / aria-invalid. Used by every form control. */
export function FieldShell({ label, hint, error, required, hideLabel, children, className }: FieldShellProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className={cn("text-sm font-medium text-fg", hideLabel && "sr-only")}>
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-bad">
            *
          </span>
        )}
      </label>
      {children({ id, describedBy, invalid: Boolean(error) })}
      {hint && !error && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-bad">
          {error}
        </p>
      )}
    </div>
  );
}

interface CommonProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  hideLabel?: boolean;
  wrapperClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, CommonProps & InputHTMLAttributes<HTMLInputElement>>(function Input(
  { label, hint, error, hideLabel, wrapperClassName, className, required, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} hideLabel={hideLabel} className={wrapperClassName}>
      {({ id, describedBy, invalid }) => (
        <input
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          required={required}
          className={cn(CONTROL, "h-10 px-3 text-sm", invalid && "border-bad", className)}
          {...rest}
        />
      )}
    </FieldShell>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, CommonProps & TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { label, hint, error, hideLabel, wrapperClassName, className, required, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} hideLabel={hideLabel} className={wrapperClassName}>
      {({ id, describedBy, invalid }) => (
        <textarea
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          required={required}
          className={cn(CONTROL, "min-h-24 px-3 py-2 text-sm leading-relaxed", invalid && "border-bad", className)}
          {...rest}
        />
      )}
    </FieldShell>
  );
});

export const Select = forwardRef<HTMLSelectElement, CommonProps & SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { label, hint, error, hideLabel, wrapperClassName, className, required, children, ...rest },
  ref,
) {
  return (
    <FieldShell label={label} hint={hint} error={error} required={required} hideLabel={hideLabel} className={wrapperClassName}>
      {({ id, describedBy, invalid }) => (
        <select
          ref={ref}
          id={id}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          required={required}
          className={cn(CONTROL, "h-10 px-3 text-sm", invalid && "border-bad", className)}
          {...rest}
        >
          {children}
        </select>
      )}
    </FieldShell>
  );
});

/** Accessible switch built on a native checkbox (keyboard + screen reader support for free). */
export const Switch = forwardRef<HTMLInputElement, { label: string; hint?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type">>(
  function Switch({ label, hint, className, ...rest }, ref) {
    const id = useId();
    return (
      <div className={cn("flex items-start gap-3", className)}>
        <input ref={ref} id={id} type="checkbox" className="peer sr-only" {...rest} />
        <label
          htmlFor={id}
          className={cn(
            "relative mt-0.5 h-6 w-11 shrink-0 rounded-full bg-line-strong transition-colors",
            "after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-surface after:shadow after:transition-transform",
            "peer-checked:bg-accent peer-checked:after:translate-x-5 peer-focus-visible:shadow-[var(--ring)] cursor-pointer",
          )}
        >
          <span className="sr-only">{label}</span>
        </label>
        <div className="text-sm">
          <label htmlFor={id} className="font-medium cursor-pointer">
            {label}
          </label>
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
      </div>
    );
  },
);
