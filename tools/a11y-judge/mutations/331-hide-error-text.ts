/**
 * WCAG 3.3.1 Error Identification — PLANTS A FAILURE.
 *
 * Leaves the VISUAL error styling intact (e.g. red input borders) but removes
 * the programmatic + textual error identification: strips `aria-describedby`
 * (which links a field to its error message) and empties the text content of
 * `role="alert"` containers. Users perceiving the color cue still see "something
 * is wrong", but the error is neither described in text nor conveyed to
 * assistive technology — a 3.3.1 failure (error not identified in text). A
 * MutationObserver re-applies this as validation messages mount/re-render.
 */
import type { Mutation } from "./types";

const mutation331: Mutation = {
  id: "331-hide-error-text",
  criterion: "3.3.1",
  description:
    "Strips aria-describedby and empties role=alert text while leaving visual error styling, so errors are visible but never identified in text/AT.",
  expected: "fail",
  async apply(page) {
    await page.addInitScript(() => {
      const scrub = (): void => {
        // Break the field -> error-message association.
        document.querySelectorAll("[aria-describedby]").forEach((el) => el.removeAttribute("aria-describedby"));
        // Empty alert text (only when non-empty, so the observer settles).
        document.querySelectorAll("[role='alert']").forEach((el) => {
          if ((el.textContent || "").trim() !== "") el.textContent = "";
        });
      };
      const start = (): void => {
        scrub();
        const observer = new MutationObserver(() => scrub());
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-describedby", "role"],
          characterData: true
        });
      };
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
      } else {
        start();
      }
    });
  }
};

export default mutation331;
