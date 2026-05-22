import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import { createClass, createUsersInClass, loginAsUser, TestingUser } from "./TestingUtils";
dotenv.config({ path: ".env.local", quiet: true });

test.setTimeout(120_000);

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;

const STUDENT_NAME = "View As Target Student";

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: STUDENT_NAME,
      public_profile_name: "View As Target Pseudonym",
      email: "view-as-target-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "View As Instructor",
      public_profile_name: "View As Instructor Pseudonym",
      email: "view-as-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.describe("Instructor view-as-student (read-only)", () => {
  test.describe.configure({ mode: "serial" });

  test("instructor can enter, sees a live read-only student view, and can exit", async ({ page }) => {
    // Capture browser console so we can assert realtime subscriptions succeed.
    const consoleLines: string[] = [];
    page.on("console", (msg) => consoleLines.push(msg.text()));

    await loginAsUser(page, instructor!, course);

    // Go to the enrollments roster and launch view-as for our student.
    await page.goto(`/course/${course.id}/manage/course/enrollments`);
    await expect(page.getByRole("heading", { name: "Enrollments" })).toBeVisible();

    const studentRow = page.getByRole("row", { name: new RegExp(STUDENT_NAME) });
    await expect(studentRow).toBeVisible();
    await studentRow.getByRole("button", { name: "View as this student" }).click();

    // The read-only banner should appear, naming the student.
    const banner = page.getByRole("alert", { name: "Viewing as student" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(STUDENT_NAME);
    await expect(banner).toContainText(/read only/i);

    // Role has flipped to student: instructor-only nav (Course Settings) is gone.
    await expect(page.getByRole("group").filter({ hasText: "Course Settings" })).toHaveCount(0);

    // Realtime: the controller subscribes to the *student's* channels. Authorization for an
    // instructor on class:<id>:user:<studentProfileId> and class:<id>:students is granted by
    // check_realtime_authorization, so subscription should succeed (live read-only view).
    await expect
      .poll(
        () =>
          consoleLines.some(
            (line) =>
              line.includes("Successfully subscribed") &&
              (line.includes(student!.private_profile_id) || line.includes(`class:${course.id}:students`))
          ),
        { timeout: 30_000, message: "expected a successful realtime subscription to the student's channel" }
      )
      .toBe(true);

    // No realtime channel errors for the student's channels.
    expect(
      consoleLines.some(
        (line) =>
          line.includes("Channel error") &&
          (line.includes(student!.private_profile_id) || line.includes(`class:${course.id}:students`))
      )
    ).toBe(false);

    // Exit restores the instructor view.
    await banner.getByRole("button", { name: "Exit student view" }).click();
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
    await page.goto(`/course/${course.id}/manage/course/enrollments`);
    await expect(page.getByRole("heading", { name: "Enrollments" })).toBeVisible();
  });
});
