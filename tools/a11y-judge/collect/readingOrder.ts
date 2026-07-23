/**
 * WCAG 1.3.2 (Meaningful Sequence) + 2.4.6 (Headings and Labels) collector.
 *
 * Produces two views of the page's reading order for the judge:
 *   1. `textWalk` — a DOM-order serialization of the visible text, one entry per
 *      visible text node, annotated with the nearest heading level, the parent
 *      element's role, and whether the text sits inside a listitem / label.
 *      Each entry's text is truncated to ~120 chars and the whole walk is capped
 *      at ~400 entries so the probe stays bounded.
 *   2. `ariaSnapshot` — Playwright's `locator.ariaSnapshot()` of `body`, which
 *      is the closest deterministic proxy we have for the screen-reader reading
 *      order (accessibility-tree order, not raw DOM order).
 *
 * Both are returned so the caller can emit them as two `raw-json` probes.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` types + node builtins here
 * (nothing beyond the Page type is used). No filesystem writes, no assertions.
 */
import type { Page } from "@playwright/test";

/** Max text length kept per entry. */
const MAX_ENTRY_CHARS = 120;
/** Max number of text entries kept in the walk. */
const MAX_ENTRIES = 400;

export interface ReadingOrderEntry {
  /** DOM-order index of this entry (0-based). */
  order: number;
  /** Tag name of the text node's parent element. */
  tag: string;
  /** Explicit ARIA role of the parent element, if any. */
  role: string | null;
  /** Heading level (1-6) if this text is inside a heading, else null. */
  headingLevel: number | null;
  /** True when the text is inside an <li> or role=listitem. */
  inListItem: boolean;
  /** True when the text is inside a <label> or role=label. */
  inLabel: boolean;
  /** Truncated, whitespace-collapsed text content. */
  text: string;
}

export interface ReadingOrderData {
  textWalk: {
    entries: ReadingOrderEntry[];
    /** True when the walk hit MAX_ENTRIES before exhausting the DOM. */
    truncated: boolean;
  };
  /** Playwright `body` ariaSnapshot (accessibility-tree reading order proxy). */
  ariaSnapshot: string;
}

export async function collectReadingOrder(page: Page): Promise<ReadingOrderData> {
  const textWalk = await page.evaluate(
    ({ maxEntries, maxChars }) => {
      const entries: Array<{
        order: number;
        tag: string;
        role: string | null;
        headingLevel: number | null;
        inListItem: boolean;
        inLabel: boolean;
        text: string;
      }> = [];

      const isVisible = (el: Element): boolean => {
        const cs = window.getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        if (parseFloat(cs.opacity || "1") === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      const headingLevelOf = (el: Element): number | null => {
        const heading = el.closest("h1,h2,h3,h4,h5,h6,[role='heading']");
        if (!heading) return null;
        const m = heading.tagName.match(/^H([1-6])$/);
        if (m) return Number(m[1]);
        const aria = heading.getAttribute("aria-level");
        return aria ? Number(aria) || null : null;
      };

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node: Node): number {
          const value = node.nodeValue ? node.nodeValue.trim() : "";
          if (!value) return NodeFilter.FILTER_REJECT;
          const parent = (node as Text).parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          const tag = parent.tagName.toLowerCase();
          if (tag === "script" || tag === "style" || tag === "noscript") return NodeFilter.FILTER_REJECT;
          if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      let truncated = false;
      let current: Node | null;
      while ((current = walker.nextNode()) !== null) {
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        const parent = (current as Text).parentElement;
        if (!parent) continue;
        const text = (current.nodeValue || "").replace(/\s+/g, " ").trim().slice(0, maxChars);
        entries.push({
          order: entries.length,
          tag: parent.tagName.toLowerCase(),
          role: parent.getAttribute("role"),
          headingLevel: headingLevelOf(parent),
          inListItem: Boolean(parent.closest("li,[role='listitem']")),
          inLabel: Boolean(parent.closest("label,[role='label']")),
          text
        });
      }
      return { entries, truncated };
    },
    { maxEntries: MAX_ENTRIES, maxChars: MAX_ENTRY_CHARS }
  );

  // Playwright 1.54.1 exposes ariaSnapshot on Locator; body gives whole-page
  // accessibility-tree order. Guard against pages that fail to snapshot.
  let ariaSnapshot = "";
  try {
    ariaSnapshot = await page.locator("body").ariaSnapshot();
  } catch {
    ariaSnapshot = "";
  }

  return { textWalk, ariaSnapshot };
}
