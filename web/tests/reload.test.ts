import { describe, expect, test } from "bun:test";
import { isChunkLoadError, reloadOnceForNewVersion } from "../src/shared/lib/reload";

const memoryStorage = () => {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
};

describe("stale tab recovery after a deploy", () => {
  test("recognises the browsers' wording for a failed lazy chunk", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: http://x/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(new Error("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new Error("Loading chunk 12 failed"))).toBe(true);
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError("error loading dynamically imported module")).toBe(true);
  });

  test("reloads once, then refuses to loop inside the 30 second window", () => {
    let reloads = 0;
    let t = 1_000_000;
    const deps = { now: () => t, storage: memoryStorage(), reload: () => void reloads++ };
    expect(reloadOnceForNewVersion(deps)).toBe(true);
    expect(reloads).toBe(1);
    t += 5_000;
    expect(reloadOnceForNewVersion(deps)).toBe(false); // would be a reload loop: the user sees a message instead
    expect(reloads).toBe(1);
    t += 40_000;
    expect(reloadOnceForNewVersion(deps)).toBe(true); // a later, separate deploy can recover again
    expect(reloads).toBe(2);
  });

  test("can reload into the page the user was heading for", () => {
    const targets: Array<string | undefined> = [];
    const deps = { now: () => 5_000_000, storage: memoryStorage(), reload: (url?: string) => void targets.push(url) };
    reloadOnceForNewVersion(deps, "/emails?status=failed");
    expect(targets).toEqual(["/emails?status=failed"]);
  });

  test("blocked storage never causes a reload loop", () => {
    let reloads = 0;
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(reloadOnceForNewVersion({ now: () => 1, storage: throwing, reload: () => void reloads++ })).toBe(false);
    expect(reloads).toBe(0);
  });
});
