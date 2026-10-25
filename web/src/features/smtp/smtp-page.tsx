import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Gauge, Plus, RefreshCw, Server, Trash2, TriangleAlert, Webhook } from "lucide-react";
import { useState } from "react";
import { useApi } from "../../app/services";
import type { NewSmtpAccount } from "../../shared/api/endpoints";
import { ApiError } from "../../shared/api/http";
import { keys, useSmtpAccounts } from "../../shared/api/queries";
import type { SmtpAccount } from "../../shared/api/schemas";
import { formatDateTime, formatRate } from "../../shared/lib/format";
import { Button } from "../../shared/ui/button";
import { Card, PageHeader } from "../../shared/ui/card";
import { ConfirmDialog, Dialog } from "../../shared/ui/dialog";
import { CopyButton, EmptyState } from "../../shared/ui/misc";
import { Skeleton } from "../../shared/ui/spinner";
import { Badge } from "../../shared/ui/status-badge";
import { useToast } from "../../shared/ui/toast";
import { CreateSmtpForm, EditLimitsForm } from "./smtp-form";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "Unexpected error");

function useSmtpMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: keys.smtp }), qc.invalidateQueries({ queryKey: keys.dashboard })]);

  return {
    create: useMutation({
      mutationFn: (a: NewSmtpAccount) => api.smtp.create(a),
      onSuccess: async (acct) => {
        await refresh();
        toast.success("SMTP account verified and saved", `${acct.name} can now send at up to ${formatRate(acct.rate.ceilingPerSec)}.`);
      },
    }),
    updateLimits: useMutation({
      mutationFn: (v: { id: string; limits: NewSmtpAccount["limits"] }) => api.smtp.update(v.id, { limits: v.limits }),
      onSuccess: async () => {
        await refresh();
        toast.success("Limits updated");
      },
    }),
    verify: useMutation({
      mutationFn: (id: string) => api.smtp.verify(id),
      onSuccess: async () => {
        await refresh();
        toast.success("Credentials verified", "Held emails will resume.");
      },
      onError: (e) => toast.error("Verification failed", errMsg(e)),
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.smtp.remove(id),
      onSuccess: async () => {
        await refresh();
        toast.success("SMTP account deleted");
      },
      onError: (e) => toast.error("Could not delete", errMsg(e)),
    }),
  };
}

function SmtpCard({
  account,
  onEdit,
  onDelete,
  onVerify,
  verifying,
}: {
  account: SmtpAccount;
  onEdit: () => void;
  onDelete: () => void;
  onVerify: () => void;
  verifying: boolean;
}) {
  const { rate } = account;
  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            {account.name}
            {account.health === "ok" ? (
              <Badge tone="ok">
                <CheckCircle2 className="size-3.5" aria-hidden="true" /> Verified
              </Badge>
            ) : (
              <Badge tone="bad">
                <TriangleAlert className="size-3.5" aria-hidden="true" /> Credentials rejected
              </Badge>
            )}
          </h3>
          <p className="mt-0.5 text-sm text-muted">
            {account.username} @ {account.host}:{account.port} · {account.secure ? "TLS" : "STARTTLS"} · from{" "}
            {account.fromName ? `${account.fromName} ` : ""}&lt;{account.fromEmail}&gt;
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="secondary" size="sm" onClick={onVerify} loading={verifying} icon={<RefreshCw className="size-4" />}>
            Verify
          </Button>
          <Button variant="secondary" size="sm" onClick={onEdit} icon={<Gauge className="size-4" />}>
            Limits
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            aria-label={`Delete ${account.name}`}
            icon={<Trash2 className="size-4 text-bad" />}
          />
        </div>
      </div>

      {account.health === "auth_failed" && account.healthDetail && (
        <p role="alert" className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">
          {account.healthDetail} Update the password, then press Verify: queued mail is held (not lost) and resumes.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted">Allowed ceiling</dt>
          <dd className="font-semibold tabular">{formatRate(rate.ceilingPerSec)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Sending now</dt>
          <dd className="font-semibold tabular">{formatRate(rate.currentPerSec)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Learned provider limit</dt>
          <dd className="font-semibold tabular">{rate.learnedLimitPerSec ? formatRate(rate.learnedLimitPerSec) : "n/a"}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Daily cap (24h)</dt>
          <dd className="font-semibold tabular">{rate.dailyCap ? rate.dailyCap.toLocaleString() : "none"}</dd>
        </div>
      </dl>

      {account.webhookUrl && (
        <div className="mt-4 rounded-xl bg-subtle p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <Webhook className="size-3.5" aria-hidden="true" /> Bounce & complaint webhook
            </span>
            <CopyButton value={account.webhookUrl} label="Copy URL" />
          </div>
          <code className="mt-1 block truncate text-xs text-muted" title={account.webhookUrl}>
            {account.webhookUrl}
          </code>
          <p className="mt-1 text-xs text-muted">
            Point SES (via SNS), SendGrid or Mailgun at this URL so bounces and spam complaints suppress recipients automatically.
          </p>
        </div>
      )}
      <p className="mt-3 text-xs text-muted">
        Added {formatDateTime(account.createdAt)}
        {account.verifiedAt ? ` · last verified ${formatDateTime(account.verifiedAt)}` : ""}
      </p>
    </Card>
  );
}

export function SmtpPage() {
  const { data, isPending, isError, refetch } = useSmtpAccounts();
  const m = useSmtpMutations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SmtpAccount | null>(null);
  const [deleting, setDeleting] = useState<SmtpAccount | null>(null);

  return (
    <>
      <PageHeader
        title="SMTP accounts"
        description="The servers your email goes out through. Each one has a declared rate limit that we never exceed."
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            Add account
          </Button>
        }
      />

      {isPending ? (
        <div className="grid gap-4">
          <Skeleton className="h-44 rounded-2xl" />
        </div>
      ) : isError ? (
        <Card>
          <EmptyState
            icon={<TriangleAlert className="size-6" />}
            title="Could not load SMTP accounts"
            action={<Button onClick={() => void refetch()}>Retry</Button>}
          />
        </Card>
      ) : data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Server className="size-6" />}
            title="No SMTP account yet"
            description="Add the server you send mail through. We verify the credentials before saving."
            action={<Button onClick={() => setCreating(true)}>Add your first account</Button>}
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          {data.map((a) => (
            <SmtpCard
              key={a.id}
              account={a}
              onEdit={() => setEditing(a)}
              onDelete={() => setDeleting(a)}
              onVerify={() => m.verify.mutate(a.id)}
              verifying={m.verify.isPending && m.verify.variables === a.id}
            />
          ))}
        </div>
      )}

      <Dialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Add SMTP account"
        description="We connect and authenticate before saving."
      >
        <CreateSmtpForm
          onCancel={() => setCreating(false)}
          onSubmit={async (a) => {
            await m.create.mutateAsync(a);
            setCreating(false);
          }}
        />
      </Dialog>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={`Limits for ${editing?.name ?? ""}`}>
        {editing && (
          <EditLimitsForm
            account={editing}
            onCancel={() => setEditing(null)}
            onSubmit={async (limits) => {
              await m.updateLimits.mutateAsync({ id: editing.id, limits });
              setEditing(null);
            }}
          />
        )}
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete SMTP account?"
        message={
          <>
            <b>{deleting?.name}</b> will be removed. Emails still queued for it will be marked failed. This cannot be undone.
          </>
        }
        confirmLabel="Delete account"
        loading={m.remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await m.remove.mutateAsync(deleting.id);
          setDeleting(null);
        }}
      />
    </>
  );
}
