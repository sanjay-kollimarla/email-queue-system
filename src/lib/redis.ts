import IORedis, { type RedisOptions } from "ioredis";
import { config } from "../config.ts";

/** Single Redis (REDIS_URL) or a Sentinel-managed master (REDIS_SENTINELS): the client follows failovers on its own. */
export function redisOptions(env: Pick<typeof config, "REDIS_SENTINELS" | "REDIS_MASTER_NAME" | "REDIS_PASSWORD">): RedisOptions {
  const base: RedisOptions = {
    maxRetriesPerRequest: null, // BullMQ requires it: commands wait out a failover instead of failing
    enableReadyCheck: true,
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
  };
  if (!env.REDIS_SENTINELS) return base;
  const sentinels = env.REDIS_SENTINELS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((hostPort) => {
      const [host, port] = hostPort.split(":");
      return { host: host!, port: Number(port ?? 26379) };
    });
  return { ...base, sentinels, name: env.REDIS_MASTER_NAME };
}

export function createRedis(name = "emailq") {
  const opts = { ...redisOptions(config), connectionName: name };
  const client = config.REDIS_SENTINELS ? new IORedis(opts) : new IORedis(config.REDIS_URL, opts);
  client.on("error", (err) => console.error(JSON.stringify({ level: "error", service: `redis:${name}`, msg: err.message })));
  return client;
}

/** Shared connection for general commands (rate limiter, throttles, metrics). */
export const redis = createRedis("emailq-main");
