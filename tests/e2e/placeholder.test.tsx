import { test, expect, type Page } from "@playwright/test";
import percySnapshot from "@percy/playwright";

test.describe("Placeholder until other tests are added", () => {
  test("Placeholder", async ({ page }) => {
    await page.goto("https://app.pawtograder.com/");
    await expect(page.getByText("Sign in")).toBeVisible();
    await percySnapshot(page, "Placeholder");
  });
});
