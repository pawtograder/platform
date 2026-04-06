/**
 * E2E smoke test for the TanStack Query migration.
 *
 * Validates that course pages load correctly after the migration
 * from TableController to TanStack Query hooks. Catches SSR hydration
 * issues and missing data context problems.
 */

import { test, expect } from "../global-setup";
import { createClass, createUsersInClass, loginAsUser } from "./TestingUtils";

type Course = Awaited<ReturnType<typeof createClass>>;
type User = Awaited<ReturnType<typeof createUsersInClass>>[number];

let course: Course;
let instructor: User;
let student: User;

test.beforeAll(async () => {
  course = await createClass();
  const users = await createUsersInClass([
    { role: "instructor", class_id: course.id, name: "TQ Instructor" },
    { role: "student", class_id: course.id, name: "TQ Student" }
  ]);
  instructor = users[0]; // first user created with role "instructor"
  student = users[1]; // second user created with role "student"
});

test.describe("TanStack Migration Smoke Tests", () => {
  test("Instructor course page loads without errors", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.waitForTimeout(3000);
    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("Discussion page loads", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/discussion`);
    await page.waitForTimeout(3000);
    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);
  });

  test("Student can view course page", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.waitForTimeout(3000);
    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);
  });
});
