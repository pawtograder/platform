import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import dotenv from "dotenv";
import { createClass, createUsersInClass, insertAssignment, loginAsUser, TestingUser } from "@/tests/e2e/TestingUtils";
import { visualScreenshot } from "@/tests/e2e/VisualTestUtils";
import { viewAsCookieName } from "@/lib/viewAs";
import { addDays } from "date-fns";
dotenv.config({ path: ".env.local", quiet: true });

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

test.setTimeout(120_000);

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;

const STUDENT_NAME = "View As Target Student";
const ASSIGNMENT_TITLE = "View As Target Assignment";

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
  // One released assignment so the student dashboard view returns at least one row.
  // This is what an instructor in view-as expects to see on `/course/<id>/assignments`.
  await insertAssignment({
    class_id: course.id,
    name: ASSIGNMENT_TITLE,
    due_date: addDays(new Date(), 7).toUTCString()
  });
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
    // The roster action is a clickable icon (svg with aria-label), not a <button>.
    await studentRow.getByLabel("View as this student", { exact: true }).click();

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
    // Wait for the RSC refresh triggered by exitViewAs to settle — instructor-only nav
    // (Course Settings) returns — before navigating away. Otherwise the in-flight refresh of
    // the current route can interrupt the next goto (observed flaky on WebKit).
    await expect(page.getByRole("group").filter({ hasText: "Course Settings" })).toHaveCount(1);
    await page.goto(`/course/${course.id}/manage/course/enrollments`);
    await expect(page.getByRole("heading", { name: "Enrollments" })).toBeVisible();
  });

  test("student write surfaces are read-only while viewing as a student", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    // Activate view-as via the per-course cookie (equivalent to clicking the roster
    // "View as this student" button exercised above).
    await page
      .context()
      .addCookies([{ name: viewAsCookieName(course.id), value: student!.private_profile_id, url: BASE_URL }]);

    await page.goto(`/course/${course.id}/discussion/new`);

    // The read-only banner confirms view-as actually engaged on this page.
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toBeVisible();

    // The "New Discussion Thread" submit is disabled and relabeled while read-only, so an
    // instructor cannot post a thread authored as the student.
    const submit = page.getByRole("button", { name: /Read-only \(viewing as student\)/i });
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();

    // Visual snapshot of the read-only state (banner + disabled "New Discussion Thread" form).
    await visualScreenshot(page, "View as student - read-only discussion form");
  });

  test("a non-instructor cannot activate view-as with a forged cookie", async ({ page }) => {
    await loginAsUser(page, student!, course);

    // A student forges the instructor-only cookie. Both the server (getEffectiveCourseIdentity)
    // and the client (ClassProfileProvider) only honor it for real instructors, so it is ignored.
    await page
      .context()
      .addCookies([{ name: viewAsCookieName(course.id), value: student!.private_profile_id, url: BASE_URL }]);

    await page.goto(`/course/${course.id}/discussion/new`);

    // No read-only banner appears, and the student keeps a normal, enabled submit button.
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Submit" })).toBeEnabled();

    // Visual snapshot of the result (no view-as banner; normal enabled student form).
    await visualScreenshot(page, "View as student - forged cookie ignored for non-instructor");
  });

  test("instructor in view-as sees the student's assignments list populated", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    // Activate view-as via the per-course cookie. The dashboard data path is the
    // SECURITY DEFINER RPC `get_assignments_for_student_dashboard`, which authorizes
    // the caller at the top (student themselves, or an instructor/grader of the class).
    // Without that authorization branch, an instructor would get a permission error
    // and the list would be empty.
    await page
      .context()
      .addCookies([{ name: viewAsCookieName(course.id), value: student!.private_profile_id, url: BASE_URL }]);

    await page.goto(`/course/${course.id}/assignments`);

    // The banner is up (view-as engaged) and the seeded assignment is listed.
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toBeVisible();
    await expect(page.getByText(ASSIGNMENT_TITLE).first()).toBeVisible();
  });
});
