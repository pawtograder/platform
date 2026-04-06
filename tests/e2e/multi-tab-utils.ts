/**
 * Playwright helpers for multi-tab tests using multiple browser contexts.
 *
 * Note: BroadcastChannel does not work across separate Playwright browser
 * contexts (they run in independent processes), so true cross-tab testing
 * is not feasible with Playwright. These helpers are provided for
 * single-tab-per-context validation patterns.
 */

import { Browser, BrowserContext, Page } from "@playwright/test";
import { createClass, loginAsUser, TestingUser } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;

/**
 * Open multiple browser tabs (contexts) logged in as the same user.
 * Each context is an independent tab with its own session.
 */
export async function openMultipleTabs(
  browser: Browser,
  user: TestingUser,
  course: Course,
  count: number
): Promise<{ contexts: BrowserContext[]; pages: Page[] }> {
  const contexts: BrowserContext[] = [];
  const pages: Page[] = [];

  for (let i = 0; i < count; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await loginAsUser(page, user, course);
    contexts.push(context);
    pages.push(page);
  }

  return { contexts, pages };
}

/**
 * Close all browser contexts opened by {@link openMultipleTabs}.
 */
export async function closeAllTabs(contexts: BrowserContext[]) {
  for (const ctx of contexts) {
    await ctx.close();
  }
}
