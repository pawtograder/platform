import { test as base, Page } from "@playwright/test";
import { logMagicLink, TestingUser } from "@/tests/e2e/TestingUtils";

const VISUAL_TEST_CSS = `
  /* Visual test override - remove all border radius */
  html[data-visual-tests] *,
  html[data-visual-tests] *::before,
  html[data-visual-tests] *::after {
    border-radius: 0 !important;
    border-top-left-radius: 0 !important;
    border-top-right-radius: 0 !important;
    border-bottom-left-radius: 0 !important;
    border-bottom-right-radius: 0 !important;
  }

  /*
   * Preserve accessible/text queryability while replacing volatile values with
   * stable placeholders in screenshots. Transparent text alone can still
   * change layout when a date or relative time is longer in one run than
   * another, so visual mode fixes inline sizing and paints deterministic
   * pseudo-content instead.
   */
  html[data-visual-tests] [data-visual-test="transparent"] {
    --visual-test-placeholder: "████████████";
    --visual-test-placeholder-width: 18ch;
    display: inline-block !important;
    inline-size: var(--visual-test-placeholder-width) !important;
    max-inline-size: var(--visual-test-placeholder-width) !important;
    min-inline-size: var(--visual-test-placeholder-width) !important;
    overflow: hidden !important;
    white-space: nowrap !important;
    vertical-align: baseline !important;
    position: relative !important;
    color: transparent !important;
    text-shadow: none !important;
    caret-color: transparent !important;
  }

  html[data-visual-tests] [data-visual-test="transparent"]::after {
    content: var(--visual-test-placeholder) !important;
    position: absolute !important;
    inset-inline-start: 0 !important;
    inset-block-start: 0 !important;
    color: CanvasText !important;
    opacity: 0.22 !important;
    font: inherit !important;
    letter-spacing: 0 !important;
    pointer-events: none !important;
  }

  html[data-visual-tests] [data-visual-test="transparent"] * {
    color: transparent !important;
    text-shadow: none !important;
    caret-color: transparent !important;
  }

  html[data-visual-tests] [data-visual-placeholder="date"] {
    --visual-test-placeholder: "MMM 00, 0000 00:00 TZ";
    --visual-test-placeholder-width: 22ch;
  }

  html[data-visual-tests] [data-visual-placeholder="relative-time"] {
    --visual-test-placeholder: "relative time";
    --visual-test-placeholder-width: 16ch;
  }

  html[data-visual-tests] [data-visual-placeholder="timestamp"] {
    --visual-test-placeholder: "timestamp";
    --visual-test-placeholder-width: 12ch;
  }

  html[data-visual-tests] [data-visual-placeholder="review-status"] {
    --visual-test-placeholder: "review date/status";
    --visual-test-placeholder-width: 28ch;
  }

  html[data-visual-tests] [data-visual-test="transparent"] svg,
  html[data-visual-tests] [data-visual-test="transparent"] img,
  html[data-visual-tests] [data-visual-test="transparent"] canvas {
    opacity: 0 !important;
  }

  /*
   * Remove transient UI entirely. The element remains in the DOM, but does
   * not affect visual layout or screenshots while visual tests are active.
   */
  html[data-visual-tests] [data-visual-test="removed"] {
    display: none !important;
  }
`;

// Function to inject visual test setup
const injectVisualTestSetup = async (page: Page) => {
  await page.evaluate((visualTestCss) => {
    // Set the data-visual-tests attribute on the html element
    if (document.documentElement) {
      document.documentElement.setAttribute("data-visual-tests", "");
    }

    // Check if our style is already injected to avoid duplicates
    if (!document.getElementById("visual-test-style")) {
      // Create and inject CSS that removes all border-radius
      const style = document.createElement("style");
      style.id = "visual-test-style";
      style.textContent = visualTestCss;
      if (document.head) {
        document.head.appendChild(style);
      }
    }
  }, VISUAL_TEST_CSS);
};

type E2EFixtures = {
  logMagicLinksOnFailure: (users: (TestingUser | undefined)[]) => Promise<void>;
};

// Extend the base test to include visual test setup
export const test = base.extend<E2EFixtures>({
  logMagicLinksOnFailure: async ({}, use, testInfo) => {
    await use(async (users) => {
      if (testInfo.status === testInfo.expectedStatus) return;
      await logMagicLink(users);
    });
  },
  page: async ({ page }, use) => {
    // Set up initial script for new page loads
    await page.addInitScript((visualTestCss) => {
      // Set the data-visual-tests attribute on the html element
      if (document.documentElement) {
        document.documentElement.setAttribute("data-visual-tests", "");
      }

      // Check if our style is already injected to avoid duplicates
      if (!document.getElementById("visual-test-style")) {
        // Create and inject CSS that removes all border-radius
        const style = document.createElement("style");
        style.id = "visual-test-style";
        style.textContent = visualTestCss;
        if (document.head) {
          document.head.appendChild(style);
        }
      }
    }, VISUAL_TEST_CSS);

    // Listen for all navigations and re-inject the setup
    page.on("domcontentloaded", async () => {
      await injectVisualTestSetup(page);
    });

    // Also inject on the current page if it's already loaded
    await injectVisualTestSetup(page);

    // Not a hook!
    // eslint-disable-next-line react-hooks/rules-of-hooks
    await use(page);
  }
});

export { expect } from "@playwright/test";
