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

async function waitForStableSurveyCharts(page: Page) {
  await page
    .waitForFunction(
      () => {
        const hosts = Array.from(document.querySelectorAll<HTMLElement>("[data-survey-chart-host]"));
        if (hosts.length === 0) return true;
        return hosts.every((host) => {
          if (
            document.documentElement.hasAttribute("data-visual-tests") &&
            host.hasAttribute("data-survey-chart-ready")
          ) {
            const surface = host.querySelector(".recharts-surface");
            return Boolean(surface && surface.getBoundingClientRect().width > 0);
          }
          const surface = host.querySelector(".recharts-surface");
          if (!surface) return false;
          const hostRect = host.getBoundingClientRect();
          const surfaceRect = surface.getBoundingClientRect();
          return hostRect.width > 0 && surfaceRect.width > 0 && Math.abs(hostRect.width - surfaceRect.width) < 2;
        });
      },
      undefined,
      { timeout: 10_000 }
    )
    .catch(() => {
      /* page may not include survey charts */
    });
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
  // Capturing mid-load produces per-glyph diffs across the whole code column. If any
  // code file on the page is still un-highlighted, wait for it to finish before the
  // screenshot. Bounded + non-fatal: a file with no tokenizable content still flips
  // the flag to "true", and the catch covers pages without code files.
  const codeFiles = page.locator("[data-syntax-highlighted]");
  if ((await codeFiles.count()) > 0) {
    await expect(page.locator('[data-syntax-highlighted="false"]'))
      .toHaveCount(0, { timeout: 10_000 })
      .catch(() => {
        // Highlighter import can fail offline; fall through rather than block the scan.
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

  await waitForStableSurveyCharts(page);
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
