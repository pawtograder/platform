/**
 * Self-healing for stale client bundles (deploy skew).
 *
 * When a new build is deployed while a tab is still open, the page's webpack
 * runtime + chunk manifest are from the *old* build, but the server now serves
 * the *new* build's assets. Two failure modes follow, both triggered most often
 * by the App Router prefetching navbar links on window-focus:
 *
 *   1. A chunk file 404s  → `ChunkLoadError: Loading chunk N failed`.
 *      (Already filtered from Sentry in `instrumentation-client.ts`.)
 *
 *   2. A chunk file loads (HTTP 200) but the loaded webpack runtime's module
 *      table no longer has the factory for a module id the chunk asks for, so
 *      `__webpack_require__` does `__webpack_modules__[id].call(...)` on
 *      `undefined` →  `TypeError: Cannot read properties of undefined (reading 'call')`.
 *      This is the variant seen at `/course/:course_id/discussion/:root_id`
 *      when the staff nav prefetched the `manage/surveys` page chunk. It is a
 *      *plain TypeError*, not a ChunkLoadError, so nothing recognized it: it
 *      bubbled up as an unhandled promise rejection with no recovery.
 *
 * Both are unrecoverable in the current document — the only fix is to fetch the
 * new build. This module detects either shape and force-reloads exactly once
 * (guarded against reload loops), so a deploy mid-session self-heals instead of
 * leaving the user with a dead navigation and a noisy Sentry report.
 */

const RELOAD_GUARD_KEY = "pawtograder:stale-bundle-reloaded-at";
// Don't reload more than once per cooldown window — if a reload doesn't clear
// the error (e.g. the new bundle is genuinely broken, or it's a false match),
// we must not trap the user in an infinite reload loop.
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * True when `error` looks like a stale-bundle / chunk-load failure rather than a
 * genuine application bug. Conservative on purpose: the missing-module-factory
 * TypeError is only treated as stale-bundle when its stack points at the webpack
 * runtime / Next chunk files, so unrelated `reading 'call'` TypeErrors in app
 * code are left alone.
 */
export function isStaleBundleError(error: unknown): boolean {
  if (!error) return false;

  // Unwrap common wrappers (PromiseRejectionEvent.reason is already passed in by
  // the caller; here we only see Error-likes / strings).
  const name = (error as { name?: string })?.name ?? "";
  const message = typeof error === "string" ? error : ((error as { message?: string })?.message ?? "");
  const stack = (error as { stack?: string })?.stack ?? "";

  // Mode 1: the classic chunk 404.
  if (name === "ChunkLoadError") return true;
  if (/Loading chunk [^\s]+ failed/i.test(message)) return true;
  if (/Loading CSS chunk [^\s]+ failed/i.test(message)) return true;
  if (/ChunkLoadError/.test(message)) return true;

  // Mode 2: the missing-module-factory error from `__webpack_require__`.
  // Cover the cross-browser phrasings of "reading a property of undefined":
  //   Chrome:  Cannot read properties of undefined (reading 'call')
  //   Firefox: undefined is not an object (evaluating '... .call')   /  "x is undefined"
  //   Safari:  undefined is not an object
  const factoryMissing =
    /Cannot read propert(?:y|ies) of undefined \(reading '(?:call|default)'\)/.test(message) ||
    /undefined is not an object \(evaluating '[^']*\.call'\)/.test(message);

  if (factoryMissing) {
    // Only treat it as a stale bundle when the throw comes from the webpack
    // *runtime* itself (`webpack-<hash>.js` / `__webpack_require__` / the module
    // factory call). That's what distinguishes a missing module-table entry from
    // an ordinary `x.call(...)` bug in product code — the latter throws from an
    // app chunk with no webpack-runtime frame, so it must keep reporting. (Don't
    // match the generic `_next/static/chunks/` path: every app chunk lives there.)
    const looksLikeWebpackRuntime =
      /webpack[-.]/i.test(stack) || /__webpack_require__/.test(stack) || /options\.factory/.test(stack);
    if (looksLikeWebpackRuntime) return true;
  }

  return false;
}

function hasRecentlyReloaded(): boolean {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_GUARD_KEY);
    if (!raw) return false;
    const last = Number(raw);
    if (!Number.isFinite(last)) return false;
    return Date.now() - last < RELOAD_COOLDOWN_MS;
  } catch {
    // sessionStorage can throw (private mode / blocked storage). Fail safe by
    // assuming we have NOT reloaded, so a real deploy skew still self-heals; the
    // browser's own reload throttling backstops any loop.
    return false;
  }
}

function markReloaded(): void {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

// Reload from the server (not the bf-cache) so we pull the new manifest+chunks.
// `window.location.reload` is non-configurable in jsdom, so the reload action is
// injectable to keep `recoverFromStaleBundle` testable.
const defaultReload = () => window.location.reload();

/**
 * Recover from a detected stale-bundle error by force-reloading once. Returns
 * true if a reload was scheduled, false if suppressed by the loop guard.
 */
export function recoverFromStaleBundle(reload: () => void = defaultReload): boolean {
  if (typeof window === "undefined") return false;
  if (hasRecentlyReloaded()) return false;
  markReloaded();
  reload();
  return true;
}

/**
 * Install global listeners that detect stale-bundle errors (from prefetch or
 * navigation) and self-heal. Safe to call once at client startup; no-ops on the
 * server. Returns an uninstall function (used by tests).
 */
export function installStaleBundleRecovery(options: { reload?: () => void } = {}): () => void {
  if (typeof window === "undefined") return () => {};
  const reload = options.reload ?? defaultReload;

  const onRejection = (event: PromiseRejectionEvent) => {
    if (!isStaleBundleError(event.reason)) return;
    const didRecover = recoverFromStaleBundle(reload);
    if (didRecover) {
      // Mark handled so it doesn't surface as a fatal unhandled rejection / Sentry noise.
      event.preventDefault();
    }
  };

  const onError = (event: ErrorEvent) => {
    if (!isStaleBundleError(event.error ?? event.message)) return;
    const didRecover = recoverFromStaleBundle(reload);
    if (didRecover) {
      event.preventDefault();
    }
  };

  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("error", onError);

  return () => {
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("error", onError);
  };
}
