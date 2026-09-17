/**
 * WCAG 1.3.1 Info and Relationships — PLANTS A FAILURE.
 *
 * Collapses every <SpokenValue> pair back to its compact visual form: deletes
 * the screen-reader-only phrasing and un-hides the terse notation beside it.
 * The information survives on screen but the relationship a screen reader
 * needs to interpret it does not — "45 of 100 points" becomes "45/100",
 * voiced as "45 slash 100".
 *
 * This is the defect from issue #915 reproduced structurally, and it is the
 * paired mutation for the gradebook__gradebook-assignment replay spec: that
 * spec needles the spoken phrase, so it must go red under this mutation.
 * Interval- and observer-driven because the gradebook cell re-renders on
 * realtime refetches.
 */
import type { Mutation } from "./types";

const mutation131: Mutation = {
  id: "131-spoken-value-collapse",
  criterion: "1.3.1",
  description: "Removes SpokenValue's screen-reader phrasing and un-hides the compact notation beside it.",
  expected: "fail",
  async apply(page) {
    await page.addInitScript(() => {
      const collapse = (): void => {
        // A SpokenValue renders <VisuallyHidden>{spoken}</VisuallyHidden>
        // followed by <span aria-hidden="true">{children}</span>. Chakra's
        // VisuallyHidden is a clip-rect span, so match on the pairing rather
        // than on a class name.
        document.querySelectorAll('span[aria-hidden="true"]').forEach((visual) => {
          const spoken = visual.previousElementSibling;
          if (!(spoken instanceof HTMLElement)) return;
          const style = window.getComputedStyle(spoken);
          const isClipped =
            style.position === "absolute" &&
            (style.clip !== "auto" || style.clipPath !== "none" || style.width === "1px");
          if (!isClipped) return;
          spoken.remove();
          visual.removeAttribute("aria-hidden");
        });
      };
      const start = (): void => {
        collapse();
        window.setInterval(collapse, 400);
        new MutationObserver(() => collapse()).observe(document.documentElement, { childList: true, subtree: true });
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
      } else {
        start();
      }
    });
  }
};

export default mutation131;
