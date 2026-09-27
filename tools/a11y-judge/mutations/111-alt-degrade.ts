/**
 * WCAG 1.1.1 Non-text Content — PLANTS A FAILURE.
 *
 * Degrades every image's text alternative to a generic, uninformative value:
 * `img[alt]` becomes `alt="image"`, and every `<svg>` title / `aria-label`
 * becomes "icon". The alternative text is present but non-equivalent, which is a
 * 1.1.1 quality failure (the text alternative does not serve the equivalent
 * purpose). Runs on load and on an interval to catch lazily-rendered images.
 */
import type { Mutation } from "./types";

const mutation111: Mutation = {
  id: "111-alt-degrade",
  criterion: "1.1.1",
  description: "Rewrites every img alt to 'image' and svg title/aria-label to 'icon' (generic, non-equivalent text).",
  expected: "fail",
  async apply(page) {
    await page.addInitScript(() => {
      const degrade = (): void => {
        document.querySelectorAll("img[alt]").forEach((img) => {
          if (img.getAttribute("alt") !== "image") img.setAttribute("alt", "image");
        });
        document.querySelectorAll("svg").forEach((svg) => {
          if (svg.hasAttribute("aria-label") && svg.getAttribute("aria-label") !== "icon") {
            svg.setAttribute("aria-label", "icon");
          }
          const title = svg.querySelector("title");
          if (title && title.textContent !== "icon") title.textContent = "icon";
        });
      };
      const start = (): void => {
        degrade();
        window.setInterval(degrade, 400);
        const observer = new MutationObserver(() => degrade());
        observer.observe(document.documentElement, { childList: true, subtree: true });
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
      } else {
        start();
      }
    });
  }
};

export default mutation111;
