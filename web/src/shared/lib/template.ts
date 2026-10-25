/**
 * Client-side mirror of the server's `{{var}}` rendering, used ONLY for the live preview. The server remains the
 * authority at send time; this exists so the user sees what a recipient will see before pressing send.
 * Same rules: html values are escaped, subject/text are not, subjects can never contain line breaks.
 */
const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]{1,64})\s*\}\}/g;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const singleLine = (s: string) => s.replace(/[\r\n]+/g, " ");

export function renderTemplate(tpl: { subject: string; text?: string; html?: string }, vars: Record<string, string> = {}) {
  const sub = (src: string, esc: (s: string) => string) => src.replace(VAR_RE, (_m, name: string) => esc(vars[name] ?? ""));
  return {
    subject: singleLine(sub(tpl.subject, singleLine)),
    text: tpl.text !== undefined ? sub(tpl.text, (s) => s) : undefined,
    html: tpl.html !== undefined ? sub(tpl.html, escapeHtml) : undefined,
  };
}

/** Placeholders used in a template that have no value for the sample recipient (likely typos). */
export function missingVariables(texts: Array<string | undefined>, available: string[]): string[] {
  const used = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.matchAll(VAR_RE)) used.add(m[1]!);
  }
  return [...used].filter((v) => !available.includes(v));
}
