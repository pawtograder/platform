/**
 * WCAG 2.4.3 tab-order collector — promoted from the audit spec's
 * `walkTabOrder()` (tests/e2e/a11y-focus-audit.spec.ts). Pure data return: it
 * presses Tab up to `maxStops` times and reports each focused element's
 * identity, coordinates, landmark-container path, and DOM-order relationship to
 * the previous stop. NO filesystem writes and NO assertions — the caller feeds
 * the result to EvidenceBundleWriter.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` types + the local schema.
 *
 * Technique preserved from the original:
 *   - a `data-e2e-audit-prev` stamp marks the previous stop so `followsPrevious`
 *     can be computed in-page via `compareDocumentPosition` (immune to realtime
 *     DOM churn between stops);
 *   - a landmark-container path is built by walking ancestors;
 *   - the walk stops after two consecutive body hits (fully wrapped around);
 *   - the stamp is always cleaned up in a `finally`.
 */
import type { Page } from "@playwright/test";
import type { AuditStop } from "../schema/evidence";

const STAMP = "data-e2e-audit-prev";

export interface TabOrderProbeData {
  stops: AuditStop[];
  /** True when the walk saw two consecutive body hits (wrapped fully around). */
  wrappedAround: boolean;
  /** True when the walk hit `maxStops` without wrapping around. */
  truncated: boolean;
}

export async function collectTabOrder(page: Page, opts: { maxStops: number }): Promise<TabOrderProbeData> {
  const { maxStops } = opts;

  // Reset to a known start. blur() clears activeElement but NOT the browser's
  // sequential-focus-navigation starting point — Tab resumes after wherever
  // focus last was. The focus-indicator collector runs right before this one
  // and leaves that point mid-page, so the walk started mid-document and the
  // rotation read as a tabindex scramble (seen live: assignments-table links
  // at stops 1-4 AND revisited later → judge false-positived 2.4.3 while the
  // real tab order was correct). Anchor the starting point at the top of
  // <body> via a transient tabindex="-1" node, and verify body holds focus.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.evaluate((stamp) => {
      document.querySelectorAll(`[${stamp}], [${stamp}-visited]`).forEach((el) => {
        el.removeAttribute(stamp);
        el.removeAttribute(`${stamp}-visited`);
      });
      document.getElementById(`${stamp}-anchor`)?.remove();
      // Focused, non-tabbable, invisible anchor as body's first child: the
      // sequential-focus starting point sits at the document top, so the
      // first Tab reaches the first tabbable. Removed in the finally below.
      const anchor = document.createElement("span");
      anchor.id = `${stamp}-anchor`;
      anchor.setAttribute("tabindex", "-1");
      anchor.setAttribute("aria-hidden", "true");
      document.body.prepend(anchor);
      anchor.focus();
    }, STAMP);
    await page.waitForTimeout(300);
    const anchored = await page.evaluate((stamp) => document.activeElement?.id === `${stamp}-anchor`, STAMP);
    if (anchored) break;
  }

  const stops: AuditStop[] = [];
  let bodyHits = 0;
  let wrappedAround = false;
  try {
    for (let i = 0; i < maxStops; i++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate<Omit<AuditStop, "n">, string>((stamp) => {
        const el = document.activeElement as HTMLElement | null;
        const prev = document.querySelector(`[${stamp}]`);
        if (!el || el === document.body) {
          return {
            tag: "body",
            id: null,
            role: null,
            ariaLabel: null,
            name: "",
            testId: null,
            href: null,
            container: "",
            x: 0,
            y: 0,
            w: 0,
            h: 0,
            visible: false,
            followsPrevious: null
          };
        }
        const followsPrevious =
          prev && prev !== el ? Boolean(prev.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
        prev?.removeAttribute(stamp);
        // Persistently mark visited elements: landing on one again is recorded
        // as `revisited` so the judge can tell wrap-around/duplication apart
        // from a genuine positive-tabindex reorder.
        const revisited = el.hasAttribute(`${stamp}-visited`);
        el.setAttribute(stamp, "");
        el.setAttribute(`${stamp}-visited`, "");

        const r = el.getBoundingClientRect();
        const landmarks: string[] = [];
        for (let cur: HTMLElement | null = el; cur && cur !== document.body; cur = cur.parentElement) {
          const tag = cur.tagName.toLowerCase();
          const role = cur.getAttribute("role");
          const dl = cur.getAttribute("data-landmark");
          const dt = cur.getAttribute("data-testid");
          if (dl) landmarks.push(`[landmark=${dl}]`);
          else if (dt && landmarks.length < 3) landmarks.push(`[testid=${dt}]`);
          else if (
            role &&
            ["dialog", "tablist", "tabpanel", "menu", "navigation", "banner", "main", "region", "table"].includes(role)
          )
            landmarks.push(
              `[role=${role}${cur.getAttribute("aria-label") ? `:${cur.getAttribute("aria-label")}` : ""}]`
            );
          else if (["nav", "main", "header", "footer", "aside", "table", "form"].includes(tag))
            landmarks.push(`<${tag}>`);
          if (landmarks.length >= 4) break;
        }
        const cs = window.getComputedStyle(el);
        const visible = r.width > 1 && r.height > 1 && cs.visibility !== "hidden" && cs.display !== "none";
        const label =
          el.getAttribute("aria-label") ??
          (el.getAttribute("aria-labelledby")
            ? (el.getAttribute("aria-labelledby") || "")
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.innerText ?? "")
                .join(" ")
                .trim()
            : null);
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          role: el.getAttribute("role"),
          ariaLabel: label,
          name: ((el as HTMLElement).innerText ?? (el as HTMLInputElement).value ?? "").trim().slice(0, 70),
          testId: el.getAttribute("data-testid"),
          href: el.getAttribute("href"),
          container: landmarks.reverse().join(" > "),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          visible,
          followsPrevious,
          revisited
        };
      }, STAMP);
      stops.push({ n: i + 1, ...stop });
      if (stop.tag === "body") {
        bodyHits++;
        if (bodyHits >= 2) {
          wrappedAround = true;
          break; // wrapped fully around
        }
      }
    }
  } finally {
    await page
      .evaluate((stamp) => {
        document.getElementById(`${stamp}-anchor`)?.remove();
        document.querySelectorAll(`[${stamp}], [${stamp}-visited]`).forEach((el) => {
          el.removeAttribute(stamp);
          el.removeAttribute(`${stamp}-visited`);
        });
      }, STAMP)
      .catch(() => {});
  }

  return { stops, wrappedAround, truncated: !wrappedAround && stops.length >= maxStops };
}
