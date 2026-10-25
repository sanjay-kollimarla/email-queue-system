/**
 * Template method for every long-running process (API excluded: it owns an HTTP server).
 * A service only describes how to start and how to drain; signal handling, ordered shutdown and exit
 * codes live here once instead of being copy-pasted into each entrypoint.
 */
export interface Service {
  readonly name: string;
  start(): Promise<void>;
  /** Stop accepting work, let in-flight work finish, release resources. */
  stop(): Promise<void>;
}

export async function runService(service: Service): Promise<void> {
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", service: service.name, msg: `${signal}: draining` }));
    const force = setTimeout(() => process.exit(1), 30_000); // never hang a deploy forever
    try {
      await service.stop();
      clearTimeout(force);
      process.exit(0);
    } catch (e) {
      console.error(`[${service.name}] shutdown failed`, e);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await service.start();
  } catch (e) {
    console.error(`[${service.name}] failed to start`, e);
    process.exit(1);
  }
}
