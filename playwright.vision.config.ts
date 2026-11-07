import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the exam OCR suites that call the real Google Vision + Gemini APIs.
 *
 * playwright.config.ts ignores *.vision.spec.ts: these suites need GOOGLE_API_KEY and spend real
 * quota, so they stay out of the per-PR run. They run in .github/workflows/exam-vision-e2e.yml
 * (manual dispatch, staging pushes that touch the exam OCR path, and a weekly schedule).
 *
 * Locally: start Supabase, serve functions with EXAM_VISION_PROVIDER=gemini and a GOOGLE_API_KEY
 * in the env file, then `npm run test:e2e:vision`.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["**/*.vision.spec.ts"],
  globalSetup: "./tests/wait-for-schema-cache.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // One retry absorbs a transient Google 5xx; a deterministic failure (bad key, retired model)
  // fails both attempts.
  retries: process.env.CI ? 1 : 0,
  // Sequential, so both suites share one quota budget instead of racing each other into 429s.
  workers: 1,
  timeout: 300_000,
  reporter: [
    process.env.CI ? ["dot"] : ["list"],
    ["html", { outputFolder: "playwright-report-vision", open: "never" }]
  ],
  use: {
    screenshot: "only-on-failure",
    trace: "on-first-retry"
  },
  expect: {
    timeout: 30_000
  },
  // Chromium only. The browser is used to render the synthetic exam pages, not to drive the app.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
