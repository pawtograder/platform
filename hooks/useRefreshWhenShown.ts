"use client";

import { refreshCurrentPage } from "@/lib/refreshCurrentPage";
import { useEffect, useRef } from "react";

/** Shortest gap between two refreshes, counting the server render of the data on screen as the first. */
export const REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS = 60_000;

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
 * exception, described on `refreshCurrentPage`.
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

  useEffect(() => {
    lastRefreshAt.current = Math.max(lastRefreshAt.current, Math.min(Date.now(), renderedAt));

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      // Before lastRefreshAt is written, so a skipped refresh doesn't use up the minute.
      if (!navigator.onLine) return;
      const now = Date.now();
      const previous = lastRefreshAt.current;
      if (now - previous < minIntervalMs) return;
      lastRefreshAt.current = now;
      refreshCurrentPage().catch(() => {
        if (lastRefreshAt.current === now) lastRefreshAt.current = previous;
      });
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [renderedAt, minIntervalMs]);
}
