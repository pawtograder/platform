import type { Page } from "@playwright/test";

/**
 * `longTasks(page)`: collects main-thread long tasks (>50 ms) with a PerformanceObserver, for the
 * recorder's overhead budget (K1: recorder long tasks < 5% of main-thread time).
 *
 * Call it before the first navigation: the observer is installed with an init script, so it runs
 * in every document the page loads. Each document keeps its own list; `read()` returns the
 * current document's. Chromium only; WebKit has no `longtask` entry type, and `supported` says so.
 */

export type LongTask = {
  /** ms since the document's time origin */
  startTime: number;
  duration: number;
  name: string;
  /** containerType/containerName of the first attribution entry, when the browser gives one */
  attribution?: string;
};

export type LongTaskReport = {
  supported: boolean;
  tasks: LongTask[];
  /** Sum of long-task durations */
  totalMs: number;
  /** ms since the document's time origin when read */
  elapsedMs: number;
  /** totalMs / elapsedMs */
  fraction: number;
};

declare global {
  interface Window {
    __bugReportLongTasks?: { supported: boolean; tasks: LongTask[] };
  }
}

export async function longTasks(page: Page): Promise<{ read(): Promise<LongTaskReport>; reset(): Promise<void> }> {
  await page.addInitScript(() => {
    const store = { supported: false, tasks: [] as LongTask[] };
    window.__bugReportLongTasks = store;
    try {
      store.supported = PerformanceObserver.supportedEntryTypes.includes("longtask");
      if (!store.supported) return;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const attribution = (
            entry as PerformanceEntry & { attribution?: { containerType?: string; containerName?: string }[] }
          ).attribution?.[0];
          store.tasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name,
            attribution: attribution
              ? `${attribution.containerType ?? ""}:${attribution.containerName ?? ""}`
              : undefined
          });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {
      store.supported = false;
    }
  });

  return {
    read: async () => {
      const { supported, tasks, elapsedMs } = await page.evaluate(() => ({
        supported: window.__bugReportLongTasks?.supported ?? false,
        tasks: window.__bugReportLongTasks?.tasks ?? [],
        elapsedMs: performance.now()
      }));
      const totalMs = tasks.reduce((n, t) => n + t.duration, 0);
      return { supported, tasks, totalMs, elapsedMs, fraction: elapsedMs > 0 ? totalMs / elapsedMs : 0 };
    },
    reset: async () => {
      await page.evaluate(() => {
        if (window.__bugReportLongTasks) window.__bugReportLongTasks.tasks = [];
      });
    }
  };
}
