/**
 * Numbered focus-badge overlay for labeled screenshots (used by the 2.4.3
 * full-page screenshot).
 *
 * `withFocusBadges(page, stops, fn)` overlays a high-contrast numbered badge at
 * each stop's coordinates, runs `fn()` (the caller screenshots inside it), then
 * removes the badges in a `finally`. Each badge carries a `data-a11y-focus-badge`
 * attribute so cleanup is a single querySelectorAll sweep even if `fn` throws.
 *
 * COORDINATE CAVEAT: stop coordinates come from `getBoundingClientRect()`
 * captured during the tab walk, i.e. viewport-relative at whatever scroll
 * position each element was focused at. Before overlaying we scroll to the top
 * and place badges at `x + scrollX / y + scrollY` (document coordinates). Badges
 * for above-the-fold stops land exactly; badges for elements that were scrolled
 * into view during the walk are approximate. The authoritative ordering lives in
 * the tab-order JSON probe — the badges are a visual aid only.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` types.
 */
import type { Page } from "@playwright/test";

const BADGE_ATTR = "data-a11y-focus-badge";

export interface BadgeStop {
  n: number;
  x: number;
  y: number;
}

export async function withFocusBadges<T>(
  page: Page,
  stops: ReadonlyArray<BadgeStop>,
  fn: () => Promise<T>
): Promise<T> {
  const serializable = stops.map((s) => ({ n: s.n, x: s.x, y: s.y }));
  try {
    await page.evaluate(
      ({ stops, attr }) => {
        window.scrollTo(0, 0);
        for (const s of stops) {
          if (typeof s.x !== "number" || typeof s.y !== "number") continue;
          if (s.x <= 0 && s.y <= 0) continue; // skip body / off-screen sentinels
          const badge = document.createElement("div");
          badge.setAttribute(attr, "");
          badge.textContent = String(s.n);
          const style = badge.style;
          style.position = "absolute";
          style.left = `${Math.max(0, Math.round(s.x + window.scrollX))}px`;
          style.top = `${Math.max(0, Math.round(s.y + window.scrollY))}px`;
          style.zIndex = "2147483647";
          style.background = "#c8102e";
          style.color = "#ffffff";
          style.font = "bold 12px/16px monospace";
          style.padding = "0 4px";
          style.minWidth = "16px";
          style.height = "16px";
          style.textAlign = "center";
          style.border = "1px solid #ffffff";
          style.borderRadius = "0";
          style.pointerEvents = "none";
          style.boxShadow = "0 0 0 1px #000000";
          document.body.appendChild(badge);
        }
      },
      { stops: serializable, attr: BADGE_ATTR }
    );
    return await fn();
  } finally {
    await page
      .evaluate((attr) => {
        document.querySelectorAll(`[${attr}]`).forEach((el) => el.remove());
      }, BADGE_ATTR)
      .catch(() => {});
  }
}
