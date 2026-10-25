/**
 * Parses pasted recipient lists. Accepted shapes (one recipient per line):
 *
 *   ada@example.com
 *   ada@example.com, Ada, Lovelace          <- extra columns need a header row to become variables
 *
 *   email,name,plan                          <- header row (first cell is "email" or "to")
 *   ada@example.com,Ada,pro
 *
 * Header cells become template variables ({{name}}, {{plan}}). Pure functions: no DOM, easy to test.
 */
export interface ParsedRecipient {
  to: string;
  vars?: Record<string, string>;
}

export interface ParseResult {
  recipients: ParsedRecipient[];
  /** columns usable as {{variables}} */
  variables: string[];
  errors: Array<{ line: number; value: string; reason: string }>;
  duplicates: number;
}

// deliberately the same shape the API enforces: no spaces, one @, a dot in the domain
const EMAIL_RE = /^[^\s@<>(),;:\\"[\]]+@[^\s@<>(),;:\\"[\]]+\.[^\s@<>(),;:\\"[\]]+$/;
export const isEmail = (v: string) => v.length <= 254 && EMAIL_RE.test(v);

/** Minimal RFC-4180-ish line splitter: commas/tabs/semicolons, double-quoted cells with "" escapes. */
export function splitCells(line: string): string[] {
  const delimiter = line.includes("\t") ? "\t" : line.includes(";") && !line.includes(",") ? ";" : ",";
  const cells: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

const VAR_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

export function parseRecipients(text: string, max = 1000): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l, i) => ({ raw: l.trim(), line: i + 1 }))
    .filter((l) => l.raw !== "");
  const result: ParseResult = { recipients: [], variables: [], errors: [], duplicates: 0 };
  if (lines.length === 0) return result;

  const first = splitCells(lines[0]!.raw);
  const hasHeader = ["email", "to", "e-mail"].includes((first[0] ?? "").toLowerCase());
  const header = hasHeader ? first.map((h) => h.trim()) : [];
  const body = hasHeader ? lines.slice(1) : lines;
  result.variables = header.slice(1).filter((h) => VAR_NAME.test(h));

  const seen = new Set<string>();
  for (const { raw, line } of body) {
    const cells = splitCells(raw);
    const to = (cells[0] ?? "").trim();
    if (!isEmail(to)) {
      result.errors.push({ line, value: to || raw, reason: "not a valid email address" });
      continue;
    }
    const key = to.toLowerCase();
    if (seen.has(key)) {
      result.duplicates++;
      continue;
    }
    seen.add(key);
    const vars: Record<string, string> = {};
    header.slice(1).forEach((name, i) => {
      const value = cells[i + 1];
      if (VAR_NAME.test(name) && value !== undefined && value !== "") vars[name] = value;
    });
    result.recipients.push(Object.keys(vars).length ? { to, vars } : { to });
  }
  if (result.recipients.length > max) {
    result.errors.push({ line: 0, value: `${result.recipients.length} recipients`, reason: `at most ${max} per batch` });
  }
  return result;
}
