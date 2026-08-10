import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "@/tests/global-setup";
import type { Page } from "@playwright/test";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  gradeSubmission,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "@/tests/e2e/TestingUtils";
import { visualScreenshot } from "@/tests/e2e/VisualTestUtils";

dotenv.config({ path: ".env.local", quiet: true });

test.setTimeout(120_000);

let course: Course;
let instructor: TestingUser;
let grader: TestingUser;
/** A real enrollment, so the "view as an enrolled student" path has something to resolve. */
let student: TestingUser;
let assignmentId: number;
/** An assignment whose release date is still in the future, as it is while staff test it. */
let unreleasedAssignmentId: number;
let unreleasedSubmissionId: number;
const staffSubmissions = new Map<string, number>();

/**
 * Opens a test submission in the read-only student preview. Clicking the submission itself goes to
 * the staff/grading view, so the preview is entered from the explicit per-row action.
 */
async function enterStudentPreview(page: Page, submissionId: number) {
  await page.getByRole("button", { name: `Preview as student, submission ${submissionId}` }).click();
}

/**
 * Waits for a submission page to finish redirecting to its default tab. Navigating away before that
 * lands means the pending redirect supersedes the navigation, which reads as a click that did
 * nothing.
 */
async function expectSubmissionTabSettled(page: Page) {
  await expect(page).toHaveURL(/\/submissions\/\d+\/(results|files|grade)/);
}

/**
 * Waits until the per-course view-as cookie is gone. Dropping out of the preview is completed on the
 * client, so this is the signal that it has actually happened; asserting only that the banner is
 * absent can pass against a page that has not hydrated yet.
 */
async function expectViewAsCookieCleared(page: Page) {
  await expect
    .poll(
      async () => (await page.context().cookies()).filter((cookie) => cookie.name === `view_as_${course.id}`).length
    )
    .toBe(0);
}

async function requireNoError<T>(result: { data: T; error: { message: string } | null }, context: string): Promise<T> {
  if (result.error) {
    throw new Error(`${context}: ${result.error.message}`);
  }
  return result.data;
}

async function seedStaffTestSubmission(staff: TestingUser, graderProfileId: string) {
  const submission = await insertPreBakedSubmission({
    student_profile_id: staff.private_profile_id,
    assignment_id: assignmentId,
    class_id: course.id,
    files: [
      {
        name: "student_view_test.py",
        contents: `def add(a, b):
    return a + b

print(add(2, 3))
`
      }
    ]
  });

  await gradeSubmission(submission.grading_review_id, graderProfileId, true, {
    checkApplyChance: 1,
    pointsRandomizer: () => 0.5,
    totalScoreOverride: 88,
    totalAutogradeScoreOverride: 5
  });

  await requireNoError(
    await supabase
      .from("submission_reviews")
      .update({ released: false, total_score: 88, total_autograde_score: 5 })
      .eq("id", submission.grading_review_id)
      .select("id"),
    "failed to keep test submission review unreleased"
  );
  await requireNoError(
    await supabase
      .from("submission_comments")
      .update({ released: false })
      .eq("submission_id", submission.submission_id),
    "failed to hide generated submission comments"
  );
  await requireNoError(
    await supabase
      .from("submission_file_comments")
      .update({ released: false })
      .eq("submission_id", submission.submission_id),
    "failed to hide generated file comments"
  );
  await requireNoError(
    await supabase
      .from("submission_comments")
      .insert({
        submission_id: submission.submission_id,
        submission_review_id: submission.grading_review_id,
        author: graderProfileId,
        comment: "UNRELEASED_STAFF_RUBRIC_COMMENT",
        points: 4,
        class_id: course.id,
        released: false
      })
      .select("id"),
    "failed to insert unreleased staff rubric comment"
  );

  const graderResult = await requireNoError(
    await supabase.from("grader_results").select("id").eq("submission_id", submission.submission_id).single(),
    "failed to load grader result"
  );
  const graderTests = await requireNoError(
    await supabase.from("grader_result_tests").select("id").eq("grader_result_id", graderResult.id).order("id"),
    "failed to load grader tests"
  );
  const visibleTest = graderTests[0];
  const hiddenTest = graderTests[1];
  if (!visibleTest || !hiddenTest) {
    throw new Error("expected two pre-baked grader tests");
  }

  await requireNoError(
    await supabase
      .from("grader_result_tests")
      .update({
        name: "Visible student-facing check",
        output: "STUDENT_VISIBLE_TEST_OUTPUT",
        output_format: "text",
        is_released: true,
        part: "Public checks"
      })
      .eq("id", visibleTest.id)
      .select("id"),
    "failed to update visible grader test"
  );
  await requireNoError(
    await supabase
      .from("grader_result_tests")
      .update({
        name: "Hidden staff-only regression",
        output: "HIDDEN_STAFF_ONLY_TEST_OUTPUT",
        output_format: "text",
        is_released: false,
        extra_data: { hide_score: "true" }
      })
      .eq("id", hiddenTest.id)
      .select("id"),
    "failed to update hidden grader test"
  );
  await requireNoError(
    await supabase
      .from("grader_result_test_output")
      .insert({
        grader_result_test_id: visibleTest.id,
        class_id: course.id,
        output: "INSTRUCTOR_ONLY_TEST_STDOUT",
        output_format: "text"
      })
      .select("id"),
    "failed to insert instructor-only test output"
  );
  await requireNoError(
    await supabase
      .from("grader_result_output")
      .insert([
        {
          grader_result_id: graderResult.id,
          class_id: course.id,
          student_id: staff.private_profile_id,
          visibility: "visible",
          format: "text",
          output: "STUDENT_VISIBLE_GRADER_OUTPUT"
        },
        {
          grader_result_id: graderResult.id,
          class_id: course.id,
          student_id: staff.private_profile_id,
          visibility: "hidden",
          format: "text",
          output: "HIDDEN_INSTRUCTOR_GRADER_OUTPUT"
        }
      ])
      .select("id"),
    "failed to insert grader output tabs"
  );

  return submission.submission_id;
}

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(120_000);
  const emailSuffix = Math.random().toString(36).slice(2, 8);
  course = await createClass({ name: "Test Assignment View As Student" });
  [instructor, grader, student] = await createUsersInClass([
    {
      name: "Test Assignment View Instructor",
      public_profile_name: "Test Assignment View Instructor Public",
      email: `test-assignment-view-instructor-${emailSuffix}@pawtograder.net`,
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Test Assignment View Grader",
      public_profile_name: "Test Assignment View Grader Public",
      email: `test-assignment-view-grader-${emailSuffix}@pawtograder.net`,
      role: "grader",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Test Assignment View Student",
      public_profile_name: "Test Assignment View Student Public",
      email: `test-assignment-view-student-${emailSuffix}@pawtograder.net`,
      role: "student",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  const assignment = await insertAssignment({
    due_date: addDays(new Date(), 5).toUTCString(),
    release_date: addDays(new Date(), -1).toUTCString(),
    class_id: course.id,
    name: "Test Assignment Student Preview E2E"
  });
  assignmentId = assignment.id;

  staffSubmissions.set("grader", await seedStaffTestSubmission(grader, instructor.private_profile_id));
  staffSubmissions.set("instructor", await seedStaffTestSubmission(instructor, instructor.private_profile_id));

  // Staff normally test an assignment before releasing it to students, so seed a second
  // assignment whose release date is still ahead of us.
  const unreleasedAssignment = await insertAssignment({
    due_date: addDays(new Date(), 10).toUTCString(),
    release_date: addDays(new Date(), 5).toUTCString(),
    class_id: course.id,
    name: "Test Assignment Unreleased Preview E2E"
  });
  unreleasedAssignmentId = unreleasedAssignment.id;
  unreleasedSubmissionId = (
    await insertPreBakedSubmission({
      student_profile_id: instructor.private_profile_id,
      assignment_id: unreleasedAssignmentId,
      class_id: course.id
    })
  ).submission_id;
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([instructor, grader, student]);
});

test.describe("Test Assignment student preview", () => {
  test("grader opens their test submission in read-only student view with hidden staff data filtered", async ({
    page
  }) => {
    const submissionId = staffSubmissions.get("grader");
    if (!submissionId) throw new Error("missing grader test submission");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAsUser(page, grader, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignmentId}/test`);
    await expect(page.getByRole("heading", { name: "Test Assignment", exact: true })).toBeVisible();

    await enterStudentPreview(page, submissionId);
    await expect(page).toHaveURL(
      new RegExp(`/course/${course.id}/assignments/${assignmentId}/submissions/${submissionId}/results`)
    );

    const banner = page.getByRole("alert", { name: "Viewing as student" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Previewing your own submission as a student");
    await expect(page.getByRole("button", { name: "Submission History" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Commit History" })).toHaveCount(0);
    await expect(page.getByText("Student's Due Date:")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Course Settings menu" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /Overall Score/ })).toHaveCount(0);
    await expect(page.getByText("Released to student")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Complete Review/ })).toHaveCount(0);
    await expect(page.getByText("Instructor View")).toHaveCount(0);
    await expect(page.getByText("Hidden staff-only regression")).toHaveCount(0);
    await expect(page.getByText("HIDDEN_STAFF_ONLY_TEST_OUTPUT")).toHaveCount(0);
    await expect(page.getByText("INSTRUCTOR_ONLY_TEST_STDOUT")).toHaveCount(0);
    await expect(page.getByText("HIDDEN_INSTRUCTOR_GRADER_OUTPUT")).toHaveCount(0);
    await expect(page.getByText("UNRELEASED_STAFF_RUBRIC_COMMENT")).toHaveCount(0);

    await expect(page.getByRole("link", { name: "Visible student-facing check", exact: true }).first()).toBeVisible();
    await expect(page.getByText("STUDENT_VISIBLE_TEST_OUTPUT")).toBeVisible();
    await expect(page.getByText("1 hidden test not yet released.")).toBeVisible();
    await page.getByRole("tab", { name: "Output" }).click();
    await expect(page.getByText("STUDENT_VISIBLE_GRADER_OUTPUT")).toBeVisible();
    await expect(page.getByText("HIDDEN_INSTRUCTOR_GRADER_OUTPUT")).toHaveCount(0);
    await page.getByRole("tab", { name: "Test Results" }).click();
    await expect(page.getByRole("region", { name: /Grading Rubric/ })).toBeVisible();

    await visualScreenshot(page, "Test assignment - staff submission viewed as student", {
      stabilizeRubric: "Grading Rubric"
    });

    await banner.getByRole("button", { name: "Exit student view" }).click();
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
    await expect(page).toHaveURL(
      new RegExp(`/course/${course.id}/assignments/${assignmentId}/submissions/${submissionId}/results`)
    );
    await expect(page.getByRole("button", { name: "Commit History" })).toBeVisible();
    await expect(page.getByText("Student's Due Date:")).toBeVisible();
    await expect(page.getByRole("heading", { name: /Overall Score \(/ })).toBeVisible();
    await expect(page.getByText("Instructor View")).toBeVisible();
    await expect(page.getByText("Hidden staff-only regression").first()).toBeVisible();
    await expect(page.getByText("INSTRUCTOR_ONLY_TEST_STDOUT")).toBeVisible();
    await expect(page.getByText("UNRELEASED_STAFF_RUBRIC_COMMENT")).toBeVisible();
  });

  test("instructor test submissions also enter the same student-view banner", async ({ page }) => {
    const submissionId = staffSubmissions.get("instructor");
    if (!submissionId) throw new Error("missing instructor test submission");

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignmentId}/test`);
    await enterStudentPreview(page, submissionId);

    const banner = page.getByRole("alert", { name: "Viewing as student" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Previewing your own submission as a student");
    await expect(page.getByRole("button", { name: "Commit History" })).toHaveCount(0);

    await banner.getByRole("button", { name: "Exit student view" }).click();
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
  });

  // Opening a test submission goes straight to the grading view. It used to enter the student
  // preview, so seeing the grading interface on a real submission meant entering the preview and
  // then exiting it.
  test("opening a test submission lands in the staff grading view, not the student preview", async ({ page }) => {
    const submissionId = staffSubmissions.get("instructor");
    if (!submissionId) throw new Error("missing instructor test submission");

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignmentId}/test`);
    await page.getByRole("link", { name: String(submissionId), exact: true }).click();

    await expect(page).toHaveURL(
      new RegExp(`/course/${course.id}/assignments/${assignmentId}/submissions/${submissionId}`)
    );
    // Staff chrome the student preview hides, so this is the grading view and not a student one.
    await expect(page.getByRole("button", { name: "Commit History" })).toBeVisible();
    await expect(page.getByText("Student's Due Date:")).toBeVisible();
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
    await expectViewAsCookieCleared(page);
  });

  // Issue #883: the student release-date gate on the assignment layout also fired for staff
  // previewing their own test submission, bouncing them to the all-courses dashboard while
  // leaving the view-as cookie set.
  test("instructor previews a test submission on an assignment that is not yet released", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${unreleasedAssignmentId}/test`);
    await expect(page.getByRole("heading", { name: "Test Assignment", exact: true })).toBeVisible();

    await enterStudentPreview(page, unreleasedSubmissionId);

    await expect(page).toHaveURL(
      new RegExp(
        `/course/${course.id}/assignments/${unreleasedAssignmentId}/submissions/${unreleasedSubmissionId}/(results|files|grade)`
      )
    );
    const banner = page.getByRole("alert", { name: "Viewing as student" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Previewing your own submission as a student");

    // Exiting returns the same page under the instructor's own identity.
    await banner.getByRole("button", { name: "Exit student view" }).click();
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
    await expect(page).toHaveURL(
      new RegExp(`/course/${course.id}/assignments/${unreleasedAssignmentId}/submissions/${unreleasedSubmissionId}/`)
    );
  });

  // Issue #892: the preview is the instructor's own staff profile wearing a student's view, so
  // pages keyed on a real `role = 'student'` enrollment — the assignments dashboard RPC, the
  // course-home upcoming panel — had nothing to return for it. Following the student nav out of
  // the previewed assignment reported "No upcoming deadlines available" for a course whose
  // assignments were all released.
  test("leaving the previewed assignment restores the instructor view instead of an empty student list", async ({
    page
  }) => {
    const submissionId = staffSubmissions.get("instructor");
    if (!submissionId) throw new Error("missing instructor test submission");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignmentId}/test`);
    await enterStudentPreview(page, submissionId);
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toBeVisible();
    // The submission page redirects itself to its default tab. A click issued before that settles is
    // lost to the redirect — the banner paints first, so it is not a sufficient gate on its own
    // (this failed on WebKit, where hydration is slower).
    await expectSubmissionTabSettled(page);

    // The preview shows the student nav; its Assignments tab is the page that came back empty.
    // Target the href rather than the accessible name: the nav wraps each link's label in a
    // role="group" element, which zeroes out the link's name-from-content, and both breakpoint
    // copies of the nav are in the DOM at once.
    await page.locator(`a[href="/course/${course.id}/assignments"]`).filter({ visible: true }).first().click();

    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/manage/assignments`));
    // Wait for the cookie to go before asserting the banner's absence. Leaving the preview is
    // finished by the client, so a bare "not visible" check can pass against a page that simply has
    // not hydrated yet — and the next navigation would abort the clearing mid-flight.
    await expectViewAsCookieCleared(page);
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
    await expect(page.getByText("No upcoming deadlines available")).toHaveCount(0);

    // The cookie is cleared on the way out, so returning to the assignment does not silently
    // re-enter the preview.
    await page.goto(`/course/${course.id}/assignments/${assignmentId}/submissions/${submissionId}`);
    await expect(page.getByRole("button", { name: "Commit History" })).toBeVisible();
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
  });

  // The other half of #892: the course-wide student view an instructor actually wants comes from
  // viewing a real enrolled student, launched from the course home rather than from a single
  // student's summary page, which is where the only entry point used to live.
  test("instructor enters a real student's read-only view from the course home", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}`);

    await page.getByRole("button", { name: "View as student" }).click();
    const dialog = page.getByRole("dialog");
    const picker = dialog.getByRole("combobox", { name: "Student to view as" });
    await picker.click();
    await picker.fill(student.private_profile_name);
    await page.getByRole("option", { name: student.private_profile_name }).click();
    await dialog.getByRole("button", { name: "Enter student view" }).click();

    const banner = page.getByRole("alert", { name: "Viewing as student" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(student.private_profile_name);
    // Not the self preview: this identity is a real enrollment.
    await expect(banner).not.toContainText("Previewing your own submission");
    // The launcher hides itself while a view-as is active; the banner owns the exit.
    await expect(page.getByRole("button", { name: "View as student" })).toHaveCount(0);

    // Viewing an enrolled student is course-wide, so the assignments dashboard — the page the self
    // preview could never populate — lists the student's released work.
    await page.locator(`a[href="/course/${course.id}/assignments"]`).filter({ visible: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/course/${course.id}/assignments$`));
    await expect(page.getByRole("link", { name: "Test Assignment Student Preview E2E" })).toBeVisible();
    await expect(page.getByText("No upcoming deadlines available")).toHaveCount(0);
    // The unreleased assignment stays hidden, as it is for the student.
    await expect(page.getByRole("link", { name: "Test Assignment Unreleased Preview E2E" })).toHaveCount(0);

    // Unlike the self preview, this identity is not scoped to one assignment: it survives a course
    // level page. That is the behavior the scoping change could regress.
    await page.goto(`/course/${course.id}/gradebook`);
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toBeVisible();
    await page.goto(`/course/${course.id}`);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(student.private_profile_name);

    await banner.getByRole("button", { name: "Exit student view" }).click();
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
  });

  // The preview is bound to the assignment it was entered from, not to "any assignment": otherwise
  // a deep link or global-search jump to another assignment kept the synthetic identity alive,
  // release-date exemption included, while the banner claimed it covered only one assignment.
  test("the preview does not follow the instructor to a different assignment", async ({ page }) => {
    const submissionId = staffSubmissions.get("instructor");
    if (!submissionId) throw new Error("missing instructor test submission");

    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignmentId}/test`);
    await enterStudentPreview(page, submissionId);
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toBeVisible();
    await expectSubmissionTabSettled(page);

    // A different assignment, reached directly the way a deep link or search hit would.
    await page.goto(`/course/${course.id}/assignments/${unreleasedAssignmentId}`);
    await expectViewAsCookieCleared(page);
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);

    // Returning to the assignment the preview belonged to does not silently resume it either:
    // leaving cleared the cookie.
    await page.goto(`/course/${course.id}/assignments/${assignmentId}/submissions/${submissionId}`);
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Commit History" })).toBeVisible();
  });

  // Leaving the course ends the preview too. The provider also covers /course (the course list), so
  // a soft navigation there leaves `course_id` absent and the scope-cleanup effect can no longer
  // reach the originating cookie — which used to survive and silently resume the preview on return.
  test("leaving the course ends the preview rather than leaving the cookie behind", async ({ page }) => {
    const submissionId = staffSubmissions.get("instructor");
    if (!submissionId) throw new Error("missing instructor test submission");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAsUser(page, instructor, course);
    await page.goto(`/course/${course.id}/manage/assignments/${assignmentId}/test`);
    await enterStudentPreview(page, submissionId);
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toBeVisible();
    await expectSubmissionTabSettled(page);

    // The home link is a soft navigation to /course, keeping this provider mounted.
    await page.locator('a[href="/course"]').filter({ visible: true }).first().click();
    await expectViewAsCookieCleared(page);

    await page.goto(`/course/${course.id}/assignments/${assignmentId}/submissions/${submissionId}`);
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Commit History" })).toBeVisible();
  });
});
