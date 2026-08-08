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
 *
 * SIGNING OUT elsewhere is the same failure with the session removed rather than
 * replaced, and it is the worse half: `signOutAction` clears the shared cookie
 * for every tab and redirects only the tab it was invoked from, so every other
 * open tab keeps its rendered, authenticated page — and whatever private data is
 * already on screen — until someone navigates or reloads it by hand. On a shared
 * or lab machine that is the whole point of signing out defeated (issue #911).
 *
 * That case cannot be detected as permissively as a mismatch, because a null
 * session is ambiguous: genuinely signed out, or a token refresh that failed.
 * Three things keep it safe — only a *clean* read counts
 * (`isConfirmedAbsentSession`), only the poll acts on it (never an auth event,
 * whose null sessions are routine), and it is bounded to one reload per tab so an
 * environment where the reload cannot converge costs one reload rather than a
 * loop.
 */

const RELOAD_GUARD_KEY = "pawtograder:session-user-mismatch-reload-guard";
// Separate from RELOAD_GUARD_KEY because the two guards answer different
// questions. The mismatch guard is keyed by the (rendered, session) PAIR and
// expires, so a new mismatch still heals; the signed-out guard has no second
// user to key on and must NOT expire — see hasReloadedForSignOut.
const SIGNED_OUT_RELOAD_GUARD_KEY = "pawtograder:session-signed-out-reload-guard";
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
 * was rendered for. Deliberately conservative: an absent session is *not* a
 * mismatch — that case is handled separately by isConfirmedAbsentSession, which
 * can afford to be strict about it in a way this predicate cannot.
 */
export function isForeignSessionUser(
  renderedUserId: string | null | undefined,
  sessionUserId: string | null | undefined
): boolean {
  if (!renderedUserId || !sessionUserId) return false;
  return renderedUserId !== sessionUserId;
}

/**
 * True when the session is absent and we can BELIEVE that it is absent.
 *
 * `getSession()` returns a null session for two very different reasons: the user
 * is genuinely signed out (the case this recovers), or an access token needed
 * refreshing and the refresh failed (a network blip). Acting on an
 * undiscriminated null would throw people off a working page whenever their
 * connection wobbles, which is why #902 left this alone.
 *
 * The discriminator is the error channel: supabase-js reports a failed refresh
 * as an error alongside the null session, whereas a real sign-out is a clean
 * read that simply finds nothing. So an error — of any kind, including a
 * rejected promise, which the caller treats the same way — means "we do not
 * know", never "signed out".
 */
export function isConfirmedAbsentSession(sessionUserId: string | null | undefined, error: unknown = null): boolean {
  if (error) return false;
  return !sessionUserId;
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

/**
 * Has this tab already reloaded once because its session went away, while
 * rendered for this user?
 *
 * Deliberately NOT time-boxed, unlike the mismatch guard. A mismatch reload
 * converges — client and server read the same cookie, so the new render matches
 * the new session — and its cooldown exists only so a *different* mismatch can
 * still heal. A signed-out reload has no such guarantee: if the server keeps
 * rendering authenticated while the browser cannot read the cookie (a partitioned
 * or blocked cookie jar, an extension, a proxy rewriting Set-Cookie), the reload
 * lands on the same authenticated page with the same absent session and the poll
 * fires again 60s later, forever. A cooldown would merely set the loop's period.
 *
 * So the bound is one reload per tab per rendered user, cleared only by evidence
 * that the recovery is unnecessary (a real session for that user, see
 * clearSignedOutReloadGuard). A non-converging environment costs exactly one
 * extra reload instead of a permanent loop; a genuine sign-out gets its reload.
 * Keyed by user so a sign-in/sign-out cycle in the same tab recovers again even
 * if the guard was somehow not cleared.
 */
function hasReloadedForSignOut(renderedUserId: string): boolean {
  try {
    return window.sessionStorage.getItem(SIGNED_OUT_RELOAD_GUARD_KEY) === renderedUserId;
  } catch {
    // Same failure posture as readReloadGuard: assume we have NOT reloaded, so a
    // real sign-out still heals. The browser's own reload throttling backstops.
    return false;
  }
}

function markReloadedForSignOut(renderedUserId: string): void {
  try {
    window.sessionStorage.setItem(SIGNED_OUT_RELOAD_GUARD_KEY, renderedUserId);
  } catch {
    /* ignore */
  }
}

/**
 * Forget any signed-out reload this tab performed. Called whenever a valid
 * session for the rendered user is observed: that is proof the tab is in a
 * consistent state, so a LATER sign-out in the same tab must be able to recover
 * again rather than being suppressed by a stale marker from an earlier cycle.
 */
function clearSignedOutReloadGuard(): void {
  try {
    window.sessionStorage.removeItem(SIGNED_OUT_RELOAD_GUARD_KEY);
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
 * Reload once for a confirmed sign-out elsewhere. Returns true if a reload was
 * performed, false if suppressed by the one-per-tab guard.
 */
export function recoverFromSignedOutSession(renderedUserId: string, reload: () => void = defaultReload): boolean {
  if (typeof window === "undefined") return false;
  if (hasReloadedForSignOut(renderedUserId)) return false;
  markReloadedForSignOut(renderedUserId);
  reload();
  return true;
}

/**
 * Watch the auth session for the lifetime of the page and reload if it starts
 * belonging to someone other than `renderedUserId`, or stops existing at all.
 * No-ops on the server. Returns an uninstall function.
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
    if (!isForeignSessionUser(renderedUserId, sessionUserId)) {
      // The tab holds a real session for the user it was rendered for, so it is
      // demonstrably consistent. Drop any signed-out marker left by an earlier
      // cycle so a future sign-out in this tab can still recover.
      clearSignedOutReloadGuard();
      return;
    }
    recoverFromForeignSession(renderedUserId, sessionUserId, reload);
  };

  // Fires immediately with INITIAL_SESSION, which also covers the case where the
  // swap happened before this listener was installed. Covers the reported case:
  // supabase-js re-reads storage when the tab becomes visible again and emits
  // SIGNED_IN for the replacement session.
  const { data } = client.auth.onAuthStateChange((_event, session) => check(session?.user?.id));

  // Backstop for a tab that never goes hidden, where no auth event fires at all
  // (see SESSION_POLL_INTERVAL_MS).
  //
  // This is also the ONLY path that acts on a sign-out, deliberately. Sign-out
  // here is a server action (`signOutAction` in app/actions.ts): it clears the
  // shared cookie and redirects the initiating tab, and no browser client emits
  // anything, so `onAuthStateChange` never fires in the tabs that need
  // recovering. The event path is the wrong place to act on a null session
  // anyway — INITIAL_SESSION arrives with none on any page that legitimately has
  // no session yet, and treating that as a sign-out would reload the sign-in
  // page. A poll tick, by contrast, is a positive statement about *now*.
  const poll = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    void client.auth
      .getSession()
      .then(({ data: { session }, error }) => {
        const sessionUserId = session?.user?.id;
        if (sessionUserId) {
          check(sessionUserId);
          return;
        }
        // No session. Only a CLEAN read proves the user is signed out rather
        // than mid-failed-refresh (see isConfirmedAbsentSession).
        if (!renderedUserId) return;
        if (!isConfirmedAbsentSession(sessionUserId, error)) return;
        recoverFromSignedOutSession(renderedUserId, reload);
      })
      // A failed session read tells us nothing — neither about identity nor
      // about whether the user is still signed in. Leave the tab be.
      .catch(() => {});
  }, pollIntervalMs);

  return () => {
    data.subscription.unsubscribe();
    window.clearInterval(poll);
  };
}
