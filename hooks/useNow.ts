"use client";

import { useEffect, useState } from "react";

/** How often a visible page re-reads the clock. Anything shown relative to now is at most this stale. */
export const NOW_TICK_MS = 30_000;

/**
 * The current time in epoch ms, for UI that shows time relative to now ("Due in 5 minutes",
 * "Overdue").
 *
 * Starts at `initialNow`, the time the server rendered the page, so the first client render
 * shows the same text as the server render, and hydrates cleanly wherever the component is in
 * the server HTML. After mount it switches to the browser clock and re-reads it every
 * `intervalMs` while the tab is visible. A hidden tab stops ticking, and reads the clock again
 * as soon as it is shown.
 *
 * Switching on mount also covers a page restored from the client Router Cache (Back, or a
 * link within `staleTimes.dynamic`): the cached payload carries an old `initialNow`, and the
 * first effect replaces it.
 */
export function useNow(initialNow: number, intervalMs: number = NOW_TICK_MS): number {
  const [now, setNow] = useState(initialNow);

  useEffect(() => {
    let timer: number | undefined;
    const tick = () => setNow(Date.now());
    const start = () => {
      if (timer === undefined) timer = window.setInterval(tick, intervalMs);
    };
    const stop = () => {
      window.clearInterval(timer);
      timer = undefined;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        tick();
        start();
      } else {
        stop();
      }
    };

    tick();
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [intervalMs]);

  return now;
}
