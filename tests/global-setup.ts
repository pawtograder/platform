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
   * Preserve layout and accessible/text queryability while making volatile
   * values invisible in screenshots. This is intended for dates, relative
   * times, and other values that tests assert separately before capture.
   */
  html[data-visual-tests] [data-visual-test="transparent"],
  html[data-visual-tests] [data-visual-test="transparent"] * {
    color: transparent !important;
    text-shadow: none !important;
    caret-color: transparent !important;
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
