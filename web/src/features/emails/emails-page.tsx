import { useInfiniteQuery } from "@tanstack/react-query";
import { Inbox, Paperclip, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../app/services";
import { keys } from "../../shared/api/queries";
import { EMAIL_STATUSES, type Email, type EmailStatus } from "../../shared/api/schemas";
import { cn } from "../../shared/lib/cn";
import { formatRelative } from "../../shared/lib/format";
import { useNow } from "../../shared/lib/use-now";
import { Button } from "../../shared/ui/button";
import { Card, PageHeader } from "../../shared/ui/card";
import { Switch } from "../../shared/ui/field";
import { EmptyState } from "../../shared/ui/misc";
import { Skeleton } from "../../shared/ui/spinner";
import { STATUS_META, StatusBadge } from "../../shared/ui/status-badge";
import { EmailDrawer } from "./email-drawer";

const PAGE = 50;

export function EmailsPage() {
  const api = useApi();
  const [status, setStatus] = useState<EmailStatus | undefined>();
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<Email | null>(null);
  const now = useNow(5000);

  const q = useInfiniteQuery({
    queryKey: [...keys.emails, status ?? "all"],
    queryFn: ({ pageParam }) => api.emails.list({ status, before: pageParam, limit: PAGE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // while "live", re-read the loaded pages so statuses move queued -> sent in front of you
    refetchInterval: live ? 3000 : false,
  });

  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);

  return (
    <>
      <PageHeader
        title="Emails"
        description="Every message you have sent, newest first."
        actions={
          <>
            <Switch label="Live" checked={live} onChange={(e) => setLive(e.target.checked)} />
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void q.refetch()}
              loading={q.isFetching && !q.isFetchingNextPage}
              icon={<RefreshCw className="size-4" />}
            >
              Refresh
            </Button>
          </>
        }
      />

      <fieldset className="mb-4 flex flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">Filter by status</legend>
        {[undefined, ...EMAIL_STATUSES].map((s) => {
          const active = s === status;
          return (
            <button
              key={s ?? "all"}
              type="button"
              aria-pressed={active}
              onClick={() => setStatus(s)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active ? "border-accent bg-accent-soft text-accent" : "border-line-strong text-muted hover:text-fg hover:bg-subtle",
              )}
            >
              {s ? STATUS_META[s].label : "All"}
            </button>
          );
        })}
      </fieldset>

      <Card className="overflow-hidden">
        {q.isPending ? (
          <div className="grid gap-px p-4" aria-busy="true">
            {Array.from({ length: 6 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              <Skeleton key={i} className="my-1 h-10" />
            ))}
          </div>
        ) : q.isError ? (
          <EmptyState
            icon={<Inbox className="size-6" />}
            title="Could not load emails"
            action={<Button onClick={() => void q.refetch()}>Retry</Button>}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Inbox className="size-6" />}
            title={status ? `No ${STATUS_META[status].label.toLowerCase()} emails` : "No emails yet"}
            description={status ? "Try another filter." : "Send your first email and it will show up here."}
            action={
              !status && (
                <Link to="/send">
                  <Button>Send an email</Button>
                </Link>
              )
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Emails, newest first</caption>
                <thead className="border-b border-line bg-subtle/60 text-xs text-muted">
                  <tr>
                    <th scope="col" className="px-5 py-2.5 font-medium">
                      Recipient
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Status
                    </th>
                    <th scope="col" className="hidden px-3 py-2.5 font-medium sm:table-cell">
                      Priority
                    </th>
                    <th scope="col" className="hidden px-3 py-2.5 text-right font-medium md:table-cell">
                      Attempts
                    </th>
                    <th scope="col" className="px-5 py-2.5 text-right font-medium">
                      When
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((e) => (
                    <tr key={e.id} className="group cursor-pointer hover:bg-subtle/60" onClick={() => setSelected(e)}>
                      <td className="max-w-0 px-5 py-3">
                        <button
                          type="button"
                          className="block max-w-full truncate text-left font-medium group-hover:text-accent"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setSelected(e);
                          }}
                        >
                          {e.to}
                        </button>
                        {e.lastError && e.status !== "sent" && <span className="block truncate text-xs text-muted">{e.lastError}</span>}
                      </td>
                      <td className="px-3 py-3">
                        <StatusBadge status={e.status} />
                      </td>
                      <td className="hidden px-3 py-3 capitalize text-muted sm:table-cell">{e.priority}</td>
                      <td className="hidden px-3 py-3 text-right tabular text-muted md:table-cell">{e.attempts}</td>
                      <td
                        className="whitespace-nowrap px-5 py-3 text-right text-muted tabular"
                        title={new Date(e.createdAt).toLocaleString()}
                      >
                        {formatRelative(e.sentAt ?? e.createdAt, now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-line px-5 py-3 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <Paperclip className="hidden" aria-hidden="true" />
                {rows.length} loaded
              </span>
              {q.hasNextPage ? (
                <Button variant="secondary" size="sm" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
                  Load more
                </Button>
              ) : (
                <span>End of list</span>
              )}
            </div>
          </>
        )}
      </Card>

      <EmailDrawer email={selected} onClose={() => setSelected(null)} />
    </>
  );
}
