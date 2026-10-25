/**
 * Lua scripts (executed atomically inside Redis). All times are epoch milliseconds, passed in by
 * the caller so scripts stay deterministic and testable.
 *
 * Numbers are returned as strings: Redis truncates Lua floats to integers on the wire.
 *
 * Per-account state lives in one hash, `rl:{smtpId}:aimd`:
 *   rate        current allowed sends/second (what the adaptive controller has learned so far)
 *   ssthresh    estimate of the provider's limit (set by the first throttle); absent = still in slow start
 *   pauseUntil  epoch ms; nothing may be released or sent before this
 *   lastDec / consec   throttle bookkeeping (debounce, exponential pause)
 */

/**
 * Token bucket: how many emails may be RELEASED to the send queue right now?
 *
 * KEYS[1] bucket hash {tokens, ts}   KEYS[2] aimd hash
 * ARGV[1] now  [2] want  [3] defaultRate (msgs/s)  [4] ceiling (msgs/s)  [5] dailyCap (0 = none)
 * ARGV[6] hourKeyPrefix  [7] defaultIsLearned (1 = start in congestion avoidance, 0 = slow start)
 *
 * Bucket capacity is 100ms worth of tokens: a provider that counts "per second" never sees more than
 * ~1.1x the rate in any one-second window, which a bigger burst allowance would violate.
 * Returns the granted count (0 while paused / budget exhausted / daily cap reached).
 */
export const CREDIT_LUA = `
local HOUR = 3600000
local now = tonumber(ARGV[1])
local want = tonumber(ARGV[2])
local ceiling = tonumber(ARGV[4])
local dailyCap = tonumber(ARGV[5])

local rate = tonumber(redis.call('HGET', KEYS[2], 'rate'))
if not rate then
  rate = tonumber(ARGV[3])
  redis.call('HSET', KEYS[2], 'rate', string.format('%.4f', rate))
  if ARGV[7] == '1' then redis.call('HSET', KEYS[2], 'ssthresh', string.format('%.4f', rate)) end
end
if rate > ceiling then rate = ceiling end
if rate < 0.01 then rate = 0.01 end

local pauseUntil = tonumber(redis.call('HGET', KEYS[2], 'pauseUntil')) or 0
if pauseUntil > now then return '0' end

local capacity = math.max(1, rate * 0.1)
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if not tokens then
  tokens = capacity
else
  tokens = math.min(capacity, tokens + math.max(0, now - ts) / 1000 * rate)
end

local granted = math.min(want, math.floor(tokens))
local hourKey = ''
if dailyCap > 0 and granted > 0 then
  -- rolling 24h window approximated with hourly buckets: the current hour plus the previous 23.
  -- Providers (Gmail, Microsoft 365, SES) all use a ROLLING 24h window, not a calendar day; counting the
  -- oldest bucket in full makes this slightly conservative, never optimistic.
  local hour = math.floor(now / HOUR)
  local used = 0
  for h = hour - 23, hour do
    used = used + (tonumber(redis.call('GET', ARGV[6] .. h)) or 0)
  end
  granted = math.min(granted, math.max(0, dailyCap - used))
  hourKey = ARGV[6] .. hour
end
if granted > 0 then
  tokens = tokens - granted
  if hourKey ~= '' then
    redis.call('INCRBY', hourKey, granted)
    redis.call('PEXPIRE', hourKey, 25 * HOUR)
  end
end
redis.call('HSET', KEYS[1], 'tokens', string.format('%.4f', tokens), 'ts', string.format('%.0f', now))
redis.call('PEXPIRE', KEYS[1], 3600000)
return tostring(granted)
`;

/**
 * Execution guard (GCRA / "virtual scheduling"): a safety net in the worker that enforces the
 * CURRENT rate even if more jobs were released than a freshly lowered rate allows.
 *
 * KEYS[1] tat key   KEYS[2] aimd hash
 * ARGV[1] now  [2] defaultRate  [3] ceiling
 * returns ["P", pauseUntil]            account paused
 *         ["0", waitMs, intervalMs]    slot reserved; wait that long (the caller tolerates a small burst)
 */
export const EXEC_LUA = `
local now = tonumber(ARGV[1])
local ceiling = tonumber(ARGV[3])
local rate = tonumber(redis.call('HGET', KEYS[2], 'rate')) or tonumber(ARGV[2])
if rate > ceiling then rate = ceiling end
if rate < 0.01 then rate = 0.01 end
local interval = 1000 / rate
local pauseUntil = tonumber(redis.call('HGET', KEYS[2], 'pauseUntil')) or 0
if pauseUntil > now then return {'P', string.format('%.0f', pauseUntil)} end
local tat = tonumber(redis.call('GET', KEYS[1])) or 0
local start = math.max(tat, now)
redis.call('SET', KEYS[1], string.format('%.3f', start + interval), 'PX', 600000)
return {'0', string.format('%.0f', start - now), string.format('%.3f', interval)}
`;

/**
 * Adaptive rate control, TCP-style:
 *   slow start         (no ssthresh yet)  rate += 1 per success      -> doubles every second
 *   congestion avoid.  (after a throttle) rate += 5% of ssthresh / second, probing gently
 *   throttle           ssthresh = rate * 0.7, rate = ssthresh, exponential pause
 * so it finds the provider's real limit starting from a low guess, then hovers just under it.
 *
 * SUCCESS  KEYS[1] aimd hash   ARGV: [1] n successes  [2] ceiling  [3] now
 *          returns [rate, ssthresh | "0"]
 */
export const SUCCESS_LUA = `
local rate = tonumber(redis.call('HGET', KEYS[1], 'rate'))
if not rate then return {'0', '0'} end
local ss = tonumber(redis.call('HGET', KEYS[1], 'ssthresh'))
local pauseUntil = tonumber(redis.call('HGET', KEYS[1], 'pauseUntil')) or 0
if pauseUntil > tonumber(ARGV[3]) then return {string.format('%.4f', rate), string.format('%.4f', ss or 0)} end
local n = tonumber(ARGV[1])
local ceiling = tonumber(ARGV[2])
if not ss then
  rate = rate + n
else
  rate = rate + math.max(0.05, 0.05 * ss) * n / math.max(rate, 0.1)
end
if rate >= ceiling then
  rate = ceiling
  if not ss then ss = ceiling; redis.call('HSET', KEYS[1], 'ssthresh', string.format('%.4f', ss)) end
end
redis.call('HSET', KEYS[1], 'rate', string.format('%.4f', rate), 'consec', 0)
return {string.format('%.4f', rate), string.format('%.4f', ss or 0)}
`;

/**
 * THROTTLE: debounced (dozens of in-flight jobs fail from ONE incident; only the first counts).
 * KEYS[1] aimd hash  ARGV: [1] now [2] ceiling [3] minRate [4] retryAfterMs (0 = none)
 *                          [5] maxPauseMs [6] debounceMs
 * returns [rate, pauseUntil]
 */
export const THROTTLE_LUA = `
local now = tonumber(ARGV[1])
local ceiling = tonumber(ARGV[2])
local minRate = tonumber(ARGV[3])
local retryAfter = tonumber(ARGV[4])
local maxPause = tonumber(ARGV[5])
local debounce = tonumber(ARGV[6])

local rate = tonumber(redis.call('HGET', KEYS[1], 'rate')) or ceiling
local lastDec = tonumber(redis.call('HGET', KEYS[1], 'lastDec')) or 0
local consec = tonumber(redis.call('HGET', KEYS[1], 'consec')) or 0
local pauseUntil = tonumber(redis.call('HGET', KEYS[1], 'pauseUntil')) or 0

if now - lastDec >= debounce then
  rate = math.max(minRate, rate * 0.7)
  consec = consec + 1
  local pause = math.min(maxPause, 1000 * (2 ^ (consec - 1)))
  if retryAfter > pause then pause = math.min(retryAfter, maxPause) end
  pauseUntil = math.max(pauseUntil, now + pause)
  redis.call('HSET', KEYS[1], 'lastDec', string.format('%.0f', now), 'ssthresh', string.format('%.4f', rate))
end
redis.call('HSET', KEYS[1], 'rate', string.format('%.4f', rate), 'consec', consec,
           'pauseUntil', string.format('%.0f', pauseUntil))
return { string.format('%.4f', rate), string.format('%.0f', pauseUntil) }
`;

/** Pause an account until a timestamp (quota / auth failures). KEYS[1] aimd hash, ARGV[1] untilMs */
export const PAUSE_LUA = `
local cur = tonumber(redis.call('HGET', KEYS[1], 'pauseUntil')) or 0
local untilMs = tonumber(ARGV[1])
if untilMs > cur then redis.call('HSET', KEYS[1], 'pauseUntil', string.format('%.0f', untilMs)) end
return 1
`;
