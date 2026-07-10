import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  TestingUser
} from "./TestingUtils";
import { assertStudentPageAccessible } from "./axeStudentA11y";

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

  // Apply exactly ONE rubric check ourselves (a whole-submission, null-target grading comment),
  // leaving the other student-visible checks un-applied. We don't use gradeSubmission here because
  // it always applies REQUIRED checks (and the fixture's checks are all required), which would
  // leave nothing "not applied" to assert on.
  const { data: gradingCheck } = await supabase
    .from("rubric_checks")
    .select("id, rubric_criteria!inner(rubric_id)")
    .eq("rubric_criteria.rubric_id", assignment.grading_rubric_id!)
    .order("id", { ascending: true })
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

  // Complete + release the review, pinning the displayed total (after the comment's recompute).
  const { error } = await supabase
    .from("submission_reviews")
    .update({
      released: true,
      total_score: 85,
      completed_at: new Date().toISOString(),
      completed_by: instructor!.private_profile_id
    })
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

    // Available rubric checks that are visible but not applied are shown (Grade tab only).
    await expect(page.getByText("Not applied", { exact: true }).first()).toBeVisible();

    // Criteria/check descriptions are shown inline on the grade detail page.
    await expect(page.getByText("Criteria for grading review evaluation", { exact: false }).first()).toBeVisible();

    // The autograder section renders too (pre-baked submissions carry grader results).
    await expect(page.getByRole("heading", { name: "Autograder", exact: true })).toBeVisible();

    // The "Grade" tab is active in the sub-nav.
    await expect(page.getByRole("button", { name: "Grade", exact: true })).toBeVisible();

    // The grading sidebar is dropped on the Grade tab (the ledger replaces it).
    await expect(page.locator("[data-grading-summary-aside]")).toHaveCount(0);

    // Heading hierarchy (WCAG 1.3.1/1.3.2): submission header h1, ledger sections h3,
    // criterion h4, check names h5 — so screen-reader heading navigation walks the
    // grading summary in reading order.
    await expect(page.locator("h1").first()).toContainText(/submission #/i);
    await expect(page.getByRole("heading", { level: 3, name: "Hand grading" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 4 }).first()).toBeVisible();
    await expect(page.getByRole("heading", { level: 5 }).first()).toBeVisible();

    await assertStudentPageAccessible(page, "grade ledger released submission");

    // No render loop while the page settled.
    expect(updateDepthErrors).toEqual([]);
  });

  test("results page anchors land focus on the test heading (WCAG 1.3.2/2.4.3)", async ({ page }) => {
    test.setTimeout(120_000);
    await loginAsUser(page, student!, course);

    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submissionId}/results`, {
      waitUntil: "domcontentloaded"
    });

    await expect(page.getByRole("heading", { level: 2, name: "Test Results" })).toBeVisible({ timeout: 30_000 });

    // Click the first test's summary-table link; the anchor target is the detail card's
    // h3 (tabIndex=-1), so focus must land on the heading — not an unlabeled container.
    const summaryLink = page.locator('a[href^="#test-"]').first();
    await expect(summaryLink).toBeVisible();
    const linkedTestId = (await summaryLink.getAttribute("href"))!.slice(1);
    await summaryLink.click();

    const detailHeading = page.locator(`h3#${linkedTestId}`);
    await expect(detailHeading).toBeVisible();
    await expect(detailHeading).toBeFocused();

    await assertStudentPageAccessible(page, "autograder results detail");
  });

  test("workflow errors are exposed as alerts on the results page (WCAG 3.3.1)", async ({ page }) => {
    test.setTimeout(120_000);

    const errorAssignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Grade View Error Assignment",
      assignment_slug: `e2e-grade-error-${course.id}`
    });
    const errorSub = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: errorAssignment.id,
      class_id: course.id
    });

    // Attach a student-visible workflow error to the submission.
    const { data: repo } = await supabase
      .from("repositories")
      .select("id")
      .eq("repository", errorSub.repository_name)
      .single();
    const { error: insertError } = await supabase.from("workflow_run_error").insert({
      class_id: course.id,
      submission_id: errorSub.submission_id,
      repository_id: repo!.id,
      name: "Autograder configuration mismatch",
      is_private: false
    });
    expect(insertError).toBeNull();

    await loginAsUser(page, student!, course);
    await page.goto(
      `/course/${course.id}/assignments/${errorAssignment.id}/submissions/${errorSub.submission_id}/results`,
      {
        waitUntil: "domcontentloaded"
      }
    );

    // The error surface is a real role="alert" live region announcing the failure.
    const alert = page.getByRole("alert").filter({ hasText: "Submission Error" });
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText("Autograder configuration mismatch");

    await assertStudentPageAccessible(page, "results page with grader error");
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

  test("shows a note for hand grading when released with no applied checks", async ({ page }) => {
    test.setTimeout(120_000);

    const emptyAssignment = await insertAssignment({
      due_date: addDays(new Date(), 1).toUTCString(),
      class_id: course.id,
      name: "Grade View Empty Hand Grading",
      assignment_slug: `e2e-grade-empty-${course.id}`
    });
    const emptySub = await insertPreBakedSubmission({
      student_profile_id: student!.private_profile_id,
      assignment_id: emptyAssignment.id,
      class_id: course.id
    });

    // Make the grading checks hidden-unless-applied and apply none, so nothing is visible for
    // hand grading — then release. The student should see the explanatory note, not an empty void.
    const { error: visError } = await supabase
      .from("rubric_checks")
      .update({ student_visibility: "if_applied" })
      .eq("rubric_id", emptyAssignment.grading_rubric_id!);
    expect(visError).toBeNull();
    const { error: relError } = await supabase
      .from("submission_reviews")
      .update({
        released: true,
        total_score: 0,
        completed_at: new Date().toISOString(),
        completed_by: instructor!.private_profile_id
      })
      .eq("id", emptySub.grading_review_id);
    expect(relError).toBeNull();

    await loginAsUser(page, student!, course);
    await page.goto(
      `/course/${course.id}/assignments/${emptyAssignment.id}/submissions/${emptySub.submission_id}/grade`,
      { waitUntil: "domcontentloaded" }
    );

    await expect(page.getByText("Hand grading", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("No rubric checks were applied to your submission", { exact: false })).toBeVisible();
  });
});
