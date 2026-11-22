"use client";

import { refreshCurrentPage } from "@/lib/refreshCurrentPage";
import { recoverFromStaleBundle } from "@/lib/staleBundleRecovery";
import { useEffect, useRef } from "react";

/** Shortest gap between two refreshes, counting the server render of the data on screen as the first. */
export const REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

/**
 * Re-render the page's Server Components when a hidden tab is shown again, so data that changed
 * while the student was away (a survey that opened, one they submitted in another tab) shows up
 * without a reload.
 *
 * Throttled to once per `minIntervalMs`: someone flicking between tabs would otherwise refetch
 * the whole page on every switch. The minute counts from `renderedAt`, the time the server
 * rendered the data on screen, not from mount. Back restores a page from the router cache
 * whatever its age, so a page that mounted a second ago can be an hour old. A new payload, from
 * this refresh or any other, brings a new `renderedAt` and restarts the count.
 *
 * `renderedAt` is on the server's clock. Taking the earlier of it and the browser clock means a
 * server clock that runs ahead can hold a refresh off by at most that gap, and never past a minute
 * after mount. Keeping the later of that and the last refresh this hook sent means a browser clock
 * that runs ahead costs at most one extra refresh.
 *
 * It refreshes through `refreshCurrentPage`, not `router.refresh()`, because that one's failure can
 * be caught. A failed `router.refresh()` is a hard navigation: Chromium replaces the dashboard with
 * its error page and stays there, and WebKit's router stays suspended. A failed refresh here leaves
 * the page as it was and gives the minute back, so the next show tries again. A refresh that failed
 * delivered nothing, and retrying costs one request per show. A response cut off partway is the
 * exception, described on `refreshCurrentPage`. A refresh that has not answered within 15 seconds
 * stops this hook waiting, but cannot cancel the action or unblock Next's server action queue.
 * The next eligible show may queue one retry, which goes out when the stalled action ends.
 * Further shows wait until an underlying action settles before queuing another refresh.
 *
 * An answer other than true means this tab can't refresh in place. False is another build. Nothing
 * at all is a page that isn't the action's reply: a build that no longer has this action, or a
 * signed-out tab redirected to sign-in. Either way a reload fixes it, as `router.refresh()` did.
 *
 * A tab shown while the browser knows it's offline doesn't try. It picks up changes to its list at
 * its next show or a reload, the same as a dashboard that stays visible, and its countdown stays
 * current because useNow reads the browser clock. Nothing refreshes on `online`: #977 agreed a
 * refresh on show, and a fetch sent the moment the browser reports a connection can fail.
 */
export function useRefreshWhenShown(
  renderedAt: number,
  minIntervalMs: number = REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS
): void {
  const lastRefreshAt = useRef(0);
  const unsettledRefreshes = useRef(new Set<object>());
  const refreshInFlight = useRef<{ timer?: ReturnType<typeof setTimeout> } | null>(null);

  useEffect(() => {
    lastRefreshAt.current = Math.max(lastRefreshAt.current, Math.min(Date.now(), renderedAt));
    let mounted = true;

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      // Before lastRefreshAt is written, so a skipped refresh doesn't use up the minute.
      if (!navigator.onLine) return;
      // The timeout only stops this hook waiting; it cannot unblock Next's action queue.
      // Allow one queued retry to go out when the stalled action ends.
      if (refreshInFlight.current) return;
      if (unsettledRefreshes.current.size >= 2) return;
      const now = Date.now();
      const previous = lastRefreshAt.current;
      // Negative when the clock was set back, which says nothing about how long ago the last one was.
      const sinceLast = now - previous;
      if (sinceLast >= 0 && sinceLast < minIntervalMs) return;
      lastRefreshAt.current = now;
      const attempt: { timer?: ReturnType<typeof setTimeout> } = {};
      refreshInFlight.current = attempt;
      const timeout = new Promise<never>((_, reject) => {
        attempt.timer = setTimeout(() => reject(new Error("Page refresh timed out")), REFRESH_TIMEOUT_MS);
      });
      unsettledRefreshes.current.add(attempt);
      const refresh = refreshCurrentPage(process.env.NEXT_PUBLIC_GIT_COMMIT_SHA);
      const settled = () => unsettledRefreshes.current.delete(attempt);
      // Track the action itself: a timeout leaves it in Next's queue.
      void refresh.then(settled, settled);
      // The race ignores late answers, including a build mismatch from an expired attempt.
      Promise.race([refresh, timeout])
        .then(
          (sameBuild) => {
            // Not after a link took the student elsewhere: a reload there could lose what they're typing.
            if (sameBuild !== true && mounted) recoverFromStaleBundle();
          },
          () => {
            if (mounted && lastRefreshAt.current === now) {
              lastRefreshAt.current = previous;
            }
          }
        )
        .finally(() => {
          clearTimeout(attempt.timer);
          if (refreshInFlight.current === attempt) refreshInFlight.current = null;
        });
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mounted = false;
      clearTimeout(refreshInFlight.current?.timer);
      refreshInFlight.current = null;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [renderedAt, minIntervalMs]);
}
