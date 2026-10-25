import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, Gauge, Send, Server, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useApi } from "../../app/services";
import { keys } from "../../shared/api/queries";
import { cn } from "../../shared/lib/cn";
import { formatCompact, formatRate, formatRelative } from "../../shared/lib/format";
import { useNow } from "../../shared/lib/use-now";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader, PageHeader } from "../../shared/ui/card";
import { EmptyState } from "../../shared/ui/misc";
import { Skeleton } from "../../shared/ui/spinner";
import { StatusBadge } from "../../shared/ui/status-badge";
import { DemoPanel } from "../demo/demo-panel";
import { AccountRate } from "./account-rates";
import { PipelineFlow } from "./pipeline-flow";
import { ThroughputChart } from "./throughput-chart";

const POLL_MS = 2000;

function StatCard({
  label,
  value,
  icon,
  tone,
  caption,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  tone: string;
  caption?: string;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">{label}</span>
        <span className={cn("flex size-7 items-center justify-center rounded-lg", tone)} aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="mt-2 text-3xl font-semibold tabular tracking-tight">{value}</div>
      {caption && <div className="mt-0.5 text-xs text-muted">{caption}</div>}
    </Card>
  );
}

function LiveIndicator({ updatedAt, error }: { updatedAt: number; error: boolean }) {
  const now = useNow();
  return (
    <div className="flex items-center gap-2 text-xs text-muted" role="status">
      <span
        className={cn("size-2 rounded-full", error ? "bg-bad" : "bg-ok animate-[pulse-ring_1.6s_ease-out_infinite]")}
        aria-hidden="true"
      />
      {error ? "Connection lost: retrying" : updatedAt ? `Live · updated ${formatRelative(new Date(updatedAt), now)}` : "Connecting…"}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-4" role="status" aria-busy="true" aria-label="Loading dashboard">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
          <Skeleton key={i} className="h-28 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-52 rounded-2xl" />
      <Skeleton className="h-72 rounded-2xl" />
    </div>
  );
}

export function DashboardPage() {
  const api = useApi();
  const { data, isPending, isError, dataUpdatedAt } = useQuery({
    queryKey: keys.dashboard,
    queryFn: ({ signal }) => api.dashboard.get(signal),
    refetchInterval: POLL_MS,
    placeholderData: keepPreviousData,
  });

  if (isPending) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <DashboardSkeleton />
      </>
    );
  }
  if (!data) {
    return (
      <>
        <PageHeader title="Dashboard" />
        <Card>
          <EmptyState
            icon={<AlertTriangle className="size-6" />}
            title="Could not load the dashboard"
            description="The API did not answer. It will retry automatically."
          />
        </Card>
      </>
    );
  }

  const { counts, total, throughput, accounts, problems } = data;
  const sendingNow = throughput.sentPerSecNow > 0;
  const windowMinutes = Math.round((throughput.points.length * throughput.bucketSec) / 60);
  const problemCount = counts.failed + counts.bounced + counts.complained;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Everything about your deliveries, live."
        actions={
          <>
            <LiveIndicator updatedAt={dataUpdatedAt} error={isError} />
            <Link to="/send">
              <Button icon={<Send className="size-4" />} size="sm">
                Send email
              </Button>
            </Link>
          </>
        }
      />

      {accounts.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Server className="size-6" />}
            title="Connect your SMTP account to start"
            description="Add the SMTP server you already use (Gmail, Microsoft 365, SES, SendGrid, anything) and declare how fast it may send. We pace delivery to that rate."
            action={
              <Link to="/smtp">
                <Button>Add SMTP account</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          <section aria-label="Totals" className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <StatCard
              label="Delivered"
              value={formatCompact(counts.sent)}
              icon={<CheckCircle2 className="size-4" />}
              tone="bg-ok-soft text-ok"
              caption={`of ${formatCompact(total)} accepted`}
            />
            <StatCard
              label="In queue"
              value={formatCompact(counts.queued + counts.sending)}
              icon={<Clock className="size-4" />}
              tone="bg-info-soft text-info"
              caption={counts.sending ? `${counts.sending} sending now` : "waiting for rate"}
            />
            <StatCard
              label="Throughput"
              value={formatRate(throughput.sentPerSecNow)}
              icon={<Gauge className="size-4" />}
              tone="bg-accent-soft text-accent"
              caption={`peak ${formatRate(throughput.peakPerSec)} (${windowMinutes} min)`}
            />
            <StatCard
              label="Problems"
              value={formatCompact(problemCount)}
              icon={<XCircle className="size-4" />}
              tone={problemCount ? "bg-bad-soft text-bad" : "bg-subtle text-muted"}
              caption="failed, bounced, complaints"
            />
            <StatCard
              label="Suppressed"
              value={formatCompact(counts.suppressed)}
              icon={<AlertTriangle className="size-4" />}
              tone="bg-subtle text-muted"
              caption="never sent"
            />
          </section>

          <Card>
            <CardHeader title="Pipeline" description="Where every email is right now" />
            <div className="p-5">
              <PipelineFlow counts={counts} total={total} sendingNow={sendingNow} />
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
            <Card>
              <CardHeader
                title="Emails sent per second"
                description={`Last ${windowMinutes} minutes, ${throughput.bucketSec}-second buckets`}
              />
              <div className="px-3 py-4 sm:px-5">
                <ThroughputChart points={throughput.points} bucketSec={throughput.bucketSec} />
              </div>
            </Card>
            <Card>
              <CardHeader
                title="Recent problems"
                action={
                  <Link to="/emails" className="text-xs font-medium text-accent hover:underline">
                    View all
                  </Link>
                }
              />
              {problems.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-muted">Nothing went wrong. 🎉</p>
              ) : (
                <ul className="divide-y divide-line">
                  {problems.map((p) => (
                    <li key={p.id} className="px-5 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{p.to}</span>
                        <StatusBadge status={p.status} />
                      </div>
                      {p.reason && <p className="mt-1 line-clamp-2 text-xs text-muted">{p.reason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <CardHeader
              title="SMTP accounts"
              description="Declared ceiling vs what the adaptive controller is actually sending"
              action={
                <Link to="/smtp" className="text-xs font-medium text-accent hover:underline">
                  Manage
                </Link>
              }
            />
            <ul className="grid gap-4 p-5 md:grid-cols-2">
              {accounts.map((a) => (
                <AccountRate key={a.id} account={a} />
              ))}
            </ul>
          </Card>

          <DemoPanel accounts={accounts} />
        </div>
      )}
    </>
  );
}
