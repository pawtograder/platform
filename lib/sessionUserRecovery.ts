import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Self-healing for a tab whose auth session no longer belongs to the user the
 * page was rendered for.
 *
 * The Supabase browser client persists its session in shared, cross-tab storage
 * (`sb-<ref>-auth-token` cookies, see `utils/supabase/client.ts`). Signing in as
 * a different user in *any* tab therefore replaces the session under every other
 * open tab — including one that has been sitting in the background for hours
 * with a fully server-rendered page for the previous user.
 *
 * Nothing re-renders on that swap, so the tab keeps showing user A's course
 * while every request it makes is now authorized as user B. Under RLS the
 * results come back empty rather than forbidden: single-row fetches resolve to
 * "no such row" (the crash this shipped with — see `lib/refineDataProvider.ts`),
 * lists silently empty out, and writes fail or land under the wrong identity.
 *
 * The only correct state for that tab is the one the server would render for
 * the session it actually holds, so we reload it once (guarded against loops).
 * Because client and server share the same cookie, the reload converges: the
 * new render matches the new session and no further mismatch fires. Mirrors
 * `staleBundleRecovery.ts` / `corruptSessionRecovery.ts`.
 */

const RELOAD_GUARD_KEY = "pawtograder:session-user-mismatch-reloaded-at";
// Don't reload more than once per cooldown window. If reloading doesn't resolve
// the mismatch (say the server render disagrees with the cookie for a reason we
// haven't anticipated), the user must not be trapped in a reload loop.
const RELOAD_COOLDOWN_MS = 30_000;

/**
 * True when the live session belongs to a different user than the one the page
 * was rendered for. Deliberately conservative: an absent session (signed out,
 * or an event that carries none) is *not* a mismatch — sign-out has its own
 * redirect path, and reloading a signed-out tab would race it.
 */
export function isForeignSessionUser(
  renderedUserId: string | null | undefined,
  sessionUserId: string | null | undefined
): boolean {
  if (!renderedUserId || !sessionUserId) return false;
  return renderedUserId !== sessionUserId;
}

function hasRecentlyReloaded(): boolean {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_GUARD_KEY);
    if (!raw) return false;
    const last = Number(raw);
    if (!Number.isFinite(last)) return false;
    return Date.now() - last < RELOAD_COOLDOWN_MS;
  } catch {
    // Storage can throw (private mode / blocked). Fail safe by assuming we have
    // NOT reloaded, so a real identity swap still heals; the browser's own
    // reload throttling backstops any loop.
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

// `window.location.reload` is non-configurable in jsdom, so the reload action is
// injectable to keep this testable.
const defaultReload = () => window.location.reload();

/**
 * Reload once for a detected identity mismatch. Returns true if a reload was
 * performed, false if suppressed by the loop guard.
 */
export function recoverFromForeignSession(reload: () => void = defaultReload): boolean {
  if (typeof window === "undefined") return false;
  if (hasRecentlyReloaded()) return false;
  markReloaded();
  reload();
  return true;
}

/**
 * Watch the auth session for the lifetime of the page and reload if it starts
 * belonging to someone other than `renderedUserId`. No-ops on the server.
 * Returns an uninstall function.
 */
export function installSessionUserRecovery({
  client,
  renderedUserId,
  reload = defaultReload
}: {
  client: Pick<SupabaseClient, "auth">;
  renderedUserId: string | null | undefined;
  reload?: () => void;
}): () => void {
  if (typeof window === "undefined") return () => {};

  // Fires immediately with INITIAL_SESSION, which also covers the case where the
  // swap happened before this listener was installed.
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    if (!isForeignSessionUser(renderedUserId, session?.user?.id)) return;
    recoverFromForeignSession(reload);
  });

  return () => data.subscription.unsubscribe();
}
