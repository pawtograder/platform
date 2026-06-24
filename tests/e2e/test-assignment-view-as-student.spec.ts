import { Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "@/tests/global-setup";
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
let assignmentId: number;
const staffSubmissions = new Map<string, number>();

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
  [instructor, grader] = await createUsersInClass([
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
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([instructor, grader]);
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

    await page.getByRole("link", { name: String(submissionId), exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`/course/${course.id}/assignments/${assignmentId}/submissions/${submissionId}/results`)
    );

    const banner = page.getByRole("alert", { name: "Viewing as student" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Test Assignment View Grader");
    await expect(page.getByRole("button", { name: "Submission History" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Commit History" })).toHaveCount(0);
    await expect(page.getByText("Student's Due Date:")).toHaveCount(0);
    await expect(page.getByRole("group").filter({ hasText: "Course Settings" })).toHaveCount(0);
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
    await page.getByRole("link", { name: String(submissionId), exact: true }).click();

    const banner = page.getByRole("alert", { name: "Viewing as student" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Test Assignment View Instructor");
    await expect(page.getByRole("button", { name: "Commit History" })).toHaveCount(0);

    await banner.getByRole("button", { name: "Exit student view" }).click();
    await expect(page.getByRole("alert", { name: "Viewing as student" })).toHaveCount(0);
  });
});
