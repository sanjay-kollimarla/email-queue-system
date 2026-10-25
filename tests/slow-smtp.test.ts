import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import { Gate } from "../src/core/send/gate.ts";
import type { SendJob } from "../src/core/ports.ts";
import {
  AuthFailureHandler,
  PermanentFailureHandler,
  QuotaHandler,
  ThrottleHandler,
  TransientFailureHandler,
} from "../src/core/send/failure-handlers.ts";
import { SendEmailService } from "../src/core/send/send-email-service.ts";
import { classifySmtpError } from "../src/smtp/classify.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Gate (bulkhead)", () => {
  test("runs up to the active limit, parks the next ones, and hands slots over in order", async () => {
    const gate = new Gate();
    expect(await gate.acquire(2, 5, 1000)).toBe(true);
    expect(await gate.acquire(2, 5, 1000)).toBe(true);
    expect(gate.inUse).toBe(2);

    let third = false;
    const parked = gate.acquire(2, 5, 1000).then((ok) => {
      third = ok;
    });
    await sleep(5);
    expect(third).toBe(false); // parked, not running
    expect(gate.parked).toBe(1);

    gate.release(); // one send finished: the parked job takes over the slot directly
    await parked;
    expect(third).toBe(true);
    expect(gate.inUse).toBe(2);
    expect(gate.parked).toBe(0);
  });

  test("beyond the waiter cap it refuses immediately (the caller defers)", async () => {
    const gate = new Gate();
    await gate.acquire(1, 1, 1000);
    const parked = gate.acquire(1, 1, 1000); // fills the single waiting place
    expect(await gate.acquire(1, 1, 1000)).toBe(false);
    gate.release();
    expect(await parked).toBe(true);
  });

  test("a parked job gives up after its timeout without consuming a slot", async () => {
    const gate = new Gate();
    await gate.acquire(1, 5, 1000);
    expect(await gate.acquire(1, 5, 20)).toBe(false);
    expect(gate.parked).toBe(0);
    expect(gate.inUse).toBe(1);
  });

  test("release never drives the counter negative", () => {
    const gate = new Gate();
    gate.release();
    gate.release();
    expect(gate.inUse).toBe(0);
  });
});

/**
 * The scenario that motivated the two-tier gate: an SMTP server that takes a long time per message. Emails must only be
 * CLAIMED (status "sending") when a connection is about to be free; otherwise hundreds sit "sending" while queued inside
 * the SMTP library, which misreports them and, past the reaper's lease, gets live mail re-queued as duplicates.
 */
describe("slow SMTP server", () => {
  class Deferred extends Error {}
  const SMTP_ID = String(new ObjectId()); // every job targets the same account, so they share one gate

  function harness(opts: { maxConnections: number; latencyMs: number; maxGateWaiters: number; gateWaitMs: number }) {
    const state = { claimedNow: 0, peakClaimed: 0, sent: 0, claims: 0 };
    const smtp = {
      _id: new ObjectId(),
      userId: new ObjectId(),
      maxConnections: opts.maxConnections,
      health: "ok",
      ceilingPerSec: 1000,
    } as never;
    const email = (id: ObjectId) =>
      ({ _id: id, userId: new ObjectId(), templateId: new ObjectId(), to: "a@b.co", messageId: "<m@x>", priority: "bulk" }) as never;

    const emails = {
      claimForSending: async (id: ObjectId) => {
        state.claims++;
        state.claimedNow++;
        state.peakClaimed = Math.max(state.peakClaimed, state.claimedNow);
        return email(id);
      },
      recordSent: () => {
        state.sent++;
        state.claimedNow--;
      },
      revertToQueued: async () => {
        state.claimedNow--;
      },
      markFailed: async () => {},
      suppressRecipient: async () => {},
    };
    const smtps = { find: async () => smtp, flagAuthFailed: async () => {}, saveLearnedRate: () => {} };
    const guard = {
      acquire: async () => ({ paused: false as const, waitMs: 0, intervalMs: 1 }),
      pausedUntil: async () => 0,
      pause: async () => {},
    };
    const metrics = { inc() {} };
    const feedback = { onSuccess: async () => ({ rate: 1, ssthresh: 0 }), onThrottle: async () => ({ rate: 1, pauseUntil: 0 }) };
    const failurePolicy = { authPauseMs: 1, defaultQuotaPauseMs: 1 };

    const service = new SendEmailService({
      emails,
      smtps,
      templates: { find: async () => ({ subject: "s", text: "t" }) as never },
      attachments: { put: async () => ({}) as never, load: async () => [], purgeUnusedSince: async () => 0 },
      listHeaders: { forEmail: () => ({}) },
      guard,
      mailer: {
        send: async () => {
          await sleep(opts.latencyMs); // the slow SMTP server
          return { response: "250 ok", rejected: [] };
        },
      },
      reporter: { note() {} } as never,
      failures: {
        permanent: new PermanentFailureHandler(emails, metrics),
        throttle: new ThrottleHandler(emails, feedback, smtps, metrics),
        quota: new QuotaHandler(emails, guard, failurePolicy),
        auth: new AuthFailureHandler(emails, smtps, guard, failurePolicy),
        transient: new TransientFailureHandler(emails, metrics),
      },
      classify: classifySmtpError,
      metrics,
      policy: { maxDeferrals: 10, authPauseMs: 1, gateWaitMs: opts.gateWaitMs, maxGateWaiters: opts.maxGateWaiters, execToleranceMs: 250 },
    });

    const job = (): SendJob & { deferred: boolean } => {
      const j = {
        data: { emailId: String(new ObjectId()), smtpId: SMTP_ID },
        deferred: false,
        patch: async () => {},
        defer: async () => {
          j.deferred = true;
          throw new Deferred("deferred");
        },
      };
      return j;
    };
    const run = (j: SendJob) => service.handle(j).catch((e) => (e instanceof Deferred ? undefined : Promise.reject(e)));
    return { state, job, run };
  }

  test("with a 3-second-style slow server, claims never exceed 2 x the connection pool, and everything is delivered", async () => {
    const h = harness({ maxConnections: 3, latencyMs: 25, maxGateWaiters: 100, gateWaitMs: 5000 });
    const jobs = Array.from({ length: 60 }, () => h.job());
    await Promise.all(jobs.map((j) => h.run(j)));
    expect(h.state.sent).toBe(60);
    expect(h.state.peakClaimed).toBeLessThanOrEqual(6); // 2 x 3 connections, NOT 60
    expect(jobs.some((j) => j.deferred)).toBe(false); // parking absorbed the burst: no Redis churn
  });

  test("a full waiting area defers the overflow instead of claiming it", async () => {
    const h = harness({ maxConnections: 1, latencyMs: 40, maxGateWaiters: 2, gateWaitMs: 5000 });
    const jobs = Array.from({ length: 10 }, () => h.job());
    await Promise.all(jobs.map((j) => h.run(j)));
    const deferred = jobs.filter((j) => j.deferred).length;
    expect(deferred).toBe(10 - (2 + 2)); // 2 active (2 x 1 connection) + 2 parked ran; the other 6 were deferred untouched
    expect(h.state.sent).toBe(4);
    expect(h.state.claims).toBe(4); // deferred jobs were never claimed, so they were never marked "sending"
    expect(h.state.peakClaimed).toBeLessThanOrEqual(2);
  });

  test("a job that parks too long is deferred without ever being claimed", async () => {
    const h = harness({ maxConnections: 1, latencyMs: 200, maxGateWaiters: 5, gateWaitMs: 30 });
    const jobs = Array.from({ length: 4 }, () => h.job());
    await Promise.all(jobs.map((j) => h.run(j)));
    expect(jobs.filter((j) => j.deferred).length).toBe(2); // 2 active ran; 2 timed out while parked
    expect(h.state.claims).toBe(2);
  });
});
