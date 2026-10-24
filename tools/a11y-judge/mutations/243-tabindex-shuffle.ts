/**
 * WCAG 2.4.3 Focus Order — PLANTS A FAILURE.
 *
 * Assigns positive `tabindex` values (1..n) to the first ~12 focusable elements
 * in REVERSED document order: the element that appears last in the DOM gets
 * `tabindex="1"`, so keyboard focus jumps to it first and then walks backwards
 * relative to the visual/DOM order. Positive tabindex reordering that diverges
 * from a meaningful reading order is a 2.4.3 focus-order failure.
 */
import type { Mutation } from "./types";

const MAX_ELEMENTS = 12;

const mutation243: Mutation = {
  id: "243-tabindex-shuffle",
  criterion: "2.4.3",
  description: "Assigns positive tabindex 1..n to the first ~12 focusables in reversed DOM order, reversing tab order.",
  expected: "fail",
  async apply(page) {
    await page.addInitScript((maxElements: number) => {
      const FLAG = "__a11yMut243Applied";
      const shuffle = (): void => {
        const win = window as unknown as Record<string, boolean>;
        if (win[FLAG]) return; // idempotent — apply the shuffle once
        const selector = "a[href], button, input, select, textarea, [tabindex]";
        const focusable = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => {
          const rect = el.getBoundingClientRect();
          const cs = window.getComputedStyle(el);
          return rect.width > 1 && rect.height > 1 && cs.visibility !== "hidden" && cs.display !== "none";
        });
        const firstN = focusable.slice(0, maxElements);
        if (firstN.length === 0) return;
        // Reverse: last-in-DOM gets tabindex 1, first-in-DOM gets the highest.
        firstN
          .slice()
          .reverse()
          .forEach((el, i) => el.setAttribute("tabindex", String(i + 1)));
        win[FLAG] = true;
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", shuffle);
      } else {
        shuffle();
      }
    }, MAX_ELEMENTS);
  }
};

export default mutation243;
