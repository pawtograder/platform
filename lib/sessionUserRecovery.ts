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

const RELOAD_GUARD_KEY = "pawtograder:session-user-mismatch-reload-guard";
// Don't reload more than once per cooldown window *for the same mismatch*. If
// reloading doesn't resolve the mismatch (say the server render disagrees with
// the cookie for a reason we haven't anticipated), the user must not be trapped
// in a reload loop.
const RELOAD_COOLDOWN_MS = 30_000;
// How often to compare the live session against the render while the tab is
// visible. Sign-in happens in a server action here (`app/actions.ts`), which
// swaps the shared auth cookie without any browser client emitting an auth
// event — so a tab that stays visible the whole time (a course window open
// beside the window someone signs in from) gets no `onAuthStateChange` and no
// visibility-triggered recovery from supabase-js either. Reading the session is
// a local cookie parse, not a request.
const SESSION_POLL_INTERVAL_MS = 60_000;

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

/**
 * The last reload we performed, recorded as the mismatch that caused it. Keyed
 * by the pair rather than by time alone: a *different* mismatch arriving during
 * the cooldown (A → B reloads, then B → C lands seconds later) is a new problem
 * and must still heal, whereas the *same* pair recurring means the reload
 * didn't converge and repeating it would loop.
 */
type ReloadGuard = { at: number; renderedUserId: string; sessionUserId: string };

function readReloadGuard(): ReloadGuard | null {
  try {
    const raw = window.sessionStorage.getItem(RELOAD_GUARD_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { at, renderedUserId, sessionUserId } = parsed as Partial<ReloadGuard>;
    if (typeof at !== "number" || !Number.isFinite(at)) return null;
    if (typeof renderedUserId !== "string" || typeof sessionUserId !== "string") return null;
    return { at, renderedUserId, sessionUserId };
  } catch {
    // Storage can throw (private mode / blocked) and the value can be garbage.
    // Fail safe by assuming we have NOT reloaded, so a real identity swap still
    // heals; the browser's own reload throttling backstops any loop.
    return null;
  }
}

function hasRecentlyReloadedFor(renderedUserId: string, sessionUserId: string): boolean {
  const guard = readReloadGuard();
  if (!guard) return false;
  if (guard.renderedUserId !== renderedUserId || guard.sessionUserId !== sessionUserId) return false;
  return Date.now() - guard.at < RELOAD_COOLDOWN_MS;
}

function markReloaded(renderedUserId: string, sessionUserId: string): void {
  try {
    window.sessionStorage.setItem(
      RELOAD_GUARD_KEY,
      JSON.stringify({ at: Date.now(), renderedUserId, sessionUserId } satisfies ReloadGuard)
    );
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
export function recoverFromForeignSession(
  renderedUserId: string,
  sessionUserId: string,
  reload: () => void = defaultReload
): boolean {
  if (typeof window === "undefined") return false;
  if (hasRecentlyReloadedFor(renderedUserId, sessionUserId)) return false;
  markReloaded(renderedUserId, sessionUserId);
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
  reload = defaultReload,
  pollIntervalMs = SESSION_POLL_INTERVAL_MS
}: {
  client: Pick<SupabaseClient, "auth">;
  renderedUserId: string | null | undefined;
  reload?: () => void;
  pollIntervalMs?: number;
}): () => void {
  if (typeof window === "undefined") return () => {};

  const check = (sessionUserId: string | null | undefined) => {
    if (!renderedUserId || !sessionUserId) return;
    if (!isForeignSessionUser(renderedUserId, sessionUserId)) return;
    recoverFromForeignSession(renderedUserId, sessionUserId, reload);
  };

  // Fires immediately with INITIAL_SESSION, which also covers the case where the
  // swap happened before this listener was installed. Covers the reported case:
  // supabase-js re-reads storage when the tab becomes visible again and emits
  // SIGNED_IN for the replacement session.
  const { data } = client.auth.onAuthStateChange((_event, session) => check(session?.user?.id));

  // Backstop for a tab that never goes hidden, where no auth event fires at all
  // (see SESSION_POLL_INTERVAL_MS).
  const poll = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void client.auth
      .getSession()
      .then(({ data: { session } }) => check(session?.user?.id))
      // A failed session read tells us nothing about identity; leave the tab be.
      .catch(() => {});
  }, pollIntervalMs);

  return () => {
    data.subscription.unsubscribe();
    window.clearInterval(poll);
  };
}
