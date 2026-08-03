/**
 * Shared page-readiness helpers for the a11y evidence collectors and the
 * agentic AT harness. Extracted verbatim from tests/e2e/a11y-evidence.spec.ts
 * (Wave 1 of a11y-judge v2) so both drivers settle pages identically.
 */
import type { Locator, Page } from "@playwright/test";
import { expect } from "@playwright/test";

export const SETTLE_MS = 1500;

/**
 * Page-ready wait that tolerates active mutations. Clean runs use the strict
 * content wait unchanged; mutation-tolerant runs first try it briefly, then
 * fall back to a structural signal — mutations like 246-headings-generic
 * rewrite the very heading text the strict waits key on, which otherwise
 * kills the run.
 */
export async function waitForPageReady(
  page: Page,
  strict: Locator,
  options: { structuralFallback?: Locator; mutationTolerant?: boolean } = {}
): Promise<void> {
  if (!options.mutationTolerant) {
    await expect(strict).toBeVisible({ timeout: 30_000 });
    return;
  }
  try {
    await expect(strict).toBeVisible({ timeout: 10_000 });
  } catch {
    const fallback = options.structuralFallback ?? page.locator("#main-content, main").first();
    await expect(fallback).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2000);
  }
}

/**
 * Settle the page for deterministic capture: fixed animation/settle wait, then
 * poll until every aria-live / role=status region's text stops changing. The
 * global "Realtime connection status" region transitions ("connecting" ->
 * "All realtime connections active") during load; captured mid-transition it
 * destabilizes both evidence probes and spoken-phrase logs between runs. We
 * wait for two consecutive identical samples (bounded), so every run captures
 * the same steady state.
 */
export async function settlePage(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS);
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll("[role='status'],[aria-live]"))
          .map((el) => (el.textContent || "").toLowerCase())
          .join(" ")
          .includes("all realtime connections active"),
      undefined,
      { timeout: 20_000 }
    )
    .catch(() => {});
  let prev: string | null = null;
  for (let i = 0; i < 24; i++) {
    const cur = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[role='status'],[aria-live],[role='log']"))
        .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
        .join("|")
    );
    if (cur === prev) return;
    prev = cur;
    await page.waitForTimeout(500);
  }
}
