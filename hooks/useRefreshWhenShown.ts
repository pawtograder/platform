"use client";

import { useRouter } from "next/navigation";
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
 * A tab shown while the browser knows it's offline doesn't refresh, and catches up when the network
 * returns. router.refresh() falls back to location.replace when its fetch fails, and with no network
 * that swaps the dashboard for the browser's error page. `navigator.onLine` can still say true on
 * Wi-Fi that has only just woken or sits behind a captive portal, and a 5xx takes the same fallback.
 */
export function useRefreshWhenShown(
  renderedAt: number,
  minIntervalMs: number = REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS
): void {
  const router = useRouter();
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    lastRefreshAt.current = Math.max(lastRefreshAt.current, Math.min(Date.now(), renderedAt));

    const refreshIfDue = () => {
      if (document.visibilityState !== "visible") return;
      // Before lastRefreshAt is written, so a skipped refresh doesn't use up the minute.
      if (!navigator.onLine) return;
      const now = Date.now();
      if (now - lastRefreshAt.current < minIntervalMs) return;
      lastRefreshAt.current = now;
      router.refresh();
    };

    document.addEventListener("visibilitychange", refreshIfDue);
    window.addEventListener("online", refreshIfDue);
    return () => {
      document.removeEventListener("visibilitychange", refreshIfDue);
      window.removeEventListener("online", refreshIfDue);
    };
  }, [router, renderedAt, minIntervalMs]);
}
