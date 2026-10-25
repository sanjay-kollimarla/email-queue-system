import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useApi } from "../../app/services";
import type { NewSmtpAccount } from "../../shared/api/endpoints";
import { ApiError } from "../../shared/api/http";
import type { SmtpAccount } from "../../shared/api/schemas";
import { useDebounce } from "../../shared/lib/use-debounce";
import { Button } from "../../shared/ui/button";
import { Input, Switch } from "../../shared/ui/field";

/** Optional positive number typed as text: "" means "not set". */
const optionalNumber = (label: string, opts: { int?: boolean } = {}) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || (Number.isFinite(Number(v)) && Number(v) > 0), `${label} must be a positive number`)
    .refine((v) => v === "" || !opts.int || Number.isInteger(Number(v)), `${label} must be a whole number`);

const limitsShape = {
  perSecond: optionalNumber("Per second"),
  perMinute: optionalNumber("Per minute"),
  perDay: optionalNumber("Per day", { int: true }),
};
const atLeastOneRate = (v: { perSecond: string; perMinute: string }) => v.perSecond !== "" || v.perMinute !== "";
const RATE_REQUIRED = { message: "Declare at least a per-second or a per-minute limit", path: ["perSecond"] };

const createSchema = z
  .object({
    name: z.string().trim().min(1, "Give it a name").max(80),
    host: z.string().trim().min(1, "Enter the SMTP host").max(253),
    port: z.coerce.number().int().min(1).max(65535),
    secure: z.boolean(),
    username: z.string().trim().min(1, "Enter the username"),
    password: z.string().min(1, "Enter the password"),
    fromEmail: z.email("Enter a valid sender address"),
    fromName: z.string().trim().max(120),
    maxConnections: z.coerce.number().int().min(1).max(50),
    ...limitsShape,
  })
  .refine(atLeastOneRate, RATE_REQUIRED);

const limitsSchema = z.object(limitsShape).refine(atLeastOneRate, RATE_REQUIRED);

type CreateValues = z.input<typeof createSchema>;
type LimitsValues = z.input<typeof limitsSchema>;

const num = (v: string) => (v === "" ? undefined : Number(v));
const toLimits = (v: LimitsValues) => ({ perSecond: num(v.perSecond), perMinute: num(v.perMinute), perDay: num(v.perDay) });

function serverError(e: unknown): string {
  return e instanceof ApiError ? e.message : "Could not reach the server.";
}

function RateFields({
  register,
  errors,
}: {
  register: ReturnType<typeof useForm<LimitsValues>>["register"];
  errors: Record<string, { message?: string } | undefined>;
}) {
  return (
    <fieldset className="grid gap-3 rounded-xl border border-line p-4">
      <legend className="px-1 text-sm font-semibold">Rate limit your SMTP account allows</legend>
      <p className="-mt-1 text-xs text-muted">
        SMTP can't report its own limits, so you declare them. This is the hard ceiling: we never send faster, and we slow down further if
        the server pushes back.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Per second" inputMode="decimal" placeholder="e.g. 10" error={errors.perSecond?.message} {...register("perSecond")} />
        <Input label="Per minute" inputMode="decimal" placeholder="e.g. 30" error={errors.perMinute?.message} {...register("perMinute")} />
        <Input label="Per day (24h)" inputMode="numeric" placeholder="optional" error={errors.perDay?.message} {...register("perDay")} />
      </div>
    </fieldset>
  );
}

export function CreateSmtpForm({ onSubmit, onCancel }: { onSubmit: (a: NewSmtpAccount) => Promise<void>; onCancel: () => void }) {
  const api = useApi();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateValues>({
    resolver: zodResolver(createSchema),
    mode: "onTouched",
    defaultValues: {
      port: 587 as unknown as string,
      secure: false,
      maxConnections: 5 as unknown as string,
      perSecond: "",
      perMinute: "",
      perDay: "",
      fromName: "",
    },
  });

  const host = useDebounce(watch("host") ?? "", 450);
  const hint = useQuery({
    queryKey: ["smtp-hint", host.trim().toLowerCase()],
    queryFn: ({ signal }) => api.smtp.hints(host.trim(), signal),
    enabled: host.trim().length > 3,
    staleTime: 5 * 60_000,
  });
  const known = hint.data && hint.data.provider !== "custom" ? hint.data : null;

  const applyHint = () => {
    if (!known?.limits) return;
    const { perSecond, perMinute, perDay } = known.limits;
    setValue("perSecond", perSecond ? String(perSecond) : "", { shouldValidate: true });
    setValue("perMinute", perMinute ? String(perMinute) : "", { shouldValidate: true });
    setValue("perDay", perDay ? String(perDay) : "", { shouldValidate: true });
    if (known.maxConnections) setValue("maxConnections", known.maxConnections as unknown as string);
  };

  const submit = handleSubmit(async (raw) => {
    const v = createSchema.parse(raw);
    try {
      await onSubmit({
        name: v.name,
        host: v.host,
        port: v.port,
        secure: v.secure,
        username: v.username,
        password: v.password,
        fromEmail: v.fromEmail,
        fromName: v.fromName || undefined,
        maxConnections: v.maxConnections,
        limits: toLimits(v),
      });
    } catch (e) {
      setError("root", { message: serverError(e) });
    }
  });

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Name" placeholder="Company Gmail" required error={errors.name?.message} {...register("name")} />
        <Input
          label="SMTP host"
          placeholder="smtp.gmail.com"
          required
          autoCapitalize="none"
          error={errors.host?.message}
          {...register("host")}
        />
      </div>

      {known && (
        <div className="flex items-start gap-3 rounded-xl border border-accent/30 bg-accent-soft p-3 text-sm" role="note">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-medium capitalize">{known.provider} detected</p>
            <p className="text-xs text-muted">{known.note}</p>
            {known.limits && Object.keys(known.limits).length > 0 && (
              <Button variant="secondary" size="sm" onClick={applyHint} className="mt-2">
                Fill in the documented limits
              </Button>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <Input label="Port" type="number" required error={errors.port?.message} {...register("port")} />
        <div className="self-end pb-2">
          <Switch label="Use TLS from the start (port 465)" {...register("secure")} />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Username" autoComplete="off" required error={errors.username?.message} {...register("username")} />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          hint="Stored encrypted. Never shown again."
          error={errors.password?.message}
          {...register("password")}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="From address"
          type="email"
          placeholder="you@company.com"
          required
          error={errors.fromEmail?.message}
          {...register("fromEmail")}
        />
        <Input label="From name" placeholder="Company" error={errors.fromName?.message} {...register("fromName")} />
      </div>

      <RateFields register={register as never} errors={errors as never} />
      <Input
        label="Max parallel connections"
        type="number"
        hint="Many providers cap this (Microsoft 365 allows 3)."
        error={errors.maxConnections?.message}
        {...register("maxConnections")}
      />

      {errors.root?.message && (
        <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-medium text-bad">
          {errors.root.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={isSubmitting}>
          Verify and save
        </Button>
      </div>
    </form>
  );
}

export function EditLimitsForm({
  account,
  onSubmit,
  onCancel,
}: {
  account: SmtpAccount;
  onSubmit: (limits: ReturnType<typeof toLimits>) => Promise<void>;
  onCancel: () => void;
}) {
  const d = account.rate.declared;
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LimitsValues>({
    resolver: zodResolver(limitsSchema),
    mode: "onTouched",
    defaultValues: {
      perSecond: d.perSecond?.toString() ?? "",
      perMinute: d.perMinute?.toString() ?? "",
      perDay: d.perDay?.toString() ?? "",
    },
  });
  const submit = handleSubmit(async (v) => {
    try {
      await onSubmit(toLimits(v));
    } catch (e) {
      setError("root", { message: serverError(e) });
    }
  });
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <RateFields register={register} errors={errors as never} />
      <p className="text-xs text-muted">
        Changing limits resets what the controller learned about this provider; it re-discovers the real limit from the new ceiling.
      </p>
      {errors.root?.message && (
        <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-medium text-bad">
          {errors.root.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={isSubmitting}>
          Save limits
        </Button>
      </div>
    </form>
  );
}
