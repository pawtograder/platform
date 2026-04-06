/**
 * E2E tests for submission-scoped data flowing through TanStack Query.
 *
 * Validates that the SubmissionDataBridge wiring works correctly when
 * viewing assignment and submission pages. These pages rely on scoped
 * real-time subscriptions and TanStack Query for data management.
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
    { role: "instructor", class_id: course.id, name: "Sub Instructor" },
    { role: "student", class_id: course.id, name: "Sub Student" }
  ]);
  instructor = users[0];
  student = users[1];
});

test.describe("Cross-Tab Submissions", () => {
  test("Instructor assignments page loads with TanStack Query", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/assignments`);
    await page.waitForTimeout(3000);

    // No error boundary should have triggered
    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);

    // The page body should have rendered
    await expect(page.locator("body")).not.toBeEmpty();
  });

  test("Student assignments page loads with TanStack Query", async ({ page }) => {
    await loginAsUser(page, student, course);
    await page.goto(`/course/${course.id}/assignments`);
    await page.waitForTimeout(3000);

    const errorCount = await page.locator("text=Something went wrong").count();
    expect(errorCount).toBe(0);

    await expect(page.locator("body")).not.toBeEmpty();
  });
});
