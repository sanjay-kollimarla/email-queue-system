import { describe, expect, test } from "bun:test";
import { ObjectId } from "mongodb";
import type { JobQueue, Logger, Metrics, OutboxStore, RecoveryStore, SendJob } from "../src/core/ports.ts";
import { RecoveryService } from "../src/core/recovery/recovery-service.ts";
import { ReleaseService } from "../src/core/release/release-service.ts";
import {
  AuthFailureHandler,
  PermanentFailureHandler,
  QuotaHandler,
  ThrottleHandler,
  TransientFailureHandler,
} from "../src/core/send/failure-handlers.ts";
import { SendEmailService } from "../src/core/send/send-email-service.ts";
import { classifySmtpError } from "../src/smtp/classify.ts";

// ---------- fakes ----------
const silent: Logger = { info() {}, warn() {}, error() {} };
const metrics = (): Metrics & { c: Record<string, number> } => {
  const c: Record<string, number> = {};
  return {
    c,
    inc: (k, n = 1) => {
      c[k] = (c[k] ?? 0) + n;
    },
  };
};

class DeferSignal extends Error {
  constructor(public until: number) {
    super("deferred");
  }
}
const fakeJob = (data: Record<string, unknown>): SendJob & { patched: unknown[]; deferredTo?: number } => {
  const job = {
    data: data as any,
    patched: [] as unknown[],
    deferredTo: undefined as number | undefined,
    async patch(p: unknown) {
      job.patched.push(p);
    },
    async defer(until: number) {
      job.deferredTo = until;
      throw new DeferSignal(until);
    },
  };
  return job;
};

const userId = new ObjectId();
const smtp = { _id: new ObjectId(), userId, maxConnections: 5, health: "ok", ceilingPerSec: 100 } as any;
const mkEmail = () =>
  ({
    _id: new ObjectId(),
    userId,
    smtpId: smtp._id,
    templateId: new ObjectId(),
    to: "Bob@Example.com",
    messageId: "<m@x>",
    priority: "bulk",
  }) as any;

function build(over: { send?: (mail?: any) => Promise<any>; email?: any | null; guard?: any; template?: any } = {}) {
  const email = over.email === undefined ? mkEmail() : over.email;
  const m = metrics();
  const calls: string[] = [];
  const emails = {
    claimForSending: async () => email,
    recordSent: () => void calls.push("sent"),
    revertToQueued: async () => void calls.push("revert"),
    markFailed: async (_: unknown, r: string) => void calls.push(`failed:${r.slice(0, 20)}`),
    suppressRecipient: async (_u: unknown, e: string) => void calls.push(`suppress:${e}`),
  };
  const smtps = {
    find: async () => smtp,
    flagAuthFailed: async () => void calls.push("flagAuth"),
    saveLearnedRate: () => void calls.push("saveRate"),
  };
  const guard = over.guard ?? {
    acquire: async () => ({ paused: false, waitMs: 0, intervalMs: 10 }),
    pausedUntil: async () => 0,
    pause: async () => void calls.push("pause"),
  };
  const feedback = {
    onSuccess: async () => ({ rate: 1, ssthresh: 0 }),
    onThrottle: async () => ({ rate: 7, pauseUntil: Date.now() + 5000 }),
  };
  const policy = { authPauseMs: 600_000, defaultQuotaPauseMs: 3_600_000 };
  const reporter = { note: () => void calls.push("note") } as any;
  const service = new SendEmailService({
    emails,
    smtps,
    templates: { find: async () => ({ subject: "Hi {{n}}", text: "x", ...(over.template ?? {}) }) as any },
    attachments: {
      put: async () => ({}) as any,
      load: async (refs) => refs.map(() => ({ filename: "a.pdf", contentType: "application/pdf", content: Buffer.from("x") })),
      purgeUnusedSince: async () => 0,
    },
    listHeaders: { forEmail: () => ({ "List-Unsubscribe": "<https://x/u/t>" }) },
    guard,
    mailer: { send: (_s, mail) => (over.send ?? (async () => ({ response: "250 ok", rejected: [] })))(mail) },
    reporter,
    failures: {
      permanent: new PermanentFailureHandler(emails, m),
      throttle: new ThrottleHandler(emails, feedback, smtps, m),
      quota: new QuotaHandler(emails, guard, policy),
      auth: new AuthFailureHandler(emails, smtps, guard, policy),
      transient: new TransientFailureHandler(emails, m),
    },
    classify: classifySmtpError,
    metrics: m,
    policy: { maxDeferrals: 5, authPauseMs: 600_000, gateWaitMs: 20, maxGateWaiters: 10, execToleranceMs: 250 },
  });
  return { service, calls, m };
}

const job = () => fakeJob({ emailId: String(new ObjectId()), smtpId: String(smtp._id) });
const smtpError = (code: number, text: string) => Object.assign(new Error(text), { responseCode: code, response: text });

describe("SendEmailService (no MongoDB / Redis / SMTP)", () => {
  test("success: records the send and feeds the rate controller", async () => {
    const { service, calls, m } = build();
    await service.handle(job());
    expect(calls).toEqual(["sent", "note"]);
    expect(m.c.sent).toBe(1);
  });

  test("attachments are loaded from the store and list headers are attached to the mail", async () => {
    let seen: any;
    const { service } = build({
      template: { attachments: [{ fileId: new ObjectId(), filename: "a.pdf" }] },
      send: async (mail) => {
        seen = mail;
        return { response: "250 ok", rejected: [] };
      },
    });
    await service.handle(job());
    expect(seen.attachments).toHaveLength(1);
    expect(seen.attachments[0].filename).toBe("a.pdf");
    expect(seen.headers["List-Unsubscribe"]).toBe("<https://x/u/t>");
  });

  test("an email already claimed elsewhere is a no-op", async () => {
    const { service, calls } = build({ email: null });
    await service.handle(job());
    expect(calls).toEqual([]);
  });

  test("throttle: reverts, reports to the controller, defers without failing", async () => {
    const { service, calls, m } = build({
      send: async () => {
        throw smtpError(451, "451 4.7.1 Rate limit exceeded");
      },
    });
    const j = job();
    await expect(service.handle(j)).rejects.toBeInstanceOf(DeferSignal);
    expect(calls).toEqual(["revert", "saveRate"]);
    expect(m.c.throttled).toBe(1);
    expect(j.deferredTo).toBeGreaterThan(Date.now());
  });

  test("permanent unknown mailbox: failed + recipient suppressed, no retry", async () => {
    const { service, calls } = build({
      send: async () => {
        throw smtpError(550, "550 5.1.1 user unknown");
      },
    });
    await service.handle(job()); // resolves: nothing to retry
    expect(calls[0]).toStartWith("failed:");
    expect(calls[1]).toBe("suppress:Bob@Example.com");
  });

  test("daily quota pauses the whole account then defers", async () => {
    const { service, calls } = build({
      send: async () => {
        throw smtpError(550, "550 5.4.5 Daily user sending quota exceeded");
      },
    });
    await expect(service.handle(job())).rejects.toBeInstanceOf(DeferSignal);
    expect(calls).toEqual(["revert", "pause"]);
  });

  test("bad credentials flag the account, pause it and defer", async () => {
    const { service, calls } = build({
      send: async () => {
        throw Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 });
      },
    });
    await expect(service.handle(job())).rejects.toBeInstanceOf(DeferSignal);
    expect(calls).toEqual(["revert", "flagAuth", "pause"]);
  });

  test("transient errors rethrow so the queue retries with backoff", async () => {
    const { service, calls, m } = build({
      send: async () => {
        throw Object.assign(new Error("boom"), { code: "ETIMEDOUT" });
      },
    });
    await expect(service.handle(job())).rejects.toThrow();
    expect(calls).toEqual(["revert"]);
    expect(m.c.transient).toBe(1);
  });

  test("a paused account defers the job before claiming anything", async () => {
    const until = Date.now() + 60_000;
    const { service, calls } = build({
      guard: { acquire: async () => ({ paused: true, until }), pausedUntil: async () => until, pause: async () => {} },
    });
    const j = job();
    await expect(service.handle(j)).rejects.toBeInstanceOf(DeferSignal);
    expect(j.deferredTo).toBeGreaterThanOrEqual(until);
    expect(calls).toEqual([]);
  });

  test("a job deferred too many times fails instead of looping forever", async () => {
    const { service, calls } = build();
    await service.handle(fakeJob({ emailId: String(new ObjectId()), smtpId: String(smtp._id), deferrals: 6 }));
    expect(calls[0]).toStartWith("failed:gave up");
  });

  test("a rate-guard wait beyond the burst tolerance defers as pre-granted", async () => {
    const { service } = build({
      guard: { acquire: async () => ({ paused: false, waitMs: 900, intervalMs: 10 }), pausedUntil: async () => 0, pause: async () => {} },
    });
    const j = job();
    await expect(service.handle(j)).rejects.toBeInstanceOf(DeferSignal);
  });
});

describe("ReleaseService", () => {
  const mkDoc = (n: number, cursor = 0) =>
    ({
      _id: new ObjectId(),
      smtpId: smtp._id,
      priority: "bulk",
      emailIds: Array.from({ length: n }, () => new ObjectId()),
      cursor,
      state: "releasing",
    }) as any;

  function setup(opts: { credit: number; depth?: number; docs: any[] }) {
    const queue: JobQueue & { out: Array<{ lane: string; n: number }> } = {
      out: [],
      enqueue: async (lane, jobs) => void queue.out.push({ lane, n: jobs.length }),
      readyDepth: async () => opts.depth ?? 0,
      isLive: async () => true,
    };
    const advanced: number[] = [];
    let released = 0;
    const docs = [...opts.docs];
    const outbox: OutboxStore = {
      smtpIdsWithBacklog: async () => (docs.length ? [smtp._id] : []),
      claim: async (_id, lane) => (lane === "bulk" ? (docs.shift() ?? null) : null),
      release: async () => void released++,
      advance: async (_d, c) => void advanced.push(c),
      failBacklog: async () => {},
      markEnqueued: async () => {},
    };
    const svc = new ReleaseService(
      outbox,
      { find: async () => smtp, flagAuthFailed: async () => {}, saveLearnedRate: () => {} },
      { credit: async (_a, want) => Math.min(want, opts.credit) },
      queue,
      { maxChunk: 1000, maxIterationsPerTick: 8, maxReady: 100 },
      silent,
    );
    return {
      svc,
      queue,
      advanced,
      get released() {
        return released;
      },
    };
  }

  test("releases exactly the credited number of emails and advances the cursor", async () => {
    const t = setup({ credit: 30, docs: [mkDoc(100)] });
    await t.svc.tick();
    expect(t.queue.out).toEqual([{ lane: "bulk", n: 30 }]);
    expect(t.advanced).toEqual([30]);
  });

  test("with no credit nothing is enqueued and the document is handed back", async () => {
    const t = setup({ credit: 0, docs: [mkDoc(10)] });
    await t.svc.tick();
    expect(t.queue.out).toEqual([]);
    expect(t.released).toBe(1);
  });

  test("backpressure: a full ready queue stops releasing", async () => {
    const t = setup({ credit: 1000, depth: 100, docs: [mkDoc(10)] });
    await t.svc.tick();
    expect(t.queue.out).toEqual([]);
  });

  test("resumes from the cursor after a crash", async () => {
    const t = setup({ credit: 1000, docs: [mkDoc(10, 6)] });
    await t.svc.tick();
    expect(t.queue.out).toEqual([{ lane: "bulk", n: 4 }]);
    expect(t.advanced).toEqual([10]);
  });
});

describe("RecoveryService", () => {
  test("re-creates jobs only for released emails whose job is gone", async () => {
    const alive = { _id: new ObjectId(), smtpId: smtp._id, priority: "bulk", lastEnqueuedAt: new Date(1) } as any;
    const lost = { _id: new ObjectId(), smtpId: smtp._id, priority: "bulk", lastEnqueuedAt: new Date(2) } as any;
    const enqueued: string[] = [];
    let touched = 0;
    const store: RecoveryStore = {
      findStuckSending: async () => [],
      requeueStuck: async () => {},
      findReleasedBefore: async () => [alive, lost],
      touchEnqueued: async (ids) => {
        touched = ids.length;
      },
    };
    const queue: JobQueue = {
      enqueue: async (_l, jobs) => void enqueued.push(...jobs.map((j) => j.jobId)),
      readyDepth: async () => 0,
      isLive: async (_l, id) => id === String(alive._id),
    };
    const r = await new RecoveryService(store, queue, { batch: 500, sendingLeaseMs: 1000, reconcileAfterMs: 1000 }).reconcileLostJobs();
    expect(r).toEqual({ checked: 2, recreated: 1 });
    expect(enqueued).toEqual([`${lost._id}-rc2`]);
    expect(touched).toBe(2);
  });

  test("stuck sends get a delayed deterministic job, then flip back to queued", async () => {
    const e = { _id: new ObjectId(), smtpId: smtp._id, priority: "transactional", sendingAt: new Date(5) } as any;
    const order: string[] = [];
    const store: RecoveryStore = {
      findStuckSending: async () => [e],
      requeueStuck: async () => void order.push("flip"),
      findReleasedBefore: async () => [],
      touchEnqueued: async () => {},
    };
    const queue: JobQueue = {
      enqueue: async (_l, jobs) => void order.push(`enqueue:${jobs[0]!.jobId}:${jobs[0]!.delayMs}`),
      readyDepth: async () => 0,
      isLive: async () => true,
    };
    await new RecoveryService(store, queue, { batch: 500, sendingLeaseMs: 1000, reconcileAfterMs: 1000 }).reapStuckSending();
    expect(order).toEqual([`enqueue:${e._id}-r5:5000`, "flip"]);
  });
});
