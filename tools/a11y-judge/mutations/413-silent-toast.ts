/**
 * WCAG 4.1.3 Status Messages — PLANTS A FAILURE.
 *
 * Strips the live-region plumbing (`aria-live`, `role="status"`, `role="alert"`,
 * `role="log"`) from any element that gains it. Toasts and status text still
 * appear on screen, but they are never announced to assistive technology — the
 * 4.1.3 failure (status messages not programmatically presented via role/props
 * without receiving focus). A MutationObserver watches for both new nodes and
 * attribute changes so dynamically-created toasts are neutralized the instant
 * they get their live-region attributes.
 */
import type { Mutation } from "./types";

const mutation413: Mutation = {
  id: "413-silent-toast",
  criterion: "4.1.3",
  description:
    "Strips aria-live and role=status/alert/log from any element that gains them, so visible status changes are never announced.",
  expected: "fail",
  async apply(page) {
    await page.addInitScript(() => {
      const LIVE_ROLES = ["status", "alert", "log"];
      const clean = (node: Element): void => {
        if (node.hasAttribute("aria-live")) node.removeAttribute("aria-live");
        const role = node.getAttribute("role");
        if (role && LIVE_ROLES.includes(role)) node.removeAttribute("role");
      };
      const scan = (root: ParentNode): void => {
        if (root instanceof Element) clean(root);
        root.querySelectorAll("[aria-live], [role='status'], [role='alert'], [role='log']").forEach(clean);
      };
      const start = (): void => {
        scan(document);
        const observer = new MutationObserver((records) => {
          for (const record of records) {
            if (record.type === "attributes" && record.target instanceof Element) {
              clean(record.target);
            }
            record.addedNodes.forEach((added) => {
              if (added instanceof Element) scan(added);
            });
          }
        });
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-live", "role"]
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

export default mutation413;
