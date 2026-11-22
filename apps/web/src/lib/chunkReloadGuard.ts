// Deploys and desktop server swaps can invalidate lazy chunks; one reload fetches the fresh index.
// Keyed by build and kept across boots: a chunk loaded after boot can fail on every visit.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded-build";
const STARTUP_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";

export function installChunkLoadRecovery(
  target: EventTarget = window,
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
) {
  let starting = true;
  let startupFailed = false;
  const onPreloadError = (event: Event) => {
    if (starting) startupFailed = true;
    const reloaded = starting
      ? reloadOnce(getStorage, reload, STARTUP_RELOAD_GUARD_KEY, "1")
      : reloadOnceForChunkLoadError(getStorage, reload);
    if (reloaded) event.preventDefault();
  };
  target.addEventListener("vite:preloadError", onPreloadError);
  return {
    completeStartup() {
      starting = false;
      // Router loading can resolve despite a failed route chunk; keep that failure streak bounded.
      if (startupFailed) return;
      try {
        getStorage().removeItem(STARTUP_RELOAD_GUARD_KEY);
      } catch {}
    },
    dispose() {
      target.removeEventListener("vite:preloadError", onPreloadError);
    },
  };
}

/**
 * Called from the `vite:preloadError` listener. Reloads at most once per
 * build and returns whether it did, so the caller knows whether to
 * swallow the event or let the error surface through the normal paths.
 */
export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  build = import.meta.env.APP_VERSION,
): boolean {
  return reloadOnce(getStorage, reload, CHUNK_RELOAD_GUARD_KEY, build);
}

function reloadOnce(
  getStorage: () => Storage,
  reload: () => void,
  key: string,
  value: string,
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    alreadyReloaded = storage.getItem(key) === value;
    if (!alreadyReloaded) storage.setItem(key, value);
  } catch {
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

// Browsers cache a failed dynamic import per document, so only a reload can retry it.
const CHUNK_LOAD_ERROR_PREFIXES = [
  "Failed to fetch dynamically imported module", // Chromium
  "error loading dynamically imported module", // Firefox
  "Importing a module script failed", // Safari
];

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : undefined;
  return (
    message !== undefined && CHUNK_LOAD_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}
