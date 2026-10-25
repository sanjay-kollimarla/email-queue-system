import { describe, expect, test } from "bun:test";
import { JsonLogger } from "../src/lib/observability.ts";

const capture = (level?: "debug" | "info" | "warn" | "error" | "silent") => {
  const lines: Array<Record<string, unknown>> = [];
  return { lines, log: new JsonLogger("svc", (l) => lines.push(JSON.parse(l)), level) };
};

describe("JsonLogger", () => {
  test("writes one JSON object per line with service, level and fields", () => {
    const { lines, log } = capture("info");
    log.info("hello", { requestId: "r1" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", service: "svc", msg: "hello", requestId: "r1" });
    expect(typeof lines[0]!.ts).toBe("string");
  });

  test("the level filters lower-severity lines", () => {
    const { lines, log } = capture("warn");
    log.info("quiet");
    log.warn("loud");
    log.error("louder");
    expect(lines.map((l) => l.msg)).toEqual(["loud", "louder"]);
  });

  test("silent drops everything", () => {
    const { lines, log } = capture("silent");
    log.info("a");
    log.warn("b");
    log.error("c");
    expect(lines).toEqual([]);
  });
});
