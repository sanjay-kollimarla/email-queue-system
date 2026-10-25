import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldOff, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { useApi } from "../../app/services";
import { ApiError } from "../../shared/api/http";
import { keys } from "../../shared/api/queries";
import { formatRelative } from "../../shared/lib/format";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader, PageHeader } from "../../shared/ui/card";
import { ConfirmDialog } from "../../shared/ui/dialog";
import { Input } from "../../shared/ui/field";
import { EmptyState } from "../../shared/ui/misc";
import { Skeleton } from "../../shared/ui/spinner";
import { Badge } from "../../shared/ui/status-badge";
import { useToast } from "../../shared/ui/toast";

const schema = z.object({ email: z.email("Enter a valid email address") });

/** Where a suppression came from, in words a customer understands. */
function reasonBadge(reason: string) {
  const r = reason.toLowerCase();
  if (r.startsWith("unsubscribed")) return <Badge tone="info">Unsubscribed</Badge>;
  if (r.startsWith("complaint")) return <Badge tone="violet">Complaint</Badge>;
  if (r.startsWith("manual")) return <Badge>Added by you</Badge>;
  return <Badge tone="bad">Bounced</Badge>;
}

export function SuppressionsPage() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [removing, setRemoving] = useState<string | null>(null);
  const list = useQuery({ queryKey: keys.suppressions, queryFn: async () => (await api.suppressions.list()).items });

  const add = useMutation({
    mutationFn: (email: string) => api.suppressions.add(email.toLowerCase(), "manual"),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.suppressions });
      toast.success("Recipient suppressed", "We will never send to this address.");
    },
  });
  const remove = useMutation({
    mutationFn: (email: string) => api.suppressions.remove(email),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.suppressions });
      toast.success("Suppression removed");
    },
    onError: (e) => toast.error("Could not remove", e instanceof ApiError ? e.message : "Unexpected error"),
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema) });

  return (
    <>
      <PageHeader
        title="Suppression list"
        description="Addresses we will never send to. Hard bounces, spam complaints and unsubscribes are added automatically, because mailing them again damages your sender reputation."
      />

      <Card className="mb-4">
        <CardHeader title="Suppress an address" />
        <form
          noValidate
          className="flex flex-wrap items-start gap-3 p-5"
          onSubmit={handleSubmit(async ({ email }) => {
            try {
              await add.mutateAsync(email);
              reset();
            } catch (e) {
              setError("email", { message: e instanceof ApiError ? e.message : "Unexpected error" });
            }
          })}
        >
          <Input
            label="Email address"
            hideLabel
            placeholder="someone@example.com"
            wrapperClassName="min-w-64 flex-1"
            error={errors.email?.message}
            {...register("email")}
          />
          <Button type="submit" loading={isSubmitting}>
            Suppress
          </Button>
        </form>
      </Card>

      <Card className="overflow-hidden">
        {list.isPending ? (
          <div className="p-4">
            <Skeleton className="h-40" />
          </div>
        ) : !list.data || list.data.length === 0 ? (
          <EmptyState
            icon={<ShieldOff className="size-6" />}
            title="Nobody is suppressed"
            description="Bounces, complaints and unsubscribes will appear here automatically."
          />
        ) : (
          <ul className="divide-y divide-line">
            {list.data.map((s) => (
              <li key={s.email} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{s.email}</p>
                  <p className="truncate text-xs text-muted">
                    {s.reason} · {formatRelative(s.createdAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {reasonBadge(s.reason)}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove ${s.email} from the suppression list`}
                    onClick={() => setRemoving(s.email)}
                    icon={<Trash2 className="size-4 text-bad" />}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={removing !== null}
        title="Remove suppression?"
        message={
          <>
            We will be able to send to <b>{removing}</b> again. Only do this if they asked to hear from you.
          </>
        }
        confirmLabel="Remove"
        loading={remove.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (removing) await remove.mutateAsync(removing);
          setRemoving(null);
        }}
      />
    </>
  );
}
