import { type Course } from "@/utils/supabase/DatabaseTypes";
import dotenv from "dotenv";
import { expect, test } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, type TestingUser } from "./TestingUtils";

dotenv.config({ path: ".env.local" });

// Use a browser timezone different from the course's default (America/New_York)
test.use({ timezoneId: "America/Los_Angeles" });

let course: Course;
let student: TestingUser | undefined;

test.describe("Time zone dialog and indicator", () => {
  test.beforeAll(async () => {
    course = await createClass(); // default course.time_zone is America/New_York
    [student] = await createUsersInClass([
      {
        name: "TZ Student",
        email: "tz-student@pawtograder.net",
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
  });

  test("Opens dialog when no preference and time zones differ; persists selection", async ({ page }) => {
    // Clear localStorage BEFORE any navigation
    await page.context().clearCookies();
    await page.addInitScript(() => {
      localStorage.removeItem("pawtograder-timezone-pref");
    });

    await loginAsUser(page, student!, course, false);

    const timezoneDialog = page.getByRole("dialog", { name: "Choose Your Time Zone Preference" });
    await expect(timezoneDialog).toBeVisible();

    let pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBeNull();

    // Click the visible text
    await page.getByText("Use your local time zone", { exact: true }).click();

    await page.keyboard.press("Escape");
    await timezoneDialog.waitFor({ state: "hidden", timeout: 3000 });

    pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("browser");

    await expect(page.getByRole("button", { name: /Local Time Zone \(.+\)/ })).toBeVisible();
  });

  test("Preference persists across page reloads", async ({ page }) => {
    // Set preference explicitly
    await page.addInitScript(() => {
      localStorage.setItem("pawtograder-timezone-pref", "browser");
    });

    await loginAsUser(page, student!, course);

    await expect(page.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Local Time Zone \(.+\)/ })).toBeVisible();

    const pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("browser");
  });

  test("Indicator opens dialog and toggles back to course time zone", async ({ page }) => {
    // Set preference explicitly
    await page.addInitScript(() => {
      localStorage.setItem("pawtograder-timezone-pref", "browser");
    });

    await loginAsUser(page, student!, course);

    let pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("browser");

    await page.getByRole("button", { name: /Local Time Zone \(.+\)/ }).click();
    await expect(page.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).toBeVisible();

    // Click the visible text
    await page.getByText("Use course time zone", { exact: true }).click();

    pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("course");

    await page.keyboard.press("Escape");

    await expect(page.getByRole("button", { name: /Course Time Zone \(.+\)/ })).toBeVisible();

    pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("course");
  });
  test("Manually setting localStorage prevents dialog from showing", async ({ context }) => {
    // Create a new context to simulate a fresh browser session
    const newPage = await context.newPage();

    // Set localStorage BEFORE navigating
    await newPage.addInitScript(() => {
      localStorage.setItem("pawtograder-timezone-pref", "course");
    });

    // Now log in
    await loginAsUser(newPage, student!, course, false);

    // Dialog should NOT appear because we have a preference
    await expect(newPage.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).not.toBeVisible();

    // Indicator should show Course Time Zone
    await expect(newPage.getByRole("button", { name: /Course Time Zone \(.+\)/ })).toBeVisible();

    await newPage.close();
  });

  test("Dialog does not appear when browser and course timezones are the same", async ({ browser }) => {
    // Create a context with the SAME timezone as the course
    const contextWithNYTime = await browser.newContext({
      timezoneId: "America/New_York" // Same as course default
    });
    const newPage = await contextWithNYTime.newPage();

    // Clear any existing preference
    await newPage.addInitScript(() => {
      localStorage.removeItem("pawtograder-timezone-pref");
    });

    await loginAsUser(newPage, student!, course, false);

    // Dialog should NOT appear because timezones match
    await expect(newPage.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).not.toBeVisible();

    // Should default to course timezone
    const pref = await newPage.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBeNull(); // No preference needed when they match

    await contextWithNYTime.close();
  });
});
