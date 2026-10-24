/**
 * WCAG 4.1.2 Name, Role, Value — PLANTS A FAILURE.
 *
 * Strips `aria-label` / `aria-labelledby` from icon-only buttons (buttons whose
 * trimmed innerText is empty). Those controls then expose no accessible name,
 * which is a 4.1.2 failure (name/role/value not programmatically determinable).
 * Runs on DOMContentLoaded and on a repeating interval so React-mounted toolbar
 * buttons that appear later are also stripped.
 */
import type { Mutation } from "./types";

const mutation412: Mutation = {
  id: "412-strip-labels",
  criterion: "4.1.2",
  description: "Removes aria-label/aria-labelledby from icon-only buttons so they have no accessible name.",
  expected: "fail",
  async apply(page) {
    await page.addInitScript(() => {
      const strip = (): void => {
        document.querySelectorAll("button, [role='button']").forEach((node) => {
          const el = node as HTMLElement;
          if ((el.innerText || "").trim() === "") {
            el.removeAttribute("aria-label");
            el.removeAttribute("aria-labelledby");
          }
        });
      };
      const start = (): void => {
        strip();
        // Late-mounted controls (menus, toolbars) — re-strip periodically.
        window.setInterval(strip, 400);
        const observer = new MutationObserver(() => strip());
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

export default mutation412;
