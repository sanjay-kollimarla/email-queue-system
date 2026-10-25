import { useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { useState } from "react";
import { useApi } from "../../app/services";
import { ApiError } from "../../shared/api/http";
import { keys, useMeta } from "../../shared/api/queries";
import type { SmtpAccount } from "../../shared/api/schemas";
import { formatInt } from "../../shared/lib/format";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader } from "../../shared/ui/card";
import { Meter } from "../../shared/ui/misc";
import { useToast } from "../../shared/ui/toast";

const SIZES = [500, 5_000, 25_000];
const BATCH = 1000;

/**
 * The demo campaign sends junk to example.com addresses, so it must NEVER run through a real SMTP account:
 * it is only offered for the account that points at the bundled fake SMTP server announced in /v1/meta.
 */
export function findDemoAccount(accounts: SmtpAccount[], demoSmtp?: { host: string; port: number }): SmtpAccount | undefined {
  if (!demoSmtp) return undefined;
  return accounts.find((a) => a.host.toLowerCase() === demoSmtp.host.toLowerCase() && a.port === demoSmtp.port);
}

/**
 * Demo-mode only: fires a synthetic campaign at the account so a visitor can WATCH the system work: the queue
 * fills instantly (accepting is fast), then drains at exactly the rate the account is allowed to send.
 */
export function DemoPanel({ accounts }: { accounts: SmtpAccount[] }) {
  const meta = useMeta();
  const api = useApi();
  const toast = useToast();
  const qc = useQueryClient();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const account = meta.data?.demo ? findDemoAccount(accounts, meta.data.demoSmtp) : undefined;
  if (!account) return null;

  const run = async (total: number) => {
    const runId = crypto.randomUUID();
    setProgress({ done: 0, total });
    try {
      for (let sent = 0, batch = 0; sent < total; batch++) {
        const size = Math.min(BATCH, total - sent);
        await api.emails.sendBatch(
          {
            smtpId: account.id,
            priority: "bulk",
            subject: "Hello {{name}}, your demo message",
            text: "Hi {{name}},\n\nThis is message #{{n}} from the Courier demo campaign.",
            recipients: Array.from({ length: size }, (_, i) => ({
              to: `person${sent + i}@example.com`,
              vars: { name: `Person ${sent + i}`, n: String(sent + i + 1) },
            })),
          },
          `${runId}-${batch}`, // a retried request can never double-send a batch
        );
        sent += size;
        setProgress({ done: sent, total });
        void qc.invalidateQueries({ queryKey: keys.dashboard });
      }
      toast.success(`${formatInt(total)} emails accepted`, "Watch them drain at the account's rate.");
    } catch (e) {
      toast.error("Demo campaign stopped", e instanceof ApiError ? e.message : "Unexpected error");
    } finally {
      setProgress(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Try it: send a demo campaign"
        description={`Accepting is instant; delivery is paced to ${account.name}'s declared rate.`}
        action={<Rocket className="size-5 text-accent" aria-hidden="true" />}
      />
      <div className="flex flex-wrap items-center gap-2 px-5 py-4">
        {SIZES.map((n) => (
          <Button key={n} variant="secondary" size="sm" disabled={progress !== null} onClick={() => void run(n)}>
            Send {formatInt(n)}
          </Button>
        ))}
        {progress && (
          <div className="ml-2 min-w-40 flex-1">
            <Meter value={progress.done} max={progress.total} label="Demo campaign submission progress" tone="ok" />
            <p className="mt-1 text-xs text-muted tabular">
              Submitting {formatInt(progress.done)} / {formatInt(progress.total)}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
