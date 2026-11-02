"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Shortest gap between two refreshes, counting the page load as the first. */
export const REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS = 60_000;

/**
 * Re-render the page's Server Components when a hidden tab is shown again, so data that changed
 * while the student was away (a survey that opened, one they submitted in another tab) shows up
 * without a reload.
 *
 * Throttled to once per `minIntervalMs`: someone flicking between tabs would otherwise refetch
 * the whole page on every switch. The page load counts as a fetch, so a tab shown again within
 * a minute of loading does not refresh.
 */
export function useRefreshWhenShown(minIntervalMs: number = REFRESH_WHEN_SHOWN_MIN_INTERVAL_MS): void {
  const router = useRouter();

  useEffect(() => {
    let lastRefreshAt = Date.now();
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefreshAt < minIntervalMs) return;
      lastRefreshAt = now;
      router.refresh();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [router, minIntervalMs]);
}
