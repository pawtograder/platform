/**
 * E2E memory regression tests.
 *
 * Verifies that navigating between pages does not cause crashes or
 * accumulated errors from subscription/controller leaks. True heap
 * measurement requires CDP and is flaky in CI, so these tests focus
 * on error accumulation and crash detection after repeated navigation.
 */

import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

let course: Course;
let instructor: User;

test.beforeAll(async () => {
  course = await createClass();
  const users = await createUsersInClass([{ role: "instructor", class_id: course.id, name: "Mem Instructor" }]);
  instructor = users[0];
});

test.describe("Memory Regression", () => {
  test("Navigating between pages does not leak or crash", async ({ page }) => {
    await loginAsUser(page, instructor, course);

    // Navigate between office-hours and discussion 3 times to exercise
    // mount/unmount cycles for real-time subscriptions and TanStack Query
    // cache entries.
    for (let i = 0; i < 3; i++) {
      await page.goto(`/course/${course.id}/office-hours`);
      await page.waitForTimeout(2000);
      await page.goto(`/course/${course.id}/discussion`);
      await page.waitForTimeout(2000);
    }

    // Verify no error boundaries accumulated from repeated navigation
    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);
  });

  test("Navigating to and from assignments does not crash", async ({ page }) => {
    await loginAsUser(page, instructor, course);

    for (let i = 0; i < 3; i++) {
      await page.goto(`/course/${course.id}/assignments`);
      await page.waitForTimeout(2000);
      await page.goto(`/course/${course.id}/discussion`);
      await page.waitForTimeout(2000);
    }

    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);
  });
});
