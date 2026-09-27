/**
 * Self-healing for a corrupted persisted Supabase auth session.
 *
 * The Supabase browser client persists the session (a base64url-encoded JWT) in
 * `sb-<project-ref>-auth-token` cookies/localStorage and decodes it on startup
 * and on every background auto-refresh tick. If that stored value is truncated
 * or otherwise mangled — cookie-chunk reassembly gone wrong, a partial write, a
 * meddling extension/proxy — `@supabase/auth-js` / `@supabase/ssr`'s hand-rolled
 * base64url decoder hits bytes that aren't valid UTF-8 and throws
 * `Error: Invalid UTF-8 sequence` (see `stringFromUTF8` in their `base64url.ts`).
 *
 * Because that decode runs inside Supabase's own internal session/refresh flow
 * (not behind any `await` in our code), the throw escapes as an *unhandled
 * promise rejection* with no recovery: the user is stuck on a page that can't
 * read its own auth state, and Sentry fills with `Invalid UTF-8 sequence`.
 *
 * The only fix is to drop the unreadable token. This module detects the error,
 * clears the Supabase auth storage, and force-reloads exactly once (guarded
 * against reload loops) — a corrupt session then self-heals into a clean
 * sign-in instead of a dead page. Mirrors `staleBundleRecovery.ts`.
 */

const RELOAD_GUARD_KEY = "pawtograder:corrupt-session-reloaded-at";
// Don't reload more than once per cooldown window. If clearing + reloading
// doesn't stop the error (e.g. the corruption is re-created by something we
// don't control, or it's a false match), we must not trap the user in a loop.
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * True when `error` is the Supabase base64url/JWT decode failure for a corrupt
 * stored session rather than a genuine application bug. Matched on the exact
 * message because production stacks are minified (so frame/module matching is
 * unavailable) — and `Invalid UTF-8 sequence` is specific to Supabase's
 * `stringFromUTF8` decoder (the native `TextDecoder` uses different wording),
 * so message-only matching stays conservative.
 */
export function isCorruptSessionError(error: unknown): boolean {
  if (!error) return false;
  const message = typeof error === "string" ? error : ((error as { message?: string })?.message ?? "");
  return /Invalid UTF-8 sequence/.test(message);
}

/**
 * Remove every persisted Supabase auth artifact (cookies + Web Storage) so the
 * next load starts with no session. Supabase namespaces all of these with an
 * `sb-` prefix and an `-auth-token` infix (chunked as `…-auth-token.0/.1/…`),
 * so we clear by prefix rather than reconstructing the project ref.
 */
export function clearCorruptAuthStorage(): void {
  if (typeof document !== "undefined") {
    const host = window.location.hostname;
    // Try the bare host and its registrable-domain parent (covers cookies set
    // with an explicit `domain=.pawtograder.com`).
    const domains = [undefined, host, host.replace(/^[^.]+\./, "."), `.${host}`];
    for (const cookie of document.cookie.split(";")) {
      const name = cookie.split("=")[0]?.trim();
      if (!name || !name.startsWith("sb-")) continue;
      for (const domain of domains) {
        document.cookie = `${name}=; Max-Age=0; path=/${domain ? `; domain=${domain}` : ""}`;
      }
    }
  }
  for (const store of [
    typeof window !== "undefined" ? window.localStorage : null,
    typeof window !== "undefined" ? window.sessionStorage : null
  ]) {
    if (!store) continue;
    try {
      // Snapshot keys first — removing while iterating reindexes the store.
      const keys: string[] = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && key.startsWith("sb-")) keys.push(key);
      }
      keys.forEach((key) => store.removeItem(key));
    } catch {
      /* storage can throw in private mode / when blocked — ignore */
    }
  }
}

function hasRecentlyReloaded(): boolean {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_GUARD_KEY);
    if (!raw) return false;
    const last = Number(raw);
    if (!Number.isFinite(last)) return false;
    return Date.now() - last < RELOAD_COOLDOWN_MS;
  } catch {
    // sessionStorage can throw (private mode / blocked). Fail safe by assuming we
    // have NOT reloaded so a real corrupt session still self-heals; the browser's
    // own reload throttling backstops any loop.
    return false;
  }
}

function markReloaded(): void {
  try {
    // Stamp the guard *before* clearing storage below would wipe it — the guard
    // lives under its own key, not the `sb-` namespace, so clearing won't touch it.
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

const defaultReload = () => window.location.reload();

/**
 * Recover from a detected corrupt-session error by clearing Supabase auth
 * storage and force-reloading once. Returns true if a reload was scheduled,
 * false if suppressed by the loop guard. The reload action is injectable to
 * keep this testable (`window.location.reload` is non-configurable in jsdom).
 */
export function recoverFromCorruptSession(reload: () => void = defaultReload): boolean {
  if (typeof window === "undefined") return false;
  if (hasRecentlyReloaded()) return false;
  markReloaded();
  clearCorruptAuthStorage();
  reload();
  return true;
}

/**
 * Install global listeners that detect a corrupt persisted Supabase session and
 * self-heal. Safe to call once at client startup; no-ops on the server. Returns
 * an uninstall function (used by tests).
 */
export function installCorruptSessionRecovery(options: { reload?: () => void } = {}): () => void {
  if (typeof window === "undefined") return () => {};
  const reload = options.reload ?? defaultReload;

  const onRejection = (event: PromiseRejectionEvent) => {
    if (!isCorruptSessionError(event.reason)) return;
    if (recoverFromCorruptSession(reload)) {
      // Mark handled so it doesn't surface as a fatal unhandled rejection / Sentry noise.
      event.preventDefault();
    }
  };

  const onError = (event: ErrorEvent) => {
    if (!isCorruptSessionError(event.error ?? event.message)) return;
    if (recoverFromCorruptSession(reload)) {
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
