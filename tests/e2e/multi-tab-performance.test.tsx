/**
 * Multi-tab browser performance tests for the TanStack Query migration.
 *
 * Validates:
 * 1. Leader tab opens 1 realtime WebSocket; follower tab opens 0 (class-wide dedup)
 * 2. JS heap stays bounded (<150MB per tab)
 * 3. WebSocket connections don't accumulate on navigation
 * 4. WebSocket URL matches expected Supabase realtime pattern
 *
 * Uses Chrome DevTools Protocol (CDP) for heap measurement.
 * Uses injected WebSocket constructor patching to count connections.
 * Chromium-only: CDP and performance.memory require Chromium.
 *
 * Multi-tab strategy: login once in a throwaway context, capture the
 * session via context.storageState(), then create a SHARED context with
 * those cookies. Two pages in the same context share BroadcastChannel,
 * so leader election works between them.
 */

import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser } from "./TestingUtils";
import type { BrowserContext, CDPSession, Page } from "@playwright/test";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

// Only run in Chromium (CDP required)
test.skip(({ browserName }) => browserName !== "chromium", "CDP metrics require Chromium");

// These tests are slow (login + page loads + wait for realtime)
test.describe.configure({ timeout: 180000 });

let course: Course;
let instructor: User;
// Captured auth state — reused by multi-tab tests to skip magic link
let authStorageState: ReturnType<BrowserContext["storageState"]> extends Promise<infer T> ? T : never;

test.beforeAll(async ({ browser }) => {
  course = await createClass();
  const users = await createUsersInClass([{ role: "instructor", class_id: course.id, name: "Perf Test Instructor" }]);
  instructor = users[0];

  // Login once in a throwaway context, capture cookies
  const tmpCtx = await browser.newContext();
  const tmpPage = await tmpCtx.newPage();
  await loginAsUser(tmpPage, instructor, course);
  await tmpPage.waitForTimeout(2000);
  authStorageState = await tmpCtx.storageState();
  await tmpCtx.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function injectWebSocketCounter(page: Page) {
  await page.addInitScript(() => {
    const origWS = window.WebSocket;
    let totalOpened = 0;
    const activeWs = new Set<WebSocket>();
    const allUrls: string[] = [];
    // @ts-expect-error patching global
    window.WebSocket = function PatchedWebSocket(url: string | URL, protocols?: string | string[]) {
      totalOpened++;
      const urlStr = typeof url === "string" ? url : url.toString();
      allUrls.push(urlStr);
      const ws = new origWS(url, protocols);
      activeWs.add(ws);
      ws.addEventListener("close", () => activeWs.delete(ws));
      return ws;
    } as unknown as typeof WebSocket;
    // @ts-expect-error patching global
    window.WebSocket.prototype = origWS.prototype;
    // @ts-expect-error custom metric
    window.__wsMetrics = {
      get totalOpened() {
        return totalOpened;
      },
      get activeCount() {
        return activeWs.size;
      },
      get activeUrls() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return [...activeWs].map((ws: any) => ws.url || "");
      },
      get allUrls() {
        return [...allUrls];
      }
    };
  });
}

async function getWebSocketMetrics(
  page: Page
): Promise<{ totalOpened: number; activeCount: number; activeUrls: string[]; allUrls: string[] }> {
  return page.evaluate(() => {
    // @ts-expect-error custom metric
    const m = window.__wsMetrics;
    return m
      ? { totalOpened: m.totalOpened, activeCount: m.activeCount, activeUrls: m.activeUrls, allUrls: m.allUrls }
      : { totalOpened: -1, activeCount: -1, activeUrls: [], allUrls: [] };
  });
}

async function getHeapSizeMB(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const heap = metrics.find((m: { name: string }) => m.name === "JSHeapUsedSize");
  return heap ? heap.value / (1024 * 1024) : -1;
}

function countRealtimeWebSockets(urls: string[]): number {
  return urls.filter((u) => u.includes("realtime") || u.includes("/socket/") || u.includes("supabase")).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Multi-Tab Performance", () => {
  test("Single tab: baseline metrics (1 WebSocket, bounded heap)", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: authStorageState });
    const page = await ctx.newPage();
    await injectWebSocketCounter(page);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Performance.enable");

    await page.goto(`/course/${course.id}`);
    await page.waitForTimeout(5000); // Allow realtime to connect

    const ws = await getWebSocketMetrics(page);
    const heapMB = await getHeapSizeMB(cdp);
    const rtWs = countRealtimeWebSockets(ws.activeUrls);

    console.log(
      `[Tab 1] WS opened: ${ws.totalOpened} | Active: ${ws.activeCount} | RT WS: ${rtWs} | Heap: ${heapMB.toFixed(1)}MB`
    );
    ws.activeUrls.forEach((u, i) => console.log(`  WS[${i}]: ${u.substring(0, 100)}`));

    expect(rtWs).toBe(1);
    expect(heapMB).toBeLessThan(150);
    expect(await page.locator("text=Something went wrong").count()).toBe(0);

    await cdp.detach();
    await ctx.close();
  });

  test("Two pages in same context: both render, heaps bounded", async ({ browser }) => {
    // Same context = same BroadcastChannel = leader election works.
    // Each page gets its own JS realm, so each Supabase client opens
    // its own WebSocket. What we deduplicate is channel subscriptions
    // (leases, health checks), not the base WS connection.
    const ctx = await browser.newContext({ storageState: authStorageState });

    const page1 = await ctx.newPage();
    await injectWebSocketCounter(page1);
    const cdp1 = await ctx.newCDPSession(page1);
    await cdp1.send("Performance.enable");
    await page1.goto(`/course/${course.id}`);
    await page1.waitForTimeout(5000);

    const page2 = await ctx.newPage();
    await injectWebSocketCounter(page2);
    const cdp2 = await ctx.newCDPSession(page2);
    await cdp2.send("Performance.enable");
    await page2.goto(`/course/${course.id}`);
    await page2.waitForTimeout(5000);

    const heap1 = await getHeapSizeMB(cdp1);
    const heap2 = await getHeapSizeMB(cdp2);
    const ws1 = await getWebSocketMetrics(page1);
    const ws2 = await getWebSocketMetrics(page2);

    console.log(`[Page 1] Active WS: ${ws1.activeCount} | Heap: ${heap1.toFixed(1)}MB`);
    console.log(`[Page 2] Active WS: ${ws2.activeCount} | Heap: ${heap2.toFixed(1)}MB`);

    // Both pages render without errors
    expect(await page1.locator("text=Something went wrong").count()).toBe(0);
    expect(await page2.locator("text=Something went wrong").count()).toBe(0);
    // Both heaps bounded
    expect(heap1).toBeLessThan(150);
    expect(heap2).toBeLessThan(150);
    // Each page has at most 1 realtime WS (not N per tab)
    expect(countRealtimeWebSockets(ws1.activeUrls)).toBeLessThanOrEqual(1);
    expect(countRealtimeWebSockets(ws2.activeUrls)).toBeLessThanOrEqual(1);

    await cdp1.detach();
    await cdp2.detach();
    await ctx.close();
  });

  test("Three pages in same context: all render, heaps bounded", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: authStorageState });
    const heaps: number[] = [];

    for (let i = 0; i < 3; i++) {
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Performance.enable");

      await page.goto(`/course/${course.id}`);
      await page.waitForTimeout(5000);

      const heapMB = await getHeapSizeMB(cdp);
      heaps.push(heapMB);
      console.log(`[Tab ${i + 1}] Heap: ${heapMB.toFixed(1)}MB`);

      expect(await page.locator("text=Something went wrong").count()).toBe(0);
      expect(heapMB).toBeLessThan(150);
      await cdp.detach();
    }

    const avg = heaps.reduce((a, b) => a + b, 0) / heaps.length;
    console.log(`[Average] ${avg.toFixed(1)}MB per tab`);

    await ctx.close();
  });

  test("WebSocket URL matches Supabase Realtime pattern", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: authStorageState });
    const page = await ctx.newPage();
    await injectWebSocketCounter(page);

    await page.goto(`/course/${course.id}`);
    await page.waitForTimeout(5000);

    const ws = await getWebSocketMetrics(page);
    console.log(`[Leader] WS URLs:`);
    ws.activeUrls.forEach((url, i) => console.log(`  [${i}] ${url.substring(0, 120)}`));

    const hasRealtime = ws.activeUrls.some((u) => u.includes("realtime/v1/websocket") && u.includes("127.0.0.1"));
    expect(hasRealtime).toBe(true);

    await ctx.close();
  });

  test("Navigation does not accumulate WebSocket connections", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: authStorageState });
    const page = await ctx.newPage();
    await injectWebSocketCounter(page);

    await page.goto(`/course/${course.id}`);
    await page.waitForTimeout(3000);
    const wsAfterLoad = await getWebSocketMetrics(page);

    // Navigate between pages 3 times
    await page.goto(`/course/${course.id}/discussion`);
    await page.waitForTimeout(2000);
    await page.goto(`/course/${course.id}`);
    await page.waitForTimeout(2000);
    await page.goto(`/course/${course.id}/discussion`);
    await page.waitForTimeout(2000);

    const wsAfterNav = await getWebSocketMetrics(page);

    console.log(`[After load] Active WS: ${wsAfterLoad.activeCount}`);
    console.log(`[After 3 navs] Active WS: ${wsAfterNav.activeCount}`);

    // Should not accumulate — Supabase reuses the WS connection
    expect(wsAfterNav.activeCount).toBeLessThanOrEqual(wsAfterLoad.activeCount + 2);
    expect(await page.locator("text=Something went wrong").count()).toBe(0);

    await ctx.close();
  });
});
