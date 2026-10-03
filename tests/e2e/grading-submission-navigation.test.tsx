/**
 * Grading many submissions in a row: who a submission is assigned to, moving between submissions
 * without losing the tab, completing and moving on, and the Survey tab as the landing page for
 * survey-only assignments.
 */
import { test, expect } from "../global-setup";
import type { Page } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase,
  type TestingUser
} from "./TestingUtils";
import { SUBMISSION_SURVEY_JSON } from "./surveySubmissionSeeding";

type Course = Awaited<ReturnType<typeof createClass>>;
type AssignmentWithRubric = Awaited<ReturnType<typeof insertAssignment>>;
type SeededSubmission = { submission_id: number; grading_review_id: number };

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

test.describe("Grading several submissions in a row", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(180_000);

  let course: Course;
  let students: TestingUser[];
  let instructor: TestingUser;
  let gary: TestingUser; // has review assignments
  let grace: TestingUser; // has none on the code assignment
  let codeAssignment: AssignmentWithRubric;
  let surveyAssignment: AssignmentWithRubric;
  const codeSubs: SeededSubmission[] = [];
  const surveySubs: SeededSubmission[] = [];
  const garyCodeReviews: number[] = [];
  const garySurveyReviews: number[] = [];

  async function assignReview(assignee: TestingUser, assignment: AssignmentWithRubric, sub: SeededSubmission) {
    const { data, error } = await supabase
      .from("review_assignments")
      .insert({
        assignee_profile_id: assignee.private_profile_id,
        class_id: course.id,
        assignment_id: assignment.id,
        submission_id: sub.submission_id,
        submission_review_id: sub.grading_review_id,
        rubric_id: assignment.grading_rubric_id!,
        due_date: addDays(new Date(), 3).toISOString()
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return data.id;
  }

  /** The seeded grading checks are all required; relax them so completing is a single click. */
  async function relaxGradingChecks(assignment: AssignmentWithRubric) {
    const ids = assignment.rubricChecks.filter((c) => c.rubric_id === assignment.grading_rubric_id).map((c) => c.id);
    const { error } = await supabase.from("rubric_checks").update({ is_required: false }).in("id", ids);
    if (error) throw new Error(error.message);
  }

  const panel = (page: Page) => page.getByTestId("submission-review-assignments").filter({ visible: true }).first();
  const subUrl = (assignment: AssignmentWithRubric, sub: SeededSubmission, tab = "") =>
    `/course/${course.id}/assignments/${assignment.id}/submissions/${sub.submission_id}${tab}`;

  test.beforeAll(async () => {
    course = await createClass({ name: "E2E Grading Navigation" });
    const users = await createUsersInClass([
      ...["Ada Lovelace", "Alan Turing", "Grace Hopper", "Ken Thompson"].map((name, i) => ({
        role: "student" as const,
        class_id: course.id,
        name,
        email: `grading-nav-student-${i}-${course.id}@pawtograder.net`,
        useMagicLink: true
      })),
      {
        role: "instructor",
        class_id: course.id,
        name: "Ingrid Instructor",
        email: `grading-nav-instructor-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "grader",
        class_id: course.id,
        name: "Gary Grader",
        email: `grading-nav-gary-${course.id}@pawtograder.net`,
        useMagicLink: true
      },
      {
        role: "grader",
        class_id: course.id,
        name: "Grace Unassigned",
        email: `grading-nav-grace-${course.id}@pawtograder.net`,
        useMagicLink: true
      }
    ]);
    students = users.slice(0, 4);
    [instructor, gary, grace] = users.slice(4);

    codeAssignment = await insertAssignment({
      due_date: addDays(new Date(), -1).toISOString(),
      class_id: course.id,
      name: "Navigation Code Assignment",
      assignment_slug: `grading-nav-code-${course.id}`
    });
    await relaxGradingChecks(codeAssignment);
    for (const s of students) {
      const r = await insertPreBakedSubmission({
        student_profile_id: s.private_profile_id,
        assignment_id: codeAssignment.id,
        class_id: course.id
      });
      codeSubs.push({ submission_id: r.submission_id, grading_review_id: r.grading_review_id! });
    }
    // Gary grades the first three; the fourth is nobody's.
    for (const sub of codeSubs.slice(0, 3)) garyCodeReviews.push(await assignReview(gary, codeAssignment, sub));

    surveyAssignment = await insertAssignment({
      due_date: addDays(new Date(), -1).toISOString(),
      class_id: course.id,
      name: "Navigation Survey Assignment",
      assignment_slug: `grading-nav-survey-${course.id}`,
      repo_mode: "no_submission"
    });
    const { data: survey, error: surveyError } = await supabase
      .from("surveys")
      .insert({
        class_id: course.id,
        created_by: instructor.public_profile_id,
        assignment_id: surveyAssignment.id,
        assigned_to_all: true,
        allow_response_editing: false,
        json: SUBMISSION_SURVEY_JSON,
        version: 1,
        status: "published",
        title: "Navigation Reflection",
        description: "Reflection",
        due_date: addDays(new Date(), -1).toISOString()
      })
      .select("id")
      .single();
    if (surveyError) throw new Error(surveyError.message);
    const { error: responseError } = await supabase.from("survey_responses").insert(
      students.map((s) => ({
        survey_id: survey.id,
        profile_id: s.private_profile_id,
        response: { teamwork: `Reflection from ${s.private_profile_name}`, load: 3 },
        is_submitted: true,
        submitted_at: addDays(new Date(), -2).toISOString()
      }))
    );
    if (responseError) throw new Error(responseError.message);
    for (const s of students.slice(0, 2)) {
      const r = await insertPreBakedSubmission({
        student_profile_id: s.private_profile_id,
        assignment_id: surveyAssignment.id,
        class_id: course.id
      });
      surveySubs.push({ submission_id: r.submission_id, grading_review_id: r.grading_review_id! });
    }
    for (const sub of surveySubs) garySurveyReviews.push(await assignReview(gary, surveyAssignment, sub));
  });

  test.afterEach(async ({ logMagicLinksOnFailure }) => {
    await logMagicLinksOnFailure([gary, grace, instructor]);
  });

  test("the assigned grader sees their own name, never a profile id", async ({ page }) => {
    await loginAsUser(page, gary, course);
    await page.goto(subUrl(codeAssignment, codeSubs[0]!, `/files?review_assignment_id=${garyCodeReviews[0]}`));
    await expect(panel(page)).toContainText("Gary Grader (you)");
    await expect(panel(page)).not.toContainText(UUID_RE);
  });

  test("a grader with nothing assigned is told so, without seeing other graders' assignments", async ({ page }) => {
    await loginAsUser(page, grace, course);
    await page.goto(subUrl(codeAssignment, codeSubs[1]!, "/files"));
    await expect(panel(page)).toContainText("Not assigned to you");
    await expect(panel(page)).not.toContainText("Gary Grader");
  });

  test("an instructor sees who each submission is assigned to", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    await page.goto(subUrl(codeAssignment, codeSubs[1]!, "/files"));
    await expect(panel(page)).toContainText("Gary Grader");
    await expect(panel(page)).not.toContainText(UUID_RE);

    await page.goto(subUrl(codeAssignment, codeSubs[3]!, "/files"));
    await expect(panel(page)).toContainText("Not assigned to anyone");
  });

  test("Next Incomplete and Previous keep the tab the grader is on", async ({ page }) => {
    await loginAsUser(page, gary, course);
    await page.goto(subUrl(codeAssignment, codeSubs[0]!, `/results?review_assignment_id=${garyCodeReviews[0]}`));
    await expect(panel(page)).toBeVisible();

    await page.getByRole("link", { name: /Next Incomplete/ }).click();
    await expect(page).toHaveURL(
      new RegExp(`/submissions/${codeSubs[1]!.submission_id}/results\\?review_assignment_id=${garyCodeReviews[1]}$`)
    );

    await page.getByRole("link", { name: "Previous", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/submissions/${codeSubs[0]!.submission_id}/results`));
  });

  test("completing a review assignment opens the next one on the same tab", async ({ page }) => {
    await loginAsUser(page, gary, course);
    await page.goto(subUrl(codeAssignment, codeSubs[0]!, `/results?review_assignment_id=${garyCodeReviews[0]}`));
    await expect(panel(page)).toBeVisible();

    // One completion control: while working an assignment, the sidebar's submission-level button is gone.
    await expect(page.getByRole("heading", { name: "Submission Review Actions" })).toHaveCount(0);

    await page.getByRole("button", { name: "Complete Review Assignment" }).first().click();
    await page.getByRole("button", { name: "Mark Review Assignment as Complete" }).click();
    await expect(page).toHaveURL(new RegExp(`/submissions/${codeSubs[1]!.submission_id}/results`));

    await expect(async () => {
      const { data } = await supabase
        .from("review_assignments")
        .select("completed_at")
        .eq("id", garyCodeReviews[0]!)
        .single();
      expect(data?.completed_at).not.toBeNull();
    }).toPass({ timeout: 15_000 });

    // Previous goes back to the one just finished, which now reads as complete.
    await page.getByRole("link", { name: "Previous", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/submissions/${codeSubs[0]!.submission_id}/results`));
    await expect(panel(page)).toContainText("Complete");
  });

  test("survey-only assignments open on the Survey tab, and stay there from one submission to the next", async ({
    page
  }) => {
    await loginAsUser(page, gary, course);
    await page.goto(subUrl(surveyAssignment, surveySubs[0]!, `?review_assignment_id=${garySurveyReviews[0]}`));
    await expect(page).toHaveURL(/\/survey(\?|$)/, { timeout: 20_000 });
    await expect(page.getByTestId("submission-survey-panel").filter({ visible: true }).first()).toBeVisible();

    await page.getByRole("link", { name: /Next Incomplete/ }).click();
    await expect(page).toHaveURL(new RegExp(`/submissions/${surveySubs[1]!.submission_id}/survey`));

    // A grader who picks Grade keeps it: an explicit /grade is never redirected to Survey.
    await page.getByRole("link", { name: "Grade", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/submissions/${surveySubs[1]!.submission_id}/grade`));
    await page.getByRole("link", { name: "Previous", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/submissions/${surveySubs[0]!.submission_id}/grade`));
  });

  test("an instructor without assignments steps through submissions in picker order", async ({ page }) => {
    await loginAsUser(page, instructor, course);
    // Picker order is by student name: Ada, Alan, Grace, Ken.
    await page.goto(subUrl(codeAssignment, codeSubs[0]!, "/files"));
    await expect(panel(page)).toBeVisible();
    await page.getByRole("link", { name: "Next", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/submissions/${codeSubs[1]!.submission_id}/files$`));
  });
});
