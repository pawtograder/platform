/**
 * WCAG 2.4.6 Headings and Labels — PLANTS A FAILURE.
 *
 * Rewrites the text of every heading (h1–h6) to the generic word "Section".
 * The heading structure survives, but the labels no longer describe the topic
 * or purpose of the content they head — a 2.4.6 failure (headings not
 * descriptive). Runs on load and on an interval so re-rendered headings are
 * re-genericized.
 */
import type { Mutation } from "./types";

const mutation246: Mutation = {
  id: "246-headings-generic",
  criterion: "2.4.6",
  description: "Rewrites all h1–h6 text to the generic 'Section', removing descriptive headings.",
  expected: "fail",
  async apply(page) {
    await page.addInitScript(() => {
      const genericize = (): void => {
        document.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((heading) => {
          if (heading.textContent !== "Section") heading.textContent = "Section";
        });
      };
      const start = (): void => {
        genericize();
        window.setInterval(genericize, 400);
        const observer = new MutationObserver(() => genericize());
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

export default mutation246;
