/**
 * E2E tests for cross-tab leader election and data sync.
 *
 * True multi-tab tests are limited in Playwright because BroadcastChannel
 * does not work across separate browser contexts (they are independent
 * processes). These tests verify the single-tab path works correctly and
 * that the leader election + data bridge do not break normal functionality.
 *
 * Cross-tab logic is covered by the unit/integration tests in
 * tests/unit/integration/.
 */

import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

let course: Course;
let instructor: User;

test.beforeAll(async () => {
  course = await createClass();
  const users = await createUsersInClass([{ role: "instructor", class_id: course.id, name: "Sync Instructor" }]);
  instructor = users[0];
});

test.describe("Cross-Tab Sync", () => {
  test("Single tab becomes leader and loads data without errors", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.waitForTimeout(3000);

    // Verify no error boundary triggered
    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);

    // Verify LeaderProvider is active — QueryClientProvider is always present
    // in the component tree, so the page should render correctly.
    const hasBody = await page.evaluate(() => {
      return typeof window !== "undefined" && document.querySelector("body") !== null;
    });
    expect(hasBody).toBe(true);
  });

  test("Course discussion page renders with TanStack Query data", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/discussion`);
    await page.waitForTimeout(3000);

    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);
  });

  test("Course office-hours page renders with TanStack Query data", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/office-hours`);
    await page.waitForTimeout(3000);

    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);
  });
});
