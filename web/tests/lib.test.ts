import { describe, expect, test } from "bun:test";
import { layoutSeries, nearestIndex, niceCeil } from "../src/features/dashboard/chart-math";
import { type Draft, emptyDraft, hasIssues, validateDraft } from "../src/features/compose/draft";
import { formatBytes, formatCompact, formatDuration, formatRate, formatRelative } from "../src/shared/lib/format";
import { isEmail, parseRecipients, splitCells } from "../src/shared/lib/recipients";
import { missingVariables, renderTemplate } from "../src/shared/lib/template";

describe("format", () => {
  test("rates keep useful precision", () => {
    expect(formatRate(0)).toBe("0/s");
    expect(formatRate(0.5)).toBe("0.50/s");
    expect(formatRate(12.34)).toBe("12.3/s");
    expect(formatRate(50)).toBe("50/s");
    expect(formatRate(1234.5)).toBe("1,235/s");
    expect(formatRate(null)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
  });
  test("compact numbers only kick in for big values", () => {
    expect(formatCompact(9_999)).toBe("9,999");
    expect(formatCompact(25_000)).toBe("25K");
    expect(formatCompact(1_200_000)).toBe("1.2M");
  });
  test("durations", () => {
    expect(formatDuration(3_000)).toBe("3s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatDuration(-5)).toBe("0s");
  });
  test("relative time", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(formatRelative("2026-01-01T11:59:58Z", now)).toBe("just now");
    expect(formatRelative("2026-01-01T11:58:00Z", now)).toBe("2 minutes ago");
    expect(formatRelative("2026-01-01T09:00:00Z", now)).toBe("3 hours ago");
  });
  test("bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("recipients parser", () => {
  test("plain list", () => {
    const r = parseRecipients("a@x.co\nb@x.co");
    expect(r.recipients).toEqual([{ to: "a@x.co" }, { to: "b@x.co" }]);
    expect(r.errors).toEqual([]);
  });
  test("header row turns columns into variables", () => {
    const r = parseRecipients("email,name,plan\nada@x.co,Ada,Pro\ngrace@x.co,Grace,");
    expect(r.variables).toEqual(["name", "plan"]);
    expect(r.recipients).toEqual([
      { to: "ada@x.co", vars: { name: "Ada", plan: "Pro" } },
      { to: "grace@x.co", vars: { name: "Grace" } },
    ]);
  });
  test("invalid rows are reported with their line number; duplicates are dropped case-insensitively", () => {
    const r = parseRecipients("a@x.co\nnope\nA@X.CO\nb@x.co");
    expect(r.recipients.map((x) => x.to)).toEqual(["a@x.co", "b@x.co"]);
    expect(r.duplicates).toBe(1);
    expect(r.errors).toEqual([{ line: 2, value: "nope", reason: "not a valid email address" }]);
  });
  test("quoted cells, tabs and semicolons", () => {
    expect(splitCells('a@x.co,"Lovelace, Ada",pro')).toEqual(["a@x.co", "Lovelace, Ada", "pro"]);
    expect(splitCells("a@x.co\tAda")).toEqual(["a@x.co", "Ada"]);
    expect(splitCells("a@x.co;Ada")).toEqual(["a@x.co", "Ada"]);
    expect(splitCells('"say ""hi"""')).toEqual(['say "hi"']);
  });
  test("injection-shaped addresses are rejected like the server does", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail("a@b.co\r\nBcc: x@y.co")).toBe(false);
    expect(isEmail("a b@c.co")).toBe(false);
    expect(isEmail("a@@b.co")).toBe(false);
  });
  test("a batch over the limit is flagged", () => {
    const text = Array.from({ length: 1001 }, (_, i) => `u${i}@x.co`).join("\n");
    expect(parseRecipients(text, 1000).errors.at(-1)?.reason).toBe("at most 1000 per batch");
  });
  test("blank input", () => {
    expect(parseRecipients("  \n\n").recipients).toEqual([]);
  });
});

describe("template preview (mirrors the server)", () => {
  test("html values are escaped, text and subject are not, subjects stay on one line", () => {
    const out = renderTemplate({ subject: "Hi {{name}}", text: "Hi {{name}}", html: "<b>{{name}}</b>" }, { name: "<i>Ada</i>\nBcc: x" });
    expect(out.html).toBe("<b>&lt;i&gt;Ada&lt;/i&gt;\nBcc: x</b>");
    expect(out.text).toBe("Hi <i>Ada</i>\nBcc: x");
    expect(out.subject).toBe("Hi <i>Ada</i> Bcc: x");
  });
  test("missing variables are reported", () => {
    expect(missingVariables(["Hi {{name}}", "{{plan}} {{name}}"], ["name"])).toEqual(["plan"]);
  });
});

describe("compose draft validation", () => {
  const base = (over: Partial<Draft> = {}): Draft => ({ ...emptyDraft(), smtpId: "abc", subject: "Hi", body: "Hello", ...over });
  test("single: needs a valid recipient", () => {
    expect(validateDraft(base({ to: "nope" })).issues.to).toBeDefined();
    expect(hasIssues(validateDraft(base({ to: "a@x.co" })).issues)).toBe(false);
  });
  test("every required piece is checked", () => {
    const { issues } = validateDraft({ ...emptyDraft() });
    expect(Object.keys(issues).sort()).toEqual(["body", "smtpId", "subject", "to"]);
  });
  test("batch: invalid rows block sending", () => {
    const v = validateDraft(base({ mode: "batch", recipientsText: "a@x.co\nbad" }));
    expect(v.issues.recipients).toContain("1 invalid");
  });
  test("batch: ok list parses to recipients", () => {
    const v = validateDraft(base({ mode: "batch", recipientsText: "email,name\na@x.co,Ada" }));
    expect(hasIssues(v.issues)).toBe(false);
    expect(v.parsed.recipients).toEqual([{ to: "a@x.co", vars: { name: "Ada" } }]);
  });
  test("attachment limits", () => {
    const file = (size: number) => ({ id: crypto.randomUUID(), filename: "f", contentType: "x/y", size, contentBase64: "" });
    expect(validateDraft(base({ to: "a@x.co", attachments: [file(5 * 1024 * 1024), file(4 * 1024 * 1024)] })).issues.attachments).toContain(
      "8 MB",
    );
    expect(validateDraft(base({ to: "a@x.co", attachments: Array.from({ length: 6 }, () => file(1)) })).issues.attachments).toContain(
      "At most 5",
    );
  });
});

describe("chart math", () => {
  test("niceCeil picks readable axis maxima", () => {
    expect(niceCeil(0)).toBe(1);
    expect(niceCeil(0.7)).toBe(1);
    expect(niceCeil(1.1)).toBe(2);
    expect(niceCeil(3)).toBe(5);
    expect(niceCeil(7)).toBe(10);
    expect(niceCeil(130)).toBe(200);
    expect(niceCeil(Number.NaN)).toBe(1);
  });
  const box = { width: 100, height: 60, padLeft: 10, padRight: 10, padTop: 10, padBottom: 10 };
  test("layout spans the inner box; zero is the baseline; the peak is below the top", () => {
    const l = layoutSeries(
      [
        { at: "2026-01-01T00:00:00Z", perSec: 0 },
        { at: "2026-01-01T00:00:10Z", perSec: 50 },
        { at: "2026-01-01T00:00:20Z", perSec: 0 },
      ],
      box,
    );
    expect(l.yMax).toBe(100);
    expect(l.points[0]!.x).toBe(10);
    expect(l.points.at(-1)!.x).toBe(90);
    expect(l.points[0]!.y).toBe(50); // baseline = padTop + innerH
    expect(l.points[1]!.y).toBe(30); // half of the axis
    expect(l.areaPath.endsWith("Z")).toBe(true);
  });
  test("empty and single-point series do not crash", () => {
    expect(layoutSeries([], box).linePath).toBe("");
    expect(layoutSeries([{ at: "2026-01-01T00:00:00Z", perSec: 3 }], box).points).toHaveLength(1);
  });
  test("nearestIndex for hover", () => {
    const l = layoutSeries(
      Array.from({ length: 5 }, (_, i) => ({ at: new Date(i * 1000), perSec: i })),
      box,
    );
    expect(nearestIndex(l.points, 0)).toBe(0);
    expect(nearestIndex(l.points, 49)).toBe(2);
    expect(nearestIndex(l.points, 500)).toBe(4);
  });
});
