import { describe, expect, test } from "bun:test";
import { classifySmtpError, parseRetryAfterMs } from "../src/smtp/classify.ts";

const smtpErr = (responseCode: number, response: string, code = "EPROTOCOL") =>
  Object.assign(new Error(response), { responseCode, response, code });

describe("classifySmtpError", () => {
  test("451 4.7.1 rate limit -> throttle", () => {
    expect(classifySmtpError(smtpErr(451, "451 4.7.1 Rate limit exceeded, try again later")).kind).toBe("throttle");
  });
  test("421 service not available -> throttle", () => {
    expect(classifySmtpError(smtpErr(421, "421 4.3.2 Service not available")).kind).toBe("throttle");
  });
  test("SES maximum sending rate -> throttle", () => {
    expect(classifySmtpError(smtpErr(454, "454 Throttling failure: Maximum sending rate exceeded")).kind).toBe("throttle");
  });
  test("Gmail / SES daily quota -> quota", () => {
    expect(classifySmtpError(smtpErr(550, "550 5.4.5 Daily user sending quota exceeded")).kind).toBe("quota");
    expect(classifySmtpError(smtpErr(454, "454 Daily message quota exceeded")).kind).toBe("quota");
  });
  test("auth failures", () => {
    expect(classifySmtpError(Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 })).kind).toBe("auth");
    expect(classifySmtpError(smtpErr(535, "535 5.7.8 Authentication failed")).kind).toBe("auth");
  });
  test("unknown mailbox -> permanent + suppress", () => {
    const o = classifySmtpError(smtpErr(550, "550 5.1.1 The email account that you tried to reach does not exist"));
    expect(o).toMatchObject({ kind: "permanent", suppress: true });
  });
  test("policy block -> permanent, no suppress", () => {
    expect(classifySmtpError(smtpErr(554, "554 5.7.1 Message rejected as spam"))).toMatchObject({
      kind: "permanent",
      suppress: false,
    });
  });
  test("greylisting 450 4.2.0 -> transient (not a throttle)", () => {
    expect(classifySmtpError(smtpErr(450, "450 4.2.0 Greylisted, please come back")).kind).toBe("transient");
  });
  test("network errors -> transient", () => {
    expect(classifySmtpError(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })).kind).toBe("transient");
    expect(classifySmtpError(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })).kind).toBe("transient");
  });
  test("unknown error -> transient", () => {
    expect(classifySmtpError(new Error("boom")).kind).toBe("transient");
  });
  test("Retry-After parsing", () => {
    expect(parseRetryAfterMs("try again, retry after 30 seconds")).toBe(30_000);
    expect(parseRetryAfterMs("retry in 2 minutes")).toBe(120_000);
    expect(parseRetryAfterMs("nothing here")).toBeUndefined();
  });
});
