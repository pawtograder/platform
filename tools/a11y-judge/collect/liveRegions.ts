/**
 * WCAG 4.1.3 (Status Messages) collector.
 *
 * `installLiveRegionRecorder` MUST be called BEFORE navigation: it uses
 * `page.addInitScript` to install (in every fresh document) a MutationObserver
 * over the document root that records every mutation touching an aria-live
 * region — `[aria-live]`, `[role=status]`, `[role=alert]`, `[role=log]` —
 * including regions added to the DOM after load. Each event is pushed to
 * `window.__a11yLiveRegionLog` as:
 *   { t, kind: "added"|"text-changed"|"removed", politeness, role, snippet, regionPath }
 * where `t` is ms since the recorder installed in that document.
 *
 * `collectLiveRegionLog` reads the log back out after the interaction of
 * interest (e.g. survey autosave) has run.
 *
 * It ALSO independently records text appearing in visually-toast-like
 * containers (`window.__a11yVisibleStatusLog`) with NO dependence on aria
 * attributes — so "a status became visible but was never announced" is
 * provable even when the live-region markup is missing or stripped. Transient
 * toasts vanish before an after-interaction screenshot; this log is the
 * durable record that visible status text existed.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` types.
 */
import type { Page } from "@playwright/test";

export interface LiveRegionEvent {
  /** ms since the recorder installed in the current document. */
  t: number;
  kind: "added" | "text-changed" | "removed";
  /** Resolved politeness: aria-live value, or derived from role. */
  politeness: string;
  role: string | null;
  /** Text snippet of the mutated content, <= 160 chars. */
  snippet: string;
  /** Compact path identifying the live region. */
  regionPath: string;
}

export interface VisibleStatusEvent {
  /** ms since the recorder installed in the current document. */
  t: number;
  /** Non-empty visible text that appeared in a toast-like container. */
  text: string;
  containerPath: string;
  /** Whether the container (or an ancestor) carried live-region markup at that moment. */
  hadLiveMarkup: boolean;
}

export async function installLiveRegionRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const SELECTOR = "[aria-live],[role='status'],[role='alert'],[role='log']";
    // Visually-toast-like containers, matched WITHOUT any aria dependence.
    const VISIBLE_STATUS_SELECTOR =
      "[id^='toast'],[id*='toast-group'],[class*='toast'],[class*='snackbar'],[data-sonner-toast],[data-part='toast'],[data-scope='toast']";
    const START = Date.now();
    const log: Array<{
      t: number;
      kind: "added" | "text-changed" | "removed";
      politeness: string;
      role: string | null;
      snippet: string;
      regionPath: string;
    }> = [];
    const visibleLog: Array<{ t: number; text: string; containerPath: string; hadLiveMarkup: boolean }> = [];
    // Expose on window for later readout.
    (window as unknown as { __a11yLiveRegionLog: typeof log }).__a11yLiveRegionLog = log;
    (window as unknown as { __a11yVisibleStatusLog: typeof visibleLog }).__a11yVisibleStatusLog = visibleLog;

    const snippet = (text: string | null | undefined): string => (text || "").replace(/\s+/g, " ").trim().slice(0, 160);

    const politenessOf = (el: Element): string => {
      const live = el.getAttribute("aria-live");
      if (live) return live;
      const role = el.getAttribute("role");
      if (role === "alert") return "assertive";
      if (role === "status" || role === "log") return "polite";
      return "off";
    };

    const regionPath = (el: Element): string => {
      const parts: string[] = [];
      let cur: Element | null = el;
      let depth = 0;
      while (cur && cur !== document.body && depth < 4) {
        const tag = cur.tagName.toLowerCase();
        const role = cur.getAttribute("role");
        const label = cur.getAttribute("aria-label");
        const id = cur.id;
        let seg = tag;
        if (id) seg += `#${id}`;
        if (role) seg += `[role=${role}]`;
        if (label) seg += `[label=${label.slice(0, 40)}]`;
        parts.unshift(seg);
        cur = cur.parentElement;
        depth++;
      }
      return parts.join(">");
    };

    const isRegion = (node: Node): node is Element =>
      node.nodeType === 1 && (node as Element).matches != null && (node as Element).matches(SELECTOR);

    const closestRegion = (node: Node): Element | null => {
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
      return el ? el.closest(SELECTOR) : null;
    };

    const push = (kind: "added" | "text-changed" | "removed", region: Element, text: string | null | undefined) => {
      log.push({
        t: Date.now() - START,
        kind,
        politeness: politenessOf(region),
        role: region.getAttribute("role"),
        snippet: snippet(text),
        regionPath: regionPath(region)
      });
    };

    // Dedupe visible-status entries: one per (container, text).
    const seenVisible = new Set<string>();
    const pushVisible = (node: Node) => {
      const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
      if (!el || el.closest == null) return;
      const container = el.closest(VISIBLE_STATUS_SELECTOR);
      if (!container) return;
      const text = snippet(container.textContent);
      if (!text) return;
      const key = `${regionPath(container)}|${text}`;
      if (seenVisible.has(key)) return;
      seenVisible.add(key);
      visibleLog.push({
        t: Date.now() - START,
        text,
        containerPath: regionPath(container),
        hadLiveMarkup: container.closest(SELECTOR) != null
      });
    };

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "childList") m.addedNodes.forEach(pushVisible);
        else if (m.type === "characterData") pushVisible(m.target);
        if (m.type === "childList") {
          m.addedNodes.forEach((n) => {
            if (isRegion(n)) {
              push("added", n, n.textContent);
            } else {
              const region = closestRegion(n);
              if (region) push("text-changed", region, n.textContent);
            }
          });
          m.removedNodes.forEach((n) => {
            if (isRegion(n)) {
              push("removed", n, n.textContent);
            } else {
              const region = closestRegion(m.target);
              if (region) push("text-changed", region, region.textContent);
            }
          });
        } else if (m.type === "characterData") {
          const region = closestRegion(m.target);
          if (region) push("text-changed", region, m.target.textContent);
        }
      }
    });

    const start = () => {
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["aria-live", "role"]
      });
    };

    if (document.documentElement) {
      start();
    } else {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    }
  });
}

export async function collectLiveRegionLog(
  page: Page
): Promise<{ events: LiveRegionEvent[]; visibleStatusEvents: VisibleStatusEvent[] }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __a11yLiveRegionLog?: LiveRegionEventShape[];
      __a11yVisibleStatusLog?: VisibleStatusEventShape[];
    };
    interface LiveRegionEventShape {
      t: number;
      kind: "added" | "text-changed" | "removed";
      politeness: string;
      role: string | null;
      snippet: string;
      regionPath: string;
    }
    interface VisibleStatusEventShape {
      t: number;
      text: string;
      containerPath: string;
      hadLiveMarkup: boolean;
    }
    return { events: w.__a11yLiveRegionLog ?? [], visibleStatusEvents: w.__a11yVisibleStatusLog ?? [] };
  });
}
