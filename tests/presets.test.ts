import { describe, expect, test } from "bun:test";
import { MissingRateError, detectProvider, resolveRate } from "../src/smtp/presets.ts";

describe("rate resolution (the user always declares the rate)", () => {
  test("declared perSecond is the ceiling", () => {
    expect(resolveRate("mail.example.com", { perSecond: 25 })).toMatchObject({ provider: "custom", ceilingPerSec: 25 });
  });
  test("perSecond and perMinute -> the stricter wins", () => {
    expect(resolveRate("mail.example.com", { perSecond: 10, perMinute: 120 }).ceilingPerSec).toBe(2);
  });
  test("perMinute alone converts to per second; perDay becomes the daily cap", () => {
    expect(resolveRate("mail.example.com", { perMinute: 30, perDay: 10_000 })).toMatchObject({
      ceilingPerSec: 0.5,
      dailyCap: 10_000,
    });
  });
  test("no declared rate is rejected, even for known providers", () => {
    expect(() => resolveRate("smtp.gmail.com")).toThrow(MissingRateError);
    expect(() => resolveRate("mail.example.com", { perDay: 100 })).toThrow(MissingRateError);
  });
  test("a known provider yields a hint, never a silent default", () => {
    const r = resolveRate("smtp.office365.com", { perMinute: 20 });
    expect(r.ceilingPerSec).toBeCloseTo(1 / 3);
    expect(r.dailyCap).toBeUndefined();
    expect(r.hint?.limits.perMinute).toBe(30);
    expect(r.hint?.maxConnections).toBe(3);
  });
  test("the error message carries the provider hint", () => {
    expect(() => resolveRate("smtp.office365.com")).toThrow(/Typical for this provider/);
  });
  test("provider detection is anchored (no lookalike hosts)", () => {
    expect(detectProvider("email-smtp.eu-west-1.amazonaws.com")?.provider).toBe("ses");
    expect(detectProvider("evil-smtp.gmail.com.attacker.io")).toBeNull();
  });
});
