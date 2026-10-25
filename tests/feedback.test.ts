import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { FeedbackService, type FeedbackStore } from "../src/core/feedback/feedback-service.ts";
import { GenericParser, MailgunParser, SendGridParser, SesSnsParser, snsSubscribeUrl } from "../src/core/feedback/parsers.ts";
import { UnsubscribeService, WebhookAccess } from "../src/core/feedback/unsubscribe-service.ts";
import { NotFoundError, ValidationError } from "../src/core/errors.ts";
import { HmacCapabilityTokens } from "../src/infra/security/adapters.ts";

const silent = { info() {}, warn() {}, error() {} };

describe("feedback parsers", () => {
  test("SES via SNS: permanent bounce -> hard_bounce, transient -> soft_bounce, complaint", () => {
    const sns = (message: unknown) => ({ Type: "Notification", Message: JSON.stringify(message) });
    const p = new SesSnsParser();
    const hard = sns({
      notificationType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [{ emailAddress: "Gone@Example.com", diagnosticCode: "550 5.1.1 unknown" }],
      },
      mail: { messageId: "ses-id" },
    });
    expect(p.matches(hard)).toBe(true);
    expect(p.parse(hard)).toEqual([
      { kind: "hard_bounce", email: "gone@example.com", reason: "General: 550 5.1.1 unknown", messageId: "ses-id" },
    ]);
    const soft = sns({
      notificationType: "Bounce",
      bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "a@b.co" }] },
      mail: {},
    });
    expect(p.parse(soft)[0]!.kind).toBe("soft_bounce");
    const complaint = sns({
      notificationType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: "c@d.co" }], complaintFeedbackType: "abuse" },
      mail: {},
    });
    expect(p.parse(complaint)[0]).toMatchObject({ kind: "complaint", email: "c@d.co" });
    expect(p.parse({ Type: "Notification", Message: "not json" })).toEqual([]);
  });

  test("SendGrid: bounce, blocked (soft), dropped, spamreport; delivered ignored", () => {
    const p = new SendGridParser();
    const body = [
      { event: "bounce", type: "bounce", email: "a@x.co", reason: "550 no such user" },
      { event: "bounce", type: "blocked", email: "b@x.co", reason: "blocked" },
      { event: "dropped", email: "c@x.co", reason: "bounced address" },
      { event: "spamreport", email: "d@x.co" },
      { event: "delivered", email: "e@x.co" },
    ];
    expect(p.matches(body)).toBe(true);
    expect(p.parse(body).map((e) => e.kind)).toEqual(["hard_bounce", "soft_bounce", "hard_bounce", "complaint"]);
  });

  test("Mailgun: permanent failure, temporary failure, complaint", () => {
    const p = new MailgunParser();
    const ev = (data: object) => ({ "event-data": data });
    expect(
      p.parse(ev({ event: "failed", severity: "permanent", recipient: "A@x.co", "delivery-status": { message: "550 gone" } }))[0],
    ).toMatchObject({ kind: "hard_bounce", email: "a@x.co" });
    expect(p.parse(ev({ event: "failed", severity: "temporary", recipient: "a@x.co" }))[0]!.kind).toBe("soft_bounce");
    expect(p.parse(ev({ event: "complained", recipient: "a@x.co" }))[0]!.kind).toBe("complaint");
    expect(p.parse(ev({ event: "delivered", recipient: "a@x.co" }))).toEqual([]);
  });

  test("generic format", () => {
    const p = new GenericParser();
    expect(
      p.parse({ events: [{ type: "bounce", email: "A@b.co", reason: "dsn 5.1.1" }, { type: "weird", email: "x@y.co" }, { nope: 1 }] }),
    ).toEqual([{ kind: "hard_bounce", email: "a@b.co", reason: "dsn 5.1.1", messageId: undefined }]);
  });

  test("SNS subscription confirmation only follows genuine AWS hosts (SSRF guard)", () => {
    const sub = (url: string) => ({ Type: "SubscriptionConfirmation", SubscribeURL: url });
    expect(snsSubscribeUrl(sub("https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&Token=x"))).toContain("amazonaws.com");
    expect(snsSubscribeUrl(sub("https://sns.us-east-1.amazonaws.com.evil.io/x"))).toBeNull();
    expect(snsSubscribeUrl(sub("http://sns.us-east-1.amazonaws.com/x"))).toBeNull();
    expect(snsSubscribeUrl(sub("http://169.254.169.254/latest/meta-data"))).toBeNull();
    expect(snsSubscribeUrl({ Type: "Notification" })).toBeNull();
  });
});

describe("FeedbackService", () => {
  const mk = () => {
    const calls: string[] = [];
    const store: FeedbackStore = {
      suppress: async (_u, email, reason) => void calls.push(`suppress:${email}:${reason.slice(0, 12)}`),
      applyToEmail: async (_u, _s, e) => {
        calls.push(`apply:${e.kind}`);
        return true;
      },
    };
    return { calls, service: new FeedbackService(store, silent) };
  };

  test("hard bounces and complaints suppress; soft bounces are only counted", async () => {
    const { calls, service } = mk();
    const r = await service.handle(new ObjectId(), new ObjectId(), {
      events: [
        { type: "bounce", email: "hard@x.co", reason: "550 unknown user" },
        { type: "soft_bounce", email: "soft@x.co" },
        { type: "complaint", email: "spam@x.co" },
      ],
    });
    expect(r).toMatchObject({ parser: "generic", events: 3, suppressed: 2, ignored: 1 });
    expect(calls.filter((c) => c.startsWith("suppress")).map((c) => c.split(":")[1])).toEqual(["hard@x.co", "spam@x.co"]);
  });

  test("an unrecognized payload is rejected", async () => {
    await expect(mk().service.handle(new ObjectId(), new ObjectId(), { hello: "world" })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("unsubscribe + webhook capabilities", () => {
  const tokens = new HmacCapabilityTokens();
  const added: Array<[string, string]> = [];
  const repo = {
    add: async (_u: ObjectId, e: string, r: string) => void added.push([e, r]),
    list: async () => [],
    remove: async () => true,
  };
  const svc = new UnsubscribeService(tokens, repo as any, "https://mail.example.com/");
  const userId = new ObjectId();

  test("bulk mail gets one-click headers; transactional mail does not", () => {
    const bulk = svc.forEmail({ userId, to: "Bob@Example.com", priority: "bulk" } as any);
    expect(bulk["List-Unsubscribe"]).toMatch(/^<https:\/\/mail\.example\.com\/u\/[\w.-]+>$/);
    expect(bulk["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(svc.forEmail({ userId, to: "bob@example.com", priority: "transactional" } as any)).toEqual({});
  });

  test("no public base URL -> no header (never emit a broken link)", () => {
    const off = new UnsubscribeService(tokens, repo as any, undefined);
    expect(off.forEmail({ userId, to: "a@b.co", priority: "bulk" } as any)).toEqual({});
  });

  test("the link unsubscribes exactly that recipient, lower-cased", async () => {
    const link = svc.linkFor(userId, "Bob@Example.com")!;
    const token = link.split("/u/")[1]!;
    expect(svc.inspect(token)).toEqual({ userId, email: "bob@example.com" });
    expect(added).toEqual([]); // inspecting has no side effects
    await svc.unsubscribe(token);
    expect(added).toEqual([["bob@example.com", "unsubscribed"]]);
  });

  test("forged or tampered tokens are rejected", () => {
    expect(() => svc.inspect("garbage")).toThrow(NotFoundError);
    const other = tokens.sign(`u|${userId}|victim@x.co`);
    expect(() => svc.inspect(other.slice(0, -2) + "xx")).toThrow(NotFoundError);
    expect(() => svc.inspect(tokens.sign("wh|" + userId))).toThrow(NotFoundError); // a webhook token is not an unsubscribe token
  });

  test("webhook URLs are bound to the SMTP account id", () => {
    const access = new WebhookAccess(tokens, "https://mail.example.com");
    const a = new ObjectId();
    const b = new ObjectId();
    const url = access.urlFor(a)!;
    const token = url.split("/").pop()!;
    expect(access.verify(a, token)).toBe(true);
    expect(access.verify(b, token)).toBe(false);
    expect(access.verify(a, "nope")).toBe(false);
  });
});
