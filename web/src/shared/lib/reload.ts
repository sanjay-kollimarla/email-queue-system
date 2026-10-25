/**
 * After a deploy, a tab that was already open still references the OLD build's hashed chunk files, which no longer
 * exist. The standard remedy is to reload once to pick up the new index.html. A sessionStorage flag stops this from
 * looping if the server is genuinely broken: the second failure shows a message instead.
 */
const FLAG = "courier.reloaded-for-new-version";
const WINDOW_MS = 30_000;

export const isChunkLoadError = (e: unknown): boolean =>
  /dynamically imported module|importing a module script failed|loading chunk|error loading dynamically/i.test(
    e instanceof Error ? e.message : String(e),
  );

export interface ReloadDeps {
  now: () => number;
  storage: Pick<Storage, "getItem" | "setItem">;
  /** reload the page; with a url, load that url instead (so the user lands where they were heading) */
  reload: (url?: string) => void;
}

const browserDeps = (): ReloadDeps => ({
  now: Date.now,
  storage: sessionStorage,
  reload: (url) => (url ? window.location.assign(url) : window.location.reload()),
});

/** Reloads the page unless we already did so in the last 30 seconds. Returns whether a reload was triggered. */
export function reloadOnceForNewVersion(deps: ReloadDeps = browserDeps(), target?: string): boolean {
  try {
    const last = Number(deps.storage.getItem(FLAG) ?? 0);
    if (deps.now() - last < WINDOW_MS) return false;
    deps.storage.setItem(FLAG, String(deps.now()));
  } catch {
    return false; // storage blocked: do not risk a reload loop
  }
  deps.reload(target);
  return true;
}
