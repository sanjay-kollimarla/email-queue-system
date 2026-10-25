import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Send } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useApi } from "../../app/services";
import { ApiError } from "../../shared/api/http";
import { keys, useSmtpAccounts } from "../../shared/api/queries";
import { formatInt } from "../../shared/lib/format";
import { parseRecipients } from "../../shared/lib/recipients";
import { Button } from "../../shared/ui/button";
import { Card, CardHeader, PageHeader } from "../../shared/ui/card";
import { Input, Select, Textarea } from "../../shared/ui/field";
import { EmptyState, Segmented } from "../../shared/ui/misc";
import { Skeleton } from "../../shared/ui/spinner";
import { useToast } from "../../shared/ui/toast";
import { AttachmentPicker } from "./attachment-picker";
import { type Draft, type DraftIssues, MAX_BATCH, emptyDraft, hasIssues, validateDraft } from "./draft";
import { MessagePreview } from "./message-preview";

const SAMPLE_RECIPIENTS = "email,name,plan\nada@example.com,Ada,Pro\ngrace@example.com,Grace,Team";

/** key=value lines -> variables (single-send mode) */
function parseVars(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/**
 * Retrying the SAME payload reuses the same Idempotency-Key (so a timeout can never double-send); editing anything
 * generates a new one. The server dedupes on the key, which is what makes "press Send again" safe.
 */
function useIdempotencyKey() {
  const ref = useRef<{ payload: string; key: string } | null>(null);
  return {
    keyFor(payload: string) {
      if (ref.current?.payload !== payload) ref.current = { payload, key: crypto.randomUUID() };
      return ref.current.key;
    },
    reset() {
      ref.current = null;
    },
  };
}

interface Outcome {
  mode: Draft["mode"];
  count: number;
  queued: number;
  suppressed: number;
  replayed: number;
}

export function ComposePage() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const accounts = useSmtpAccounts();
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [varsText, setVarsText] = useState("");
  const [showIssues, setShowIssues] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const idem = useIdempotencyKey();

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setOutcome(null);
  };

  // default to the only account
  const smtpId = draft.smtpId || (accounts.data?.length === 1 ? accounts.data[0]!.id : "");
  const { issues, parsed } = useMemo(() => validateDraft({ ...draft, smtpId }), [draft, smtpId]);
  const batchParse = useMemo(() => parseRecipients(draft.recipientsText, MAX_BATCH), [draft.recipientsText]);

  const sampleVars = useMemo(
    () => (draft.mode === "single" ? parseVars(varsText) : (batchParse.recipients[0]?.vars ?? {})),
    [draft.mode, varsText, batchParse.recipients],
  );
  const variables = draft.mode === "single" ? Object.keys(sampleVars) : batchParse.variables;

  const send = useMutation({
    mutationFn: async () => {
      const content = {
        smtpId,
        priority: draft.priority,
        subject: draft.subject.trim(),
        ...(draft.format === "html" ? { html: draft.body } : { text: draft.body }),
        ...(draft.attachments.length
          ? {
              attachments: draft.attachments.map((a) => ({
                filename: a.filename,
                contentType: a.contentType,
                contentBase64: a.contentBase64,
              })),
            }
          : {}),
      };
      if (draft.mode === "single") {
        const vars = parseVars(varsText);
        const body = { ...content, to: parsed.recipients[0]!.to, ...(Object.keys(vars).length ? { vars } : {}) };
        const r = await api.emails.sendOne(body, idem.keyFor(JSON.stringify(body)));
        return {
          mode: "single",
          count: 1,
          queued: r.status === "queued" ? 1 : 0,
          suppressed: r.status === "suppressed" ? 1 : 0,
          replayed: r.replayed ? 1 : 0,
        } satisfies Outcome;
      }
      const body = { ...content, recipients: parsed.recipients };
      const r = await api.emails.sendBatch(body, idem.keyFor(JSON.stringify(body)));
      return { mode: "batch", count: r.count, queued: r.queued, suppressed: r.suppressed, replayed: r.replayed } satisfies Outcome;
    },
    onSuccess: async (o) => {
      setOutcome(o);
      idem.reset();
      setDraft((d) => ({ ...emptyDraft(), mode: d.mode, smtpId: d.smtpId, priority: d.priority }));
      setVarsText("");
      setShowIssues(false);
      toast.success(
        o.mode === "single" ? "Email accepted" : `${formatInt(o.count)} emails accepted`,
        "It is stored durably and will be delivered at your account's rate.",
      );
      await Promise.all([qc.invalidateQueries({ queryKey: keys.dashboard }), qc.invalidateQueries({ queryKey: keys.emails })]);
    },
    onError: (e) => toast.error("Could not send", e instanceof ApiError ? e.message : "Unexpected error"),
  });

  const submit = () => {
    setShowIssues(true);
    if (!hasIssues(issues)) send.mutate();
  };
  const shown: DraftIssues = showIssues ? issues : {};

  if (accounts.isPending) {
    return (
      <>
        <PageHeader title="Send" />
        <Skeleton className="h-96 rounded-2xl" />
      </>
    );
  }
  if (!accounts.data?.length) {
    return (
      <>
        <PageHeader title="Send" />
        <Card>
          <EmptyState
            icon={<Send className="size-6" />}
            title="Add an SMTP account first"
            description="Mail goes out through your own SMTP server. Connect one and declare its rate."
            action={
              <Link to="/smtp">
                <Button>Add SMTP account</Button>
              </Link>
            }
          />
        </Card>
      </>
    );
  }

  const recipientCount = draft.mode === "single" ? (draft.to ? 1 : 0) : batchParse.recipients.length;

  return (
    <>
      <PageHeader
        title="Send"
        description="One email, or a personalised campaign to up to 1,000 recipients per batch. Accepting is instant; delivery is paced to your account's rate."
      />

      {outcome && (
        <Card className="mb-4 border-ok/40 bg-ok-soft/40 p-4" role="status">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="size-5 text-ok" aria-hidden="true" />
              {outcome.mode === "single"
                ? "Accepted."
                : `${formatInt(outcome.count)} accepted: ${formatInt(outcome.queued)} queued${outcome.suppressed ? `, ${outcome.suppressed} suppressed` : ""}${outcome.replayed ? `, ${outcome.replayed} already sent earlier` : ""}.`}
            </p>
            <div className="flex gap-2">
              <Link to="/emails">
                <Button variant="secondary" size="sm">
                  View emails
                </Button>
              </Link>
              <Link to="/">
                <Button variant="secondary" size="sm">
                  Watch on dashboard
                </Button>
              </Link>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeader title="Compose" />
          <div className="grid gap-5 p-5">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
              <Segmented
                label="Mode"
                value={draft.mode}
                onChange={(mode) => patch({ mode })}
                options={[
                  { value: "single", label: "Single email" },
                  { value: "batch", label: "Campaign" },
                ]}
              />
              <Segmented
                label="Priority"
                value={draft.priority}
                onChange={(priority) => patch({ priority })}
                options={[
                  { value: "transactional", label: "Transactional", hint: "Jumps ahead of bulk mail (password resets, receipts)" },
                  { value: "bulk", label: "Bulk", hint: "Marketing and newsletters; gets one-click unsubscribe headers" },
                ]}
              />
            </div>

            <Select label="Send through" value={smtpId} onChange={(e) => patch({ smtpId: e.target.value })} error={shown.smtpId} required>
              <option value="">Choose an account…</option>
              {accounts.data.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.fromEmail})
                </option>
              ))}
            </Select>

            {draft.mode === "single" ? (
              <>
                <Input
                  label="To"
                  type="email"
                  placeholder="recipient@example.com"
                  value={draft.to}
                  onChange={(e) => patch({ to: e.target.value })}
                  error={shown.to}
                  required
                />
                <Textarea
                  label="Variables (optional)"
                  rows={2}
                  placeholder={"name=Ada\nplan=Pro"}
                  hint="One key=value per line; use {{name}} in the subject or body."
                  value={varsText}
                  onChange={(e) => setVarsText(e.target.value)}
                />
              </>
            ) : (
              <div>
                <Textarea
                  label="Recipients"
                  rows={6}
                  className="font-mono"
                  placeholder={SAMPLE_RECIPIENTS}
                  hint="One address per line. Start with a header row (email,name,plan) to personalise with {{name}}, {{plan}}."
                  value={draft.recipientsText}
                  onChange={(e) => patch({ recipientsText: e.target.value })}
                  error={shown.recipients}
                  required
                />
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted" aria-live="polite">
                  <span className="font-medium text-fg tabular">{formatInt(batchParse.recipients.length)} valid</span>
                  {batchParse.duplicates > 0 && <span>· {batchParse.duplicates} duplicates removed</span>}
                  {batchParse.errors.length > 0 && (
                    <span className="text-bad">
                      · {batchParse.errors.length} invalid (line {batchParse.errors[0]!.line}: {batchParse.errors[0]!.value})
                    </span>
                  )}
                  {batchParse.variables.length > 0 && <span>· variables: {batchParse.variables.map((v) => `{{${v}}}`).join(" ")}</span>}
                  {draft.recipientsText === "" && (
                    <button
                      type="button"
                      className="font-medium text-accent hover:underline"
                      onClick={() => patch({ recipientsText: SAMPLE_RECIPIENTS })}
                    >
                      Insert an example
                    </button>
                  )}
                </div>
              </div>
            )}

            <Input
              label="Subject"
              value={draft.subject}
              onChange={(e) => patch({ subject: e.target.value })}
              error={shown.subject}
              placeholder="Welcome, {{name}}!"
              required
            />

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <span className="text-sm font-medium">Message</span>
                <Segmented
                  label="Format"
                  value={draft.format}
                  onChange={(format) => patch({ format })}
                  options={[
                    { value: "text", label: "Plain text" },
                    { value: "html", label: "HTML" },
                  ]}
                />
              </div>
              <Textarea
                label="Message body"
                hideLabel
                rows={9}
                className={draft.format === "html" ? "font-mono" : undefined}
                value={draft.body}
                onChange={(e) => patch({ body: e.target.value })}
                error={shown.body}
                placeholder={draft.format === "html" ? "<h1>Hi {{name}}</h1>" : "Hi {{name}},\n\n…"}
              />
            </div>

            <AttachmentPicker value={draft.attachments} onChange={(attachments) => patch({ attachments })} error={shown.attachments} />

            <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-xs text-muted">
                {recipientCount > 0 ? `${formatInt(recipientCount)} recipient${recipientCount > 1 ? "s" : ""} · ` : ""}
                Safe to retry: duplicate submissions are ignored.
              </p>
              <Button onClick={submit} loading={send.isPending} icon={<Send className="size-4" />}>
                {draft.mode === "single" ? "Send email" : `Send to ${formatInt(batchParse.recipients.length)}`}
              </Button>
            </div>
          </div>
        </Card>

        <div className="grid content-start gap-4">
          <Card>
            <CardHeader title="Preview" description="What the first recipient will see" />
            <div className="p-5">
              <MessagePreview
                draft={draft}
                sampleTo={draft.mode === "single" ? draft.to : (batchParse.recipients[0]?.to ?? "")}
                sampleVars={sampleVars}
                variables={variables}
              />
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
