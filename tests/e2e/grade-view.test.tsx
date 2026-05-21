import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
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
} from "./TestingUtils";

dotenv.config({ path: ".env.local", quiet: true });

const ASSIGN_TITLE = "Grade View Smoke Assignment";
const APPLIED_COMMENT_TEXT = "Solid solution overall (applied-check marker)";

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;
let submissionId: number;

test.beforeAll(async () => {
  course = await createClass({ name: "E2E Grade View Class" });
  [student, instructor] = await createUsersInClass([
    {
      name: "Grade View Student",
      email: "grade-view-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Grade View Instructor",
      email: "grade-view-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: ASSIGN_TITLE,
    assignment_slug: `e2e-grade-view-${course.id}`
  });

  const sub = await insertPreBakedSubmission({
    student_profile_id: student!.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });
  submissionId = sub.submission_id;

  // Hand-grade and complete the review.
  await gradeSubmission(sub.grading_review_id, instructor!.private_profile_id, true, {
    totalScoreOverride: 85,
    totalAutogradeScoreOverride: 0
  });

  // Insert a deterministic, whole-submission (null target) grading comment so the test can
  // assert it renders as an APPLIED check (regression guard: the section used to mis-label
  // applied checks as "not applied" by filtering out null-target comments).
  const { data: gradingCheck } = await supabase
    .from("rubric_checks")
    .select("id, rubric_criteria!inner(rubric_id)")
    .eq("rubric_criteria.rubric_id", assignment.grading_rubric_id!)
    .limit(1)
    .single();
  const { error: commentError } = await supabase.from("submission_comments").insert({
    submission_id: sub.submission_id,
    author: instructor!.private_profile_id,
    comment: APPLIED_COMMENT_TEXT,
    points: 4,
    class_id: course.id,
    rubric_check_id: gradingCheck!.id,
    submission_review_id: sub.grading_review_id,
    released: true
  });
  expect(commentError).toBeNull();

  // Release the review (and pin the displayed total after the comment's recompute).
  const { error } = await supabase
    .from("submission_reviews")
    .update({ released: true, total_score: 85 })
    .eq("id", sub.grading_review_id);
  expect(error).toBeNull();
});

test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});

test.describe("Student grade view", () => {
  test("renders the grade ledger for a released submission", async ({ page }) => {
    test.setTimeout(120_000);

    // Catch render loops (e.g. the hand-grading section flickering on/off): React throws
    // "Maximum update depth exceeded" when a component setStates without settling — in production
    // builds this surfaces as "Minified React error #185". Match both.
    const updateDepthErrors: string[] = [];
    page.on("console", (msg) => {
      const text = msg.text();
      if (msg.type() === "error" && (text.includes("Maximum update depth exceeded") || text.includes("#185"))) {
        updateDepthErrors.push(text);
      }
    });
    page.on("pageerror", (err) => {
      if (err.message.includes("Maximum update depth exceeded") || err.message.includes("#185")) {
        updateDepthErrors.push(err.message);
      }
    });

    await loginAsUser(page, student!, course);

    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submissionId}/grade`, {
      waitUntil: "domcontentloaded"
    });

    // Ledger header: assignment title + the released total. (The title also appears in the
    // submission layout header, so scope to the first match.)
    await expect(page.getByRole("heading", { name: ASSIGN_TITLE }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("85", { exact: false }).first()).toBeVisible();

    // The hand-grading section renders the APPLIED comment text (only applied rows show the
    // comment body — proves applied checks are not mis-labeled "not applied").
    await expect(page.getByText("Hand grading", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(APPLIED_COMMENT_TEXT, { exact: false })).toBeVisible();

    // The autograder section renders too (pre-baked submissions carry grader results).
    await expect(page.getByRole("heading", { name: "Autograder", exact: true })).toBeVisible();

    // The "Grade" tab is active in the sub-nav.
    await expect(page.getByRole("button", { name: "Grade", exact: true })).toBeVisible();

    // The grading sidebar is dropped on the Grade tab (the ledger replaces it).
    await expect(page.locator("[data-grading-summary-aside]")).toHaveCount(0);

    // No render loop while the page settled.
    expect(updateDepthErrors).toEqual([]);
  });

  test("defaults to the grade tab once the review is released", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAsUser(page, student!, course);

    // Visiting the submission root should redirect to the grade tab when released.
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submissionId}`, {
      waitUntil: "domcontentloaded"
    });
    await expect(page).toHaveURL(/\/grade(\?|#|$)/, { timeout: 30_000 });
  });
});
