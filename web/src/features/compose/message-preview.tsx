import { AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import { missingVariables, renderTemplate } from "../../shared/lib/template";
import type { Draft } from "./draft";

/**
 * Live preview of what the first recipient will see. HTML is shown in a sandboxed iframe with NO permissions (no
 * scripts, no forms, no same-origin access), so even hostile HTML typed or pasted here cannot touch the app.
 */
export function MessagePreview({
  draft,
  sampleTo,
  sampleVars,
  variables,
}: {
  draft: Draft;
  sampleTo: string;
  sampleVars: Record<string, string>;
  variables: string[];
}) {
  const rendered = useMemo(
    () =>
      renderTemplate({ subject: draft.subject, ...(draft.format === "html" ? { html: draft.body } : { text: draft.body }) }, sampleVars),
    [draft.subject, draft.format, draft.body, sampleVars],
  );
  const missing = useMemo(() => missingVariables([draft.subject, draft.body], variables), [draft.subject, draft.body, variables]);

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <div className="border-b border-line bg-subtle px-4 py-2.5 text-xs">
        <div className="text-muted">
          To: <span className="text-fg">{sampleTo || "recipient@example.com"}</span>
        </div>
        <div className="mt-0.5 truncate text-sm font-semibold text-fg">{rendered.subject || "(no subject)"}</div>
      </div>
      {draft.format === "html" ? (
        <iframe
          title="HTML message preview"
          sandbox=""
          srcDoc={`<!doctype html><meta charset="utf-8"><base target="_blank"><body style="font-family:system-ui,sans-serif;font-size:14px;margin:16px">${rendered.html ?? ""}</body>`}
          className="h-56 w-full bg-white"
        />
      ) : (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words p-4 font-sans text-sm leading-relaxed">
          {rendered.text || "Your message appears here."}
        </pre>
      )}
      {missing.length > 0 && (
        <p className="flex items-start gap-2 border-t border-line bg-warn-soft px-4 py-2 text-xs text-warn" role="status">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            No value for {missing.map((m) => `{{${m}}}`).join(", ")}: it will be empty.{" "}
            {variables.length
              ? `Available: ${variables.map((v) => `{{${v}}}`).join(", ")}.`
              : "Batch mode can supply columns in the first row."}
          </span>
        </p>
      )}
    </div>
  );
}
