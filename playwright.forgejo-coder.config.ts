import { defineConfig, devices } from "@playwright/test";

/** CW-04 Forgejo/Coder SSO lane; needs the stack from tests/e2e/forgejo-coder/run-e2e.sh. */
export default defineConfig({
  testDir: "./tests/e2e/sso",
  testMatch: ["**/*.forgejo-coder.spec.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // Journeys build on accounts earlier journeys created.
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
