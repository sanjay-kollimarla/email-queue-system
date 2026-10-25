import { afterAll, describe, expect, test } from "bun:test";
import IORedis from "ioredis";
import { ObjectId } from "mongodb";
import { SmtpLimiter, startRate } from "../src/ratelimit/limiter.ts";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
const r = new IORedis(url, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
r.on("error", () => {});
let up = false;
try {
  await r.connect();
  up = true;
} catch {
  console.warn("[limiter tests] Redis not reachable, skipping");
}

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

describe("startRate", () => {
  test("slow start at 2% of the ceiling (at least 1/s when allowed), or the learned limit", () => {
    expect(startRate({ ceilingPerSec: 5000 })).toBe(100);
    expect(startRate({ ceilingPerSec: 10 })).toBe(1);
    expect(startRate({ ceilingPerSec: 0.5 })).toBe(0.5);
    expect(startRate({ ceilingPerSec: 5000, learnedRate: 300 })).toBe(300);
    expect(startRate({ ceilingPerSec: 100, learnedRate: 300 })).toBe(100);
  });
});

describe.skipIf(!up)("SmtpLimiter (needs Redis)", () => {
  const limiter = new SmtpLimiter(r);
  const ids: string[] = [];
  const mk = (ceilingPerSec: number, extra: Record<string, unknown> = {}) => {
    const a = { _id: new ObjectId(), ceilingPerSec, ...extra } as any;
    ids.push(String(a._id));
    return a;
  };
  afterAll(async () => {
    for (const id of ids) {
      await limiter.reset(id);
      const days = await r.keys(`rl:{${id}}:hour:*`);
      if (days.length) await r.del(...days);
    }
    r.disconnect();
  });

  test("credit: 100ms burst, then refills at the account rate, capped at the burst", async () => {
    const a = mk(100, { learnedRate: 100 }); // 100/s -> capacity 10 tokens
    expect(await limiter.credit(a, 50, NOW)).toBe(10);
    expect(await limiter.credit(a, 50, NOW)).toBe(0);
    expect(await limiter.credit(a, 50, NOW + 50)).toBe(5); // 50ms * 100/s
    expect(await limiter.credit(a, 50, NOW + 10_000)).toBe(10); // idle time cannot bank more than the burst
  });

  test("credit never exceeds what was asked for", async () => {
    const a = mk(1000, { learnedRate: 1000 });
    expect(await limiter.credit(a, 3, NOW)).toBe(3);
  });

  test("credit is zero while the account is paused, and resumes after", async () => {
    const a = mk(100, { learnedRate: 100 });
    await limiter.credit(a, 1, NOW);
    await limiter.pause(String(a._id), NOW + 5000);
    expect(await limiter.credit(a, 10, NOW + 1000)).toBe(0);
    expect(await limiter.credit(a, 10, NOW + 5001)).toBeGreaterThan(0);
  });

  test("daily cap is a ROLLING 24h window, not a calendar day", async () => {
    const a = mk(1000, { learnedRate: 1000, dailyCap: 5 });
    const t0 = 20_000 * DAY + 23 * 3_600_000; // 23:00 UTC: a calendar-day reset one hour later must NOT free quota
    expect(await limiter.credit(a, 100, t0)).toBe(5);
    expect(await limiter.credit(a, 100, t0 + 1000)).toBe(0);
    expect(await limiter.credit(a, 100, t0 + 2 * 3_600_000)).toBe(0); // after UTC midnight, still inside 24h
    expect(await limiter.credit(a, 100, t0 + 22 * 3_600_000)).toBe(0);
    expect(await limiter.credit(a, 100, t0 + 24 * 3_600_000)).toBe(5); // the 5 sends have aged out
  });

  test("daily cap frees quota gradually as old sends age out", async () => {
    const a = mk(1000, { learnedRate: 1000, dailyCap: 10 });
    const t0 = 20_000 * DAY;
    expect(await limiter.credit(a, 4, t0)).toBe(4); // hour 0
    expect(await limiter.credit(a, 6, t0 + 3_600_000 * 5)).toBe(6); // hour 5 -> full
    expect(await limiter.credit(a, 10, t0 + 3_600_000 * 10)).toBe(0);
    expect(await limiter.credit(a, 10, t0 + 3_600_000 * 24)).toBe(4); // hour-0 bucket aged out
    expect(await limiter.credit(a, 10, t0 + 3_600_000 * 29)).toBe(6); // hour-5 bucket aged out
  });

  test("a lowered ceiling takes effect immediately", async () => {
    const a = mk(1000, { learnedRate: 1000 });
    await limiter.credit(a, 1, NOW);
    const lowered = { ...a, ceilingPerSec: 10 };
    expect(await limiter.credit(lowered, 1000, NOW + 10_000)).toBe(1); // capacity max(1, 10*0.1)
  });

  test("execution guard: waits grow once the burst exceeds the rate", async () => {
    const a = mk(10, { learnedRate: 10 }); // 100ms interval
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const g = await limiter.acquire(a, NOW);
      if (g.paused) throw new Error("unexpectedly paused");
      waits.push(g.waitMs);
    }
    expect(waits).toEqual([0, 100, 200, 300, 400, 500]);
  });

  test("execution guard reports a pause", async () => {
    const a = mk(10, { learnedRate: 10 });
    await limiter.pause(String(a._id), NOW + 60_000);
    expect(await limiter.acquire(a, NOW)).toEqual({ paused: true, until: NOW + 60_000 });
  });

  test("throttle: x0.7 once per incident (debounced), exponential pause, ssthresh recorded", async () => {
    const a = mk(100, { learnedRate: 100 });
    await limiter.credit(a, 1, NOW); // initialises state
    const t1 = await limiter.onThrottle(a, 0, NOW);
    expect(t1.rate).toBeCloseTo(70, 3);
    expect(t1.pauseUntil).toBe(NOW + 1000);
    const t2 = await limiter.onThrottle(a, 0, NOW + 100); // same incident: ignored
    expect(t2.rate).toBeCloseTo(70, 3);
    const t3 = await limiter.onThrottle(a, 0, NOW + 2000); // new incident
    expect(t3.rate).toBeCloseTo(49, 3);
    expect(t3.pauseUntil).toBe(NOW + 2000 + 2000);
    expect((await limiter.state(String(a._id))).ssthresh).toBeCloseTo(49, 3);
  });

  test("Retry-After from the provider extends the pause", async () => {
    const a = mk(100, { learnedRate: 100 });
    await limiter.credit(a, 1, NOW);
    const t = await limiter.onThrottle(a, 30_000, NOW);
    expect(t.pauseUntil).toBe(NOW + 30_000);
  });

  test("slow start doubles on success until the ceiling, which becomes the ssthresh", async () => {
    const a = mk(40); // starts at 2% -> max(0.8, min(1,40)) = 1/s
    await limiter.credit(a, 1, NOW);
    expect((await limiter.state(String(a._id))).rate).toBe(1);
    let s = await limiter.onSuccess(a, 1, NOW + 1);
    expect(s.rate).toBe(2);
    expect(s.ssthresh).toBe(0); // still slow start
    for (let i = 0; i < 10; i++) s = await limiter.onSuccess(a, 100, NOW + 1);
    expect(s.rate).toBe(40);
    expect(s.ssthresh).toBe(40);
  });

  test("after a throttle the rate probes gently (5% of ssthresh per second), never above the ceiling", async () => {
    const a = mk(1000, { learnedRate: 100 });
    await limiter.credit(a, 1, NOW);
    await limiter.onThrottle(a, 0, NOW); // rate = ssthresh = 70
    const s = await limiter.onSuccess(a, 70, NOW + 10_000); // ~1 second of traffic at 70/s
    expect(s.rate).toBeGreaterThan(70);
    expect(s.rate).toBeLessThan(75); // 70 + 3.5
    let last = s;
    for (let i = 0; i < 2000; i++) last = await limiter.onSuccess(a, 70, NOW + 10_000);
    expect(last.rate).toBeLessThanOrEqual(1000);
  });

  test("converges near a hidden provider limit starting from a slow start", async () => {
    // Simulated provider: allows 20 msg/s, answers 451 above that. Ceiling 200, so it must be discovered.
    const a = mk(200);
    const HIDDEN = 20;
    let t = NOW;
    await limiter.credit(a, 1, t);
    const seen: number[] = [];
    for (let sec = 0; sec < 200; sec++) {
      const st = await limiter.state(String(a._id));
      if (st.pauseUntil > t) {
        t += 1000;
        continue;
      }
      if (st.rate! > HIDDEN) await limiter.onThrottle(a, 0, t);
      else await limiter.onSuccess(a, Math.max(1, Math.round(st.rate!)), t);
      seen.push((await limiter.state(String(a._id))).rate!);
      t += 1000;
    }
    const tail = seen.slice(-40);
    expect(Math.max(...tail)).toBeLessThan(HIDDEN * 1.5);
    expect(Math.min(...tail)).toBeGreaterThan(HIDDEN * 0.4);
  });
});
