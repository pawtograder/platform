/**
 * WCAG 2.4.7 focus-indicator collector.
 *
 * CRITICAL GOTCHA (do not re-introduce blur/refocus style-diffing):
 * Zag/Chakra (the Switch, and other Ark/Zag-driven controls) set
 * `data-focus-visible` via an ASYNC React re-render. A probe that snapshots
 * computed style, calls `el.blur()`, snapshots again, and diffs will therefore
 * FALSE-NEGATIVE on any attribute-driven focus style: at blur time React has
 * not yet committed the attribute removal, so the "focused" and "blurred"
 * snapshots look identical and the probe wrongly reports "no focus indicator".
 *
 * The correct pattern (from the "focus visibility probe: rubric descriptions
 * switch" test in tests/e2e/a11y-focus-audit.spec.ts, ~lines 439-490): measure
 * computed style WHILE keyboard focus is live and NEVER blur. We press Tab,
 * wait a beat for React to commit `data-focus-visible`, then read the active
 * element's (and its closest `[data-part="control"]`/label wrapper's, when
 * present) computed outline/box-shadow/border-color + the attribute + rect, and
 * screenshot a clipped crop of the element while it is still focused.
 *
 * To give the judge a "blurred reference without ever blurring", we capture ONE
 * pristine full-page screenshot BEFORE any Tab press. The caller pairs each
 * live-focused crop with the SAME rect cropped out of that pristine shot.
 *
 * EXTRACTABLE CORE: imports only `@playwright/test` types + the local schema.
 */
import type { Page } from "@playwright/test";
import type { Rect } from "../schema/evidence";

/** ~24px of breathing room around the focused element in its crop. */
const CROP_PAD = 24;

export interface FocusIndicatorStopData {
  n: number;
  tag: string;
  role: string | null;
  name: string;
  testId: string | null;
  outline: string;
  boxShadow: string;
  borderColor: string;
  focusVisibleAttr: boolean;
  /** Viewport-relative, as `page.screenshot({ clip })` expects. */
  rect: Rect;
  /**
   * The same rect in DOCUMENT coordinates (rect + scroll offset at measure
   * time). The Tab walk scrolls each stop into view, so the caller must use
   * this — not `rect` — to cut the reference crop out of the full-page pristine
   * screenshot, which is itself in document coordinates. (Position-fixed
   * elements are the known exception: Chromium renders them once at scroll 0 in
   * a full-page capture, so their reference crop can still be off.)
   */
  documentRect: Rect;
  /** Clipped screenshot of the element (+padding) captured WHILE focus is live. */
  focusedCrop: Buffer;
}

export interface FocusIndicatorResult {
  stops: FocusIndicatorStopData[];
  /** Full-page screenshot taken before any Tab press (the blurred reference). */
  pristineFullPage: Buffer;
}

type LiveMeasurement = {
  tag: string;
  role: string | null;
  name: string;
  testId: string | null;
  outline: string;
  boxShadow: string;
  borderColor: string;
  focusVisibleAttr: boolean;
  rect: Rect;
  scrollX: number;
  scrollY: number;
  isBody: boolean;
};

/**
 * Collect per-stop live-focus indicator evidence.
 *
 * DEVIATION from the prompt's stated `Promise<FocusIndicatorStop[]>`: this
 * returns `{ stops, pristineFullPage }` because the pristine pre-tab screenshot
 * must also be returned (the caller needs it to cut the reference crops), and a
 * bare array cannot carry it. The per-stop shape is otherwise as specified.
 */
export async function collectFocusIndicators(
  page: Page,
  opts: { maxStops: number; settleMs?: number }
): Promise<FocusIndicatorResult> {
  const { maxStops } = opts;
  const settleMs = opts.settleMs ?? 200;

  // Pristine reference BEFORE any Tab press — nothing is focused yet.
  const pristineFullPage = await page.screenshot({ fullPage: true });

  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.body.focus();
  });

  const viewport = page.viewportSize();
  const vpWidth = viewport?.width ?? 1280;
  const vpHeight = viewport?.height ?? 720;

  const stops: FocusIndicatorStopData[] = [];
  for (let i = 0; i < maxStops; i++) {
    await page.keyboard.press("Tab");
    // Let React commit data-focus-visible before we read computed style.
    await page.waitForTimeout(settleMs);

    const measurement = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) {
        return { isBody: true } as { isBody: true };
      }
      // Prefer the Zag/Ark control wrapper (or a label wrapper) when present:
      // that is where attribute-driven focus styles land.
      const measured =
        (el.closest('[data-part="control"]') as HTMLElement | null) ??
        (el.closest("label") as HTMLElement | null) ??
        el;
      const cs = getComputedStyle(measured);
      const r = measured.getBoundingClientRect();
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
        isBody: false,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        name: (label ?? (el as HTMLElement).innerText ?? (el as HTMLInputElement).value ?? "").trim().slice(0, 70),
        testId: el.getAttribute("data-testid"),
        outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor} offset=${cs.outlineOffset}`,
        boxShadow: cs.boxShadow,
        borderColor: cs.borderColor,
        focusVisibleAttr: measured.hasAttribute("data-focus-visible"),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        scrollX: window.scrollX,
        scrollY: window.scrollY
      } as LiveMeasurement;
    });

    if (measurement.isBody) break; // reached / wrapped to body — end of order

    const m = measurement as LiveMeasurement;
    let focusedCrop: Buffer = Buffer.alloc(0);
    if (m.rect.w > 2 && m.rect.h > 2) {
      const clip = {
        x: Math.max(0, m.rect.x - CROP_PAD),
        y: Math.max(0, m.rect.y - CROP_PAD),
        width: Math.min(m.rect.w + CROP_PAD * 2, vpWidth - Math.max(0, m.rect.x - CROP_PAD)),
        height: Math.min(m.rect.h + CROP_PAD * 2, vpHeight - Math.max(0, m.rect.y - CROP_PAD))
      };
      if (clip.width > 0 && clip.height > 0) {
        focusedCrop = await page.screenshot({ clip }).catch(() => Buffer.alloc(0));
      }
    }

    stops.push({
      n: i + 1,
      tag: m.tag,
      role: m.role,
      name: m.name,
      testId: m.testId,
      outline: m.outline,
      boxShadow: m.boxShadow,
      borderColor: m.borderColor,
      focusVisibleAttr: m.focusVisibleAttr,
      rect: m.rect,
      documentRect: { x: m.rect.x + m.scrollX, y: m.rect.y + m.scrollY, w: m.rect.w, h: m.rect.h },
      focusedCrop
    });
  }

  return { stops, pristineFullPage };
}
