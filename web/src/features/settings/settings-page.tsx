import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useApi, useServices } from "../../app/services";
import { ApiError } from "../../shared/api/http";
import { type ThemeChoice, useTheme } from "../../shared/theme/theme";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader, PageHeader } from "../../shared/ui/card";
import { Input } from "../../shared/ui/field";
import { CopyButton, Segmented } from "../../shared/ui/misc";
import { useToast } from "../../shared/ui/toast";
import { useUser } from "../auth/auth-context";

const schema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z.string().min(10, "Use at least 10 characters").max(128),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ["confirm"], message: "Passwords do not match" })
  .refine((v) => v.newPassword !== v.currentPassword, { path: ["newPassword"], message: "Choose a different password" });

function ChangePassword() {
  const api = useApi();
  const { tokens } = useServices();
  const toast = useToast();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), mode: "onTouched" });

  return (
    <Card>
      <CardHeader title="Change password" description="Signs you out of every other device." />
      <form
        noValidate
        className="grid max-w-md gap-4 p-5"
        onSubmit={handleSubmit(async (v) => {
          try {
            const r = await api.auth.changePassword(v.currentPassword, v.newPassword);
            tokens.set(r.accessToken); // this device stays signed in on the new session
            reset();
            toast.success("Password changed", "Other devices have been signed out.");
          } catch (e) {
            if (e instanceof ApiError && e.status === 401) setError("currentPassword", { message: "That is not your current password" });
            else setError("root", { message: e instanceof ApiError ? e.message : "Unexpected error" });
          }
        })}
      >
        <Input
          label="Current password"
          type="password"
          autoComplete="current-password"
          error={errors.currentPassword?.message}
          {...register("currentPassword")}
        />
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters"
          error={errors.newPassword?.message}
          {...register("newPassword")}
        />
        <Input
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          error={errors.confirm?.message}
          {...register("confirm")}
        />
        {errors.root?.message && (
          <p role="alert" className="rounded-lg bg-bad-soft px-3 py-2 text-sm font-medium text-bad">
            {errors.root.message}
          </p>
        )}
        <div>
          <Button type="submit" loading={isSubmitting}>
            Update password
          </Button>
        </div>
      </form>
    </Card>
  );
}

const CURL = (origin: string) => `# 1. sign in and keep the token
TOKEN=$(curl -s ${origin}/v1/auth/login -H 'content-type: application/json' \\
  -d '{"email":"you@example.com","password":"…"}' | jq -r .accessToken)

# 2. send an email (the Idempotency-Key makes retries safe)
curl -s ${origin}/v1/emails -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' -H 'idempotency-key: order-1042' \\
  -d '{"to":"ada@example.com","subject":"Hi","text":"Hello from the API"}'`;

export function SettingsPage() {
  const user = useUser();
  const { choice, setChoice } = useTheme();
  const snippet = CURL(window.location.origin);

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid max-w-3xl gap-4">
        <Card>
          <CardHeader title="Account" />
          <dl className="grid gap-3 p-5 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-muted">Email</dt>
            <dd className="font-medium">{user.email}</dd>
            <dt className="text-muted">Account ID</dt>
            <dd>
              <code className="text-xs">{user.id}</code>
            </dd>
          </dl>
        </Card>

        <Card>
          <CardHeader title="Appearance" />
          <div className="p-5">
            <Segmented<ThemeChoice>
              label="Theme"
              value={choice}
              onChange={setChoice}
              options={[
                { value: "system", label: "System" },
                { value: "light", label: "Light" },
                { value: "dark", label: "Dark" },
              ]}
            />
          </div>
        </Card>

        <ChangePassword />

        <Card>
          <CardHeader
            title="Use the API"
            description="Everything in this app is available over HTTP."
            action={<CopyButton value={snippet} label="Copy" />}
          />
          <div className="p-5">
            <pre className="overflow-x-auto rounded-xl bg-subtle p-4 text-xs leading-relaxed">
              <code>{snippet}</code>
            </pre>
            <p className="mt-3 text-xs text-muted">
              Full reference: <code>docs/openapi.yaml</code> in the repository. Access tokens last 15 minutes; refresh them at{" "}
              <code>/v1/auth/refresh</code>.
            </p>
          </div>
        </Card>
      </div>
    </>
  );
}
