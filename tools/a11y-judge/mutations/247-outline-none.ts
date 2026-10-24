/**
 * WCAG 2.4.7 Focus Visible — PLANTS A FAILURE.
 *
 * Injects a global stylesheet that removes every focus indicator (`outline` and
 * `box-shadow`) on `:focus`, `:focus-visible`, and `[data-focus-visible]`
 * (the Zag/Chakra attribute). Keyboard focus then leaves no visible trace, which
 * is exactly the 2.4.7 failure: a focused element has no visible focus indicator.
 */
import type { Mutation } from "./types";

const mutation247: Mutation = {
  id: "247-outline-none",
  criterion: "2.4.7",
  description: "Removes all focus indicators (outline + box-shadow) so focus is never visible.",
  expected: "fail",
  async apply(page) {
    await page.addInitScript(() => {
      const STYLE_ID = "__a11y-mut-247-outline-none";
      const install = (): void => {
        if (document.getElementById(STYLE_ID)) return; // idempotent
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent =
          "*:focus, *:focus-visible, [data-focus-visible] { outline: none !important; box-shadow: none !important; }";
        (document.head || document.documentElement).appendChild(style);
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", install);
      } else {
        install();
      }
    });
  }
};

export default mutation247;
