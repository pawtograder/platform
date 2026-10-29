import { defineConfig, devices } from "@playwright/test";

/**
 * Dedicated Playwright config for the "sign in to Forgejo and Coder with Pawtograder" (CW-04)
 * end-to-end suite.
 *
 * Kept out of the default E2E run (playwright.config.ts ignores tests/e2e/sso/**) because it
 * needs Forgejo, Coder and an isolated Supabase running next to Pawtograder. It is run
 * selectively:
 *   - locally:  tests/e2e/forgejo-coder/run-e2e.sh   (boots the stack, then invokes this)
 *   - CI:       .github/workflows/forgejo-coder-e2e.yml (workflow_dispatch)
 *
 * Prereqs (handled by run-e2e.sh before Playwright starts):
 *   - Supabase with the OAuth 2.1 server on, Forgejo and Coder registered as clients
 *   - Forgejo with the "pawtograder" login source, Coder with CODER_OIDC_* set
 *   - tests/e2e/sso/.forgejo-coder-e2e.json written with the URLs/IDs/credentials
 */
export default defineConfig({
  testDir: "./tests/e2e/sso",
  testMatch: ["**/*.forgejo-coder.spec.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Sequential: journeys build on accounts earlier journeys created.
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
    ["html", { outputFolder: "playwright-report-forgejo-coder", open: "never" }]
  ],

  use: {
    // The Pawtograder identity provider under test.
    baseURL: process.env.PAW_BASE_URL || "http://127.0.0.1:3300",
    screenshot: "only-on-failure",
    trace: "on-first-retry"
  },
  expect: {
    timeout: 30_000
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
