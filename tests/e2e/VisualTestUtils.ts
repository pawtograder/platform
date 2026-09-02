import { expect } from "../global-setup";
import { argosScreenshot, type ArgosScreenshotOptions } from "@argos-ci/playwright";
import type { Locator, Page } from "@playwright/test";

type VisualScreenshotOptions = ArgosScreenshotOptions & {
  /**
   * Scroll this rubric sidebar region to the top of its scroll container before
   * capture. Pass "Grading Rubric", "Self-Review Rubric", or the full
   * accessible region label.
   */
  stabilizeRubric?: string | RegExp;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitForFonts(page: Page) {
  await page
    .evaluate(async () => {
      await document.fonts?.ready;
    })
    .catch(() => {
      // Some engines/pages do not expose document.fonts during early failure
      // states. Argos still performs its own stabilization afterwards.
    });
}

async function waitForStableLocator(locator: Locator) {
  let previous: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;

  for (let i = 0; i < 10; i++) {
    const box = await locator.boundingBox();
    if (!box) {
      await locator.page().waitForTimeout(50);
      continue;
    }
    if (
      previous &&
      Math.abs(previous.x - box.x) < 1 &&
      Math.abs(previous.y - box.y) < 1 &&
      Math.abs(previous.width - box.width) < 1 &&
      Math.abs(previous.height - box.height) < 1
    ) {
      return;
    }
    previous = box;
    await locator.page().waitForTimeout(75);
  }
}

export async function waitForVisualIdle(page: Page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {
    // Realtime/websocket-backed pages do not always reach networkidle. The
    // explicit UI readiness assertions below are the stronger signal.
  });
  await waitForFonts(page);

  // Wait for images to finish loading. Avatars (PersonName -> dicebear <img>) in comment
  // threads load asynchronously; when an avatar's intrinsic size lands it nudges the
  // surrounding layout by ~1px, shifting e.g. the regrade comment box between runs. Bounded
  // (5s) and non-fatal so a slow/broken image source can't hang the scan.
  await page
    .waitForFunction(() => Array.from(document.images).every((img) => img.complete), undefined, { timeout: 5_000 })
    .catch(() => {
      /* a slow/broken image — proceed rather than block the capture */
    });

  // Async content (rubric checks, regrade status lines, comment threads — all loaded via
  // realtime/TableControllers) can keep growing the page after networkidle resolves. That
  // shifts the full-page screenshot height AND the vertical position of everything below
  // the still-growing region, so the same screenshot differs run-to-run (observed: ±292px
  // page-height swings and ~1px shifts of the regrade comment box). Wait for the document
  // height to stop changing — three consecutive equal samples — before capturing, with an
  // ~8s cap so a genuinely live page can't hang the scan.
  await page
    .evaluate(
      () =>
        new Promise<void>((resolve) => {
          let last = -1;
          let stable = 0;
          let iterations = 0;
          const check = () => {
            const h = document.documentElement.scrollHeight;
            if (h === last) {
              if (++stable >= 3) return resolve();
            } else {
              stable = 0;
              last = h;
            }
            if (++iterations > 40) return resolve();
            setTimeout(check, 200);
          };
          check();
        })
    )
    .catch(() => {
      /* navigation/context race — proceed without the height-settle wait */
    });

  // Code files (components/ui/code-file.tsx) render plain text first, then re-render
  // with @wooorm/starry-night syntax highlighting once it loads asynchronously.
  // Capturing mid-load is not just a per-glyph color diff: the un-highlighted
  // fallback collapses to one character per line (the line content has no settled
  // width yet), which shifts the whole page and yields ~70% full-page diffs. If any
  // code file on the page is still un-highlighted, wait for it to finish before the
  // screenshot. The timeout is generous (30s) because under the full-suite parallel
  // load several workers import the highlighter at once and a single block can take
  // well over 10s to tokenize — the old 10s cap let that broken state through.
  // Bounded + non-fatal: a file with no tokenizable content still flips the flag to
  // "true", and the catch covers pages without code files / offline highlighter loads.
  const codeFiles = page.locator("[data-syntax-highlighted]");
  if ((await codeFiles.count()) > 0) {
    await expect(page.locator('[data-syntax-highlighted="false"]'))
      .toHaveCount(0, { timeout: 30_000 })
      .catch(() => {
        // Highlighter import can fail offline; fall through rather than block the scan.
      });
  }

  // Monaco editor (components/ui/code-file-monaco.tsx) is the default submission code
  // viewer. It dynamic-imports behind a skeleton, then mounts, measures, and tokenizes
  // asynchronously, so a mid-load capture is a blank or half-laid-out pane (the manual-
  // grading score views raced exactly this). When a Monaco editor is present, wait for
  // its lines to render AND colorize — Monaco emits `.mtk*` token spans only once
  // tokenization has run — before capturing. Bounded + non-fatal like the wait above.
  const monacoEditor = page.locator(".monaco-editor");
  if ((await monacoEditor.count()) > 0) {
    await page
      .waitForFunction(
        () => {
          const lines = Array.from(document.querySelectorAll(".monaco-editor .view-lines .view-line"));
          return lines.length > 0 && lines.some((line) => line.querySelector('span[class*="mtk"]'));
        },
        undefined,
        { timeout: 30_000, polling: 200 }
      )
      .catch(() => {
        // Empty/untokenizable file or Monaco failed to load — proceed rather than block.
      });
  }

  const transientText = [
    "Loading analytics...",
    "Loading surveys...",
    "Loading lab sections...",
    "Loading lab roster...",
    "Submitting your comment..."
  ];

  for (const text of transientText) {
    await expect(page.getByText(text))
      .toBeHidden({ timeout: 1_000 })
      .catch(() => {
        // These strings are page-specific; absence/visibility is handled by each
        // test's domain assertions when it matters.
      });
  }

  // Blinking text carets make a full-page capture a function of animation phase: the same view
  // alternates between caret-visible and caret-hidden run-to-run, a pure phase diff, not a content
  // change. The culprit in the rubric views is the comment box (@uiw/react-md-editor); the Monaco
  // submission viewer can blink too. Freeze all CSS animations/transitions and hide carets before
  // capture. Mirrors the freeze the repo already applies for the axe accessibility scan; cosmetic-
  // only (no layout/height impact, unlike the sticky freeze) so it is left in place.
  await freezeAnimationsAndCaret(page);
}

/**
 * Zero out CSS animations/transitions and hide text carets so a full-page capture is not a function
 * of animation phase. Injects one idempotent <style> tag rather than mutating each node, so it is
 * cheap and safe to call repeatedly (waitForVisualIdle runs both standalone and inside
 * beforeScreenshot). Cosmetic-only: it changes no geometry, so there is nothing to restore. NOT a
 * masking fix — it removes a genuinely non-deterministic blink, it does not widen a diff threshold
 * or hide real content.
 */
async function freezeAnimationsAndCaret(page: Page) {
  await page
    .evaluate(() => {
      const id = "vt-freeze-animations";
      if (document.getElementById(id)) return;
      const style = document.createElement("style");
      style.id = id;
      style.textContent = `
        *, *::before, *::after {
          animation-duration: 0s !important;
          animation-delay: 0s !important;
          transition-duration: 0s !important;
          transition-delay: 0s !important;
          caret-color: transparent !important;
        }
        .monaco-editor .cursor,
        .monaco-editor .cursors-layer > .cursor { visibility: hidden !important; }
        /* @uiw/react-md-editor (comment boxes) overlays a <textarea> whose text is hidden via
           -webkit-text-fill-color:transparent while color stays inherited — so its blinking CARET
           stays visible and, in WebKit, follows 'color' (WebKit ignores caret-color here). The
           visible text is painted by the <pre> behind, so zeroing the textarea's own color only
           removes the caret, nothing else. */
        .w-md-editor-text-input,
        .w-md-editor-text > textarea,
        textarea.w-md-editor-text-input {
          color: transparent !important;
          caret-color: transparent !important;
        }
      `;
      document.head.appendChild(style);
    })
    .catch(() => {
      /* navigation/context race — nothing to freeze */
    });
}

export async function stabilizeRubricSidebar(page: Page, rubricName: string | RegExp) {
  const accessibleName =
    typeof rubricName === "string" ? new RegExp(`^(Rubric:\\s*)?${escapeRegExp(rubricName)}$`) : rubricName;
  const rubricRegion = page.getByRole("region", { name: accessibleName }).first();
  await expect(rubricRegion).toBeVisible();

  await rubricRegion.evaluate((element) => {
    const isScrollable = (candidate: HTMLElement) => {
      const style = window.getComputedStyle(candidate);
      const overflowY = style.overflowY;
      return (
        (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
        candidate.scrollHeight > candidate.clientHeight
      );
    };

    let scrollParent: HTMLElement | null = element.parentElement;
    while (scrollParent && !isScrollable(scrollParent)) {
      scrollParent = scrollParent.parentElement;
    }

    const container = scrollParent ?? document.scrollingElement;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    const offset = 8;
    container.scrollTop += elementRect.top - containerRect.top - offset;
  });

  await waitForStableLocator(rubricRegion);
}

/**
 * Pin every position:sticky element to static. Sticky banners (e.g. the "Grading for
 * <student>" rubric scope banner) get "stuck" at a scroll-dependent offset while Playwright
 * scrolls to tile a full-page screenshot, overlaying different content each run. Sticky is
 * in normal flow, so this keeps layout/height identical and only removes the scroll-float.
 * The original inline value is stashed so {@link restoreStickyPositions} can revert it after
 * capture — the override must not leak into post-screenshot interactions in the same test.
 */
async function freezeStickyPositions(page: Page) {
  await page
    .evaluate(() => {
      document.querySelectorAll<HTMLElement>("*").forEach((el) => {
        if (getComputedStyle(el).position === "sticky") {
          el.setAttribute("data-vt-prev-position", el.style.position || "");
          el.style.setProperty("position", "static", "important");
        }
      });
    })
    .catch(() => {
      /* navigation/context race — nothing to freeze */
    });
}

async function restoreStickyPositions(page: Page) {
  await page
    .evaluate(() => {
      document.querySelectorAll<HTMLElement>("[data-vt-prev-position]").forEach((el) => {
        const prev = el.getAttribute("data-vt-prev-position") || "";
        el.removeAttribute("data-vt-prev-position");
        if (prev) el.style.position = prev;
        else el.style.removeProperty("position");
      });
    })
    .catch(() => {
      /* page may be gone (end of test) — nothing to restore */
    });
}

export async function visualScreenshot(page: Page, name: string, options: VisualScreenshotOptions = {}) {
  const { stabilizeRubric, beforeScreenshot, ...argosOptions } = options;

  await waitForVisualIdle(page);
  if (stabilizeRubric) {
    await stabilizeRubricSidebar(page, stabilizeRubric);
  }

  try {
    return await argosScreenshot(page, name, {
      ...argosOptions,
      beforeScreenshot: async (api) => {
        await waitForVisualIdle(page);
        if (stabilizeRubric) {
          await stabilizeRubricSidebar(page, stabilizeRubric);
        }
        // Neutralize sticky positioning immediately before the capture; reverted in the
        // finally below so it can't affect later interactions/assertions in the same test.
        await freezeStickyPositions(page);
        await beforeScreenshot?.(api);
      }
    });
  } finally {
    await restoreStickyPositions(page);
  }
}
