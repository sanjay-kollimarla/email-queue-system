/**
 * Minimal {{var}} templating. Stored once per distinct content (templates collection), so a
 * 1M-recipient campaign stores its HTML once instead of 1M times; each email only keeps its vars.
 */
const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]{1,64})\s*\}\}/g;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Strip CR/LF so a variable can never inject extra mail headers. */
const singleLine = (s: string) => s.replace(/[\r\n]+/g, " ");

export function renderTemplate(tpl: { subject: string; text?: string; html?: string }, vars: Record<string, string> = {}) {
  const sub = (src: string, esc: (s: string) => string) => src.replace(VAR_RE, (_m, name: string) => esc(vars[name] ?? ""));
  return {
    subject: singleLine(sub(tpl.subject, singleLine)),
    text: tpl.text != null ? sub(tpl.text, (s) => s) : undefined,
    html: tpl.html != null ? sub(tpl.html, escapeHtml) : undefined,
  };
}
