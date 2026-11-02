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
 * `renderedAt` is on the server's clock. Taking the earlier of it and the browser clock keeps a
 * server clock that runs ahead from holding a refresh off. Keeping the later of that and the last
 * refresh this hook sent means a browser clock that runs ahead costs at most one extra refresh.
 */
export function useRefreshWhenShown(
  renderedAt: number,
  minIntervalMs: number = REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS
): void {
  const router = useRouter();
  const lastRefreshAt = useRef(0);

  useEffect(() => {
    lastRefreshAt.current = Math.max(lastRefreshAt.current, Math.min(Date.now(), renderedAt));

    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefreshAt.current < minIntervalMs) return;
      lastRefreshAt.current = now;
      router.refresh();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [router, renderedAt, minIntervalMs]);
}
