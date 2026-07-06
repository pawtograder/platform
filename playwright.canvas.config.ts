import { defineConfig, devices } from "@playwright/test";

/**
 * Dedicated Playwright config for the Canvas LTI 1.3 end-to-end suite.
 *
 * This suite is intentionally separate from the default E2E run
 * (playwright.config.ts ignores tests/e2e/lti/**) because it stands up a full
 * Canvas LMS and is far heavier/slower than the rest of the suite. It is run
 * selectively:
 *   - locally:  tests/e2e/canvas/run-e2e.sh   (boots the stack, then invokes this)
 *   - CI:       .github/workflows/canvas-e2e.yml (workflow_dispatch / "e2e-canvas" label)
 *
 * Prereqs (handled by run-e2e.sh / the CI job before Playwright starts):
 *   - Canvas stack up + seeded (course/users/assignment/dev-key)
 *   - Pawtograder tool reachable at TOOL_BASE_URL with the Canvas platform registered
 *   - tests/e2e/lti/.canvas-e2e.json written with the captured IDs/credentials
 */
export default defineConfig({
  testDir: "./tests/e2e/lti",
  testMatch: ["**/*.canvas.spec.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // Canvas launches/AGS can be slow; one retry on CI, none locally.
  retries: process.env.CI ? 1 : 0,
  // Sequential: the suite mutates shared Canvas + Pawtograder state in order.
  workers: 1,
  timeout: 120_000,

  reporter: [
    process.env.CI ? ["dot"] : ["list"],
    [
      "@argos-ci/playwright/reporter",
      {
        uploadToArgos: !!process.env.CI,
        token: process.env.ARGOS_TOKEN || ""
      }
    ],
    ["html", { outputFolder: "playwright-report-canvas", open: "never" }]
  ],

  use: {
    // The Pawtograder tool under test.
    baseURL: process.env.TOOL_BASE_URL || "http://localhost:3000",
    screenshot: "only-on-failure",
    trace: "on-first-retry"
  },
  expect: {
    timeout: 30_000
  },

  // Chromium only: a single, stable visual baseline for Argos, and Canvas is
  // heavy enough without a second engine.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
