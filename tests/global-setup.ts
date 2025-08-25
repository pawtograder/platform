import { test as base, Page } from "@playwright/test";

// Function to inject visual test setup
const injectVisualTestSetup = async (page: Page) => {
  await page.evaluate(() => {
    // Set the data-visual-tests attribute on the html element
    if(document.documentElement) {
      document.documentElement.setAttribute("data-visual-tests", "");
    }
    
    // Check if our style is already injected to avoid duplicates
    if (!document.getElementById('visual-test-style')) {
      // Create and inject CSS that removes all border-radius
      const style = document.createElement('style');
      style.id = 'visual-test-style';
      style.textContent = `
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
      `;
      if(document.head) {
        document.head.appendChild(style);
      }
    }
  });
};

// Extend the base test to include visual test setup
export const test = base.extend({
  page: async ({ page }, use) => {
    // Set up initial script for new page loads
    await page.addInitScript(() => {
      // Set the data-visual-tests attribute on the html element
      if(document.documentElement) {
        document.documentElement.setAttribute("data-visual-tests", "");
      }
      
      // Check if our style is already injected to avoid duplicates
      if (!document.getElementById('visual-test-style')) {
        // Create and inject CSS that removes all border-radius
        const style = document.createElement('style');
        style.id = 'visual-test-style';
        style.textContent = `
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
        `;
        if(document.head) {
          document.head.appendChild(style);
        }
      }
    });

    // Listen for all navigations and re-inject the setup
    page.on('domcontentloaded', async () => {
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
