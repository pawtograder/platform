import { type Course } from "@/utils/supabase/DatabaseTypes";
import dotenv from "dotenv";
import { expect, test } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser, type TestingUser } from "./TestingUtils";

dotenv.config({ path: ".env.local" });

// Use a browser timezone different from the course's default (America/New_York)
test.use({ timezoneId: "America/Los_Angeles" });

let course: Course;
let student: TestingUser | undefined;

test.describe("Time zone modal and indicator", () => {
  test.describe.configure({ mode: "serial" });

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

  test("Opens modal when no preference and time zones differ; persists selection", async ({ page }) => {
    // Clear localStorage BEFORE any navigation
    await page.context().clearCookies();
    await page.addInitScript(() => {
      localStorage.removeItem("pawtograder-timezone-pref");
    });

    // NOW log in - the addInitScript will run on navigation
    await loginAsUser(page, student!, course);

    // Modal should appear since course tz != browser tz and no saved pref
    await expect(page.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).toBeVisible();

    // Verify localStorage is empty before selection
    let pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBeNull();

    // Choose local/browser time zone
    await page.getByLabel("Use your local time zone").click();

    // Verify mode is set but NOT yet persisted (only persisted on dismiss)
    pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBeNull(); // Still null until we close the modal

    // Close the modal
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).not.toBeVisible();

    // NOW it should be persisted
    pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("browser");

    // Indicator should reflect Local Time Zone
    await expect(page.getByRole("button", { name: /Local Time Zone \(.+\)/ })).toBeVisible();
  });

  test("Preference persists across page reloads", async ({ page }) => {
    // Log in again (localStorage should still have "browser" from previous test in serial mode)
    await loginAsUser(page, student!, course);

    // Modal should NOT appear because we have a saved preference
    await expect(page.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).not.toBeVisible();

    // Indicator should still show Local Time Zone
    await expect(page.getByRole("button", { name: /Local Time Zone \(.+\)/ })).toBeVisible();

    // Verify localStorage still has our preference
    const pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("browser");
  });

  test("Indicator opens modal and toggles back to course time zone", async ({ page }) => {
    await loginAsUser(page, student!, course);

    // Verify we're starting with browser timezone from previous tests
    let pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("browser");

    // Indicator should show Local; click to open modal via indicator
    await page.getByRole("button", { name: /Local Time Zone \(.+\)/ }).click();
    await expect(page.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).toBeVisible();

    // Switch to course time zone
    await page.getByLabel("Use course time zone").click();

    // According to your code, setMode saves immediately to localStorage
    // So it should be persisted right away
    pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("course");

    // Close the modal
    await page.getByRole("button", { name: "Close" }).click();

    // Indicator should now show Course Time Zone
    await expect(page.getByRole("button", { name: /Course Time Zone \(.+\)/ })).toBeVisible();

    // Verify persistence one more time
    pref = await page.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBe("course");
  });

  test("Manually setting localStorage prevents modal from showing", async ({ context }) => {
    // Create a new context to simulate a fresh browser session
    const newPage = await context.newPage();

    // Set localStorage BEFORE navigating
    await newPage.addInitScript(() => {
      localStorage.setItem("pawtograder-timezone-pref", "course");
    });

    // Now log in
    await loginAsUser(newPage, student!, course);

    // Modal should NOT appear because we have a preference
    await expect(newPage.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).not.toBeVisible();

    // Indicator should show Course Time Zone
    await expect(newPage.getByRole("button", { name: /Course Time Zone \(.+\)/ })).toBeVisible();

    await newPage.close();
  });

  test("Modal does not appear when browser and course timezones are the same", async ({ browser }) => {
    // Create a context with the SAME timezone as the course
    const contextWithNYTime = await browser.newContext({
      timezoneId: "America/New_York" // Same as course default
    });
    const newPage = await contextWithNYTime.newPage();

    // Clear any existing preference
    await newPage.addInitScript(() => {
      localStorage.removeItem("pawtograder-timezone-pref");
    });

    await loginAsUser(newPage, student!, course);

    // Modal should NOT appear because timezones match
    await expect(newPage.getByRole("dialog", { name: "Choose Your Time Zone Preference" })).not.toBeVisible();

    // Should default to course timezone
    const pref = await newPage.evaluate(() => localStorage.getItem("pawtograder-timezone-pref"));
    expect(pref).toBeNull(); // No preference needed when they match

    await contextWithNYTime.close();
  });
});
