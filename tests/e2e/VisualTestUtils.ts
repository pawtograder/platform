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

export async function visualScreenshot(page: Page, name: string, options: VisualScreenshotOptions = {}) {
  const { stabilizeRubric, beforeScreenshot, ...argosOptions } = options;

  await waitForVisualIdle(page);
  if (stabilizeRubric) {
    await stabilizeRubricSidebar(page, stabilizeRubric);
  }

  return argosScreenshot(page, name, {
    ...argosOptions,
    beforeScreenshot: async (api) => {
      await waitForVisualIdle(page);
      if (stabilizeRubric) {
        await stabilizeRubricSidebar(page, stabilizeRubric);
      }
      await beforeScreenshot?.(api);
    }
  });
}
