import type { ComponentType } from "react";
import type { RouteObject } from "react-router";
import { isChunkLoadError, reloadOnceForNewVersion } from "../shared/lib/reload";

/**
 * Lazy route with deploy-recovery. Each screen is its own chunk; if a tab opened before a deploy asks for a chunk that
 * no longer exists, we reload straight to the page the user was opening (one time only). A second failure within
 * 30 seconds is rethrown so the route's error screen can tell the user, instead of looping.
 */
export function lazyPage<K extends string>(
  path: string,
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
): NonNullable<RouteObject["lazy"]> {
  return async () => {
    try {
      return { Component: (await load())[name] };
    } catch (error) {
      if (isChunkLoadError(error) && reloadOnceForNewVersion(undefined, path)) {
        return new Promise<never>(() => {}); // never settles: the browser is already navigating away
      }
      throw error;
    }
  };
}
