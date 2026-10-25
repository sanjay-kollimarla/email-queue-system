import type { Redis } from "ioredis";
import type { RateStateReader } from "../core/api/ports.ts";
import type { ReleaseBudget, SendRateFeedback, SendRateGuard } from "../core/ports.ts";
import type { SmtpAccountDoc } from "../db/mongo.ts";
import { CREDIT_LUA, EXEC_LUA, PAUSE_LUA, SUCCESS_LUA, THROTTLE_LUA } from "./scripts.ts";

/** Burst the execution guard tolerates before deferring a job (release is bursty by design: 100ms of tokens). */
export const EXEC_TOLERANCE_MS = 250;
const MAX_PAUSE_MS = 5 * 60_000;
const DEBOUNCE_MS = 1000;

type Cmds = Redis & {
  rlCredit(bucket: string, aimd: string, ...args: (string | number)[]): Promise<string>;
  rlExec(tat: string, aimd: string, ...args: (string | number)[]): Promise<string[]>;
  rlSuccess(aimd: string, ...args: (string | number)[]): Promise<string[]>;
  rlThrottle(aimd: string, ...args: (string | number)[]): Promise<string[]>;
  rlPause(aimd: string, ...args: (string | number)[]): Promise<number>;
};

/** Keys share the {smtpId} hash tag so they land on one shard in Redis Cluster. */
const k = (id: string) => ({
  bucket: `rl:{${id}}:bucket`,
  exe: `rl:{${id}}:exe`,
  aimd: `rl:{${id}}:aimd`,
  day: `rl:{${id}}:hour:`,
});

type RateInfo = Pick<SmtpAccountDoc, "_id" | "ceilingPerSec" | "learnedRate">;

/**
 * Where the adaptive controller starts:
 *  - a previously learned limit (congestion avoidance, gentle probing), or
 *  - 2% of the ceiling (slow start: doubles every second until the provider pushes back).
 */
export const startRate = (a: Pick<SmtpAccountDoc, "ceilingPerSec" | "learnedRate">) =>
  Math.min(a.ceilingPerSec, a.learnedRate ?? Math.max(a.ceilingPerSec * 0.02, Math.min(1, a.ceilingPerSec)));

const minRate = (ceiling: number) => Math.min(ceiling, Math.max(0.05, ceiling / 100));

export class SmtpLimiter implements SendRateGuard, SendRateFeedback, ReleaseBudget, RateStateReader {
  private r: Cmds;
  constructor(redis: Redis) {
    redis.defineCommand("rlCredit", { numberOfKeys: 2, lua: CREDIT_LUA });
    redis.defineCommand("rlExec", { numberOfKeys: 2, lua: EXEC_LUA });
    redis.defineCommand("rlSuccess", { numberOfKeys: 1, lua: SUCCESS_LUA });
    redis.defineCommand("rlThrottle", { numberOfKeys: 1, lua: THROTTLE_LUA });
    redis.defineCommand("rlPause", { numberOfKeys: 1, lua: PAUSE_LUA });
    this.r = redis as Cmds;
  }

  /**
   * Release pacing: how many of `want` emails may enter the send queue right now? Honours the account's
   * CURRENT adaptive rate, any pause and the daily cap, so a rate change takes effect within one tick
   * (nothing is scheduled far into the future at a stale rate).
   */
  async credit(a: RateInfo & Pick<SmtpAccountDoc, "dailyCap">, want: number, now = Date.now()): Promise<number> {
    const keys = k(String(a._id));
    return Number(
      await this.r.rlCredit(
        keys.bucket,
        keys.aimd,
        now,
        want,
        startRate(a),
        a.ceilingPerSec,
        a.dailyCap ?? 0,
        keys.day,
        a.learnedRate !== undefined ? 1 : 0,
      ),
    );
  }

  /**
   * Execution guard in the worker (safety net; normally a no-op because release is already paced).
   *  { paused: true, until }          -> defer the job until `until`
   *  { paused: false, waitMs, ... }   -> if waitMs exceeds the tolerance the slot is already reserved:
   *                                      defer by waitMs and mark the job pre-granted
   */
  async acquire(a: RateInfo, now = Date.now()) {
    const keys = k(String(a._id));
    const res = await this.r.rlExec(keys.exe, keys.aimd, now, startRate(a), a.ceilingPerSec);
    return res[0] === "P"
      ? { paused: true as const, until: Number(res[1]) }
      : { paused: false as const, waitMs: Number(res[1]), intervalMs: Number(res[2]) };
  }

  /** Pause check for pre-granted jobs, which skip the slot reservation. */
  async pausedUntil(smtpId: string): Promise<number> {
    return Number((await this.r.hget(k(smtpId).aimd, "pauseUntil")) ?? 0);
  }

  /** Report `n` successful sends. Returns the new rate and the learned limit estimate (0 until a throttle happened). */
  async onSuccess(
    a: Pick<SmtpAccountDoc, "_id" | "ceilingPerSec">,
    n: number,
    now = Date.now(),
  ): Promise<{ rate: number; ssthresh: number }> {
    const [rate, ss] = await this.r.rlSuccess(k(String(a._id)).aimd, n, a.ceilingPerSec, now);
    return { rate: Number(rate), ssthresh: Number(ss) };
  }

  async onThrottle(
    a: Pick<SmtpAccountDoc, "_id" | "ceilingPerSec">,
    retryAfterMs = 0,
    now = Date.now(),
  ): Promise<{ rate: number; pauseUntil: number }> {
    const [rate, pauseUntil] = await this.r.rlThrottle(
      k(String(a._id)).aimd,
      now,
      a.ceilingPerSec,
      minRate(a.ceilingPerSec),
      retryAfterMs,
      MAX_PAUSE_MS,
      DEBOUNCE_MS,
    );
    return { rate: Number(rate), pauseUntil: Number(pauseUntil) };
  }

  /** Pause the whole account (daily quota, bad credentials). */
  async pause(smtpId: string, untilMs: number) {
    await this.r.rlPause(k(smtpId).aimd, untilMs);
  }

  async state(smtpId: string) {
    const h = await this.r.hgetall(k(smtpId).aimd);
    return {
      rate: h.rate !== undefined ? Number(h.rate) : undefined,
      ssthresh: h.ssthresh !== undefined ? Number(h.ssthresh) : undefined,
      pauseUntil: Number(h.pauseUntil ?? 0),
      consecutiveThrottles: Number(h.consec ?? 0),
    };
  }

  /** Remove all limiter state (account deleted / limits edited). */
  async reset(smtpId: string) {
    const keys = k(smtpId);
    await this.r.del(keys.bucket, keys.exe, keys.aimd);
  }
}
