import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { type Page } from "@playwright/test";
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
import { stabilizeRubricSidebar, visualScreenshot } from "./VisualTestUtils";

dotenv.config({ path: ".env.local", quiet: true });

// Helper function to retry clicks that should make textboxes appear
async function clickWithTextboxRetry(
  page: Page,
  clickTarget: ReturnType<Page["getByLabel"]>,
  textboxSelector: ReturnType<Page["getByRole"]>,
  maxRetries = 3
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await clickTarget.click();

    try {
      // Wait for textbox to appear within 300ms
      await textboxSelector.waitFor({ state: "visible", timeout: 300 });
      return; // Success - textbox appeared
    } catch {
      if (attempt === maxRetries) {
        throw new Error(`Textbox did not appear after ${maxRetries} attempts`);
      }
      // Wait a bit before retrying
      await page.waitForTimeout(100);
    }
  }
}

let course: Course;
let student: TestingUser | undefined;
let instructor: TestingUser | undefined;
let submission_id: number | undefined;
let assignment: (Assignment & { rubricParts: RubricPart[]; rubricChecks: RubricCheck[] }) | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student, instructor] = await createUsersInClass([
    {
      name: "Pseudonymous Student",
      public_profile_name: "Pseudonymous Student Alias",
      email: "pseudonymous-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Pseudonymous Instructor",
      public_profile_name: "Pseudonymous Instructor Alias",
      email: "pseudonymous-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    }
  ]);

  // Create assignment with pseudonymous grading enabled
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Pseudonymous Grading Assignment",
    grader_pseudonymous_mode: true
  });

  const submission_res = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = submission_res.submission_id;
});
test.afterEach(async ({ logMagicLinksOnFailure }) => {
  await logMagicLinksOnFailure([student, instructor]);
});
const SELF_REVIEW_COMMENT = "This is my self-review comment for pseudonymous grading test";
const GRADING_REVIEW_COMMENT_1 = "Great work on this implementation! - Pseudonymous grading test";
const GRADING_REVIEW_COMMENT_2 = "Excellent code quality - Pseudonymous grading test";

// Regrade request comments
const REGRADE_REQUEST_COMMENT = "I believe my work deserves more points because of the detailed implementation.";
const GRADER_REGRADE_RESPONSE = "I reviewed your submission again. The points are fair based on the rubric criteria.";
const STUDENT_ESCALATION_COMMENT = "I still disagree. Please have an instructor review this.";
const INSTRUCTOR_FINAL_DECISION = "After careful review, I agree the original grading was appropriate.";

test.describe("Pseudonymous grading - graders appear as pseudonyms to students", () => {
  test.describe.configure({ mode: "serial" });

  test("Students can submit self-review", async ({ page }) => {
    // This test does a lot inside the default 60s budget: magic-link login, finalize
    // submission early, a DB-truth poll that can legitimately spend up to 30s waiting
    // for the self-review review_assignments row to materialize (see toPass below),
    // then ~6 right-click annotation/check interactions and an axe scan. Under webkit
    // CI load the poll can eat most of the budget, leaving the annotation steps to tip
    // the cumulative runtime past 60s mid-interaction (observed: click on the
    // "Add a comment about this line" textbox timing out the whole test). This isn't a
    // race to paper over — the work is genuinely long — so give it the same headroom
    // the equally-heavy grading test below already uses. Because this is the first test
    // in a serial describe, its timeout flaking forces a retry of the entire group.
    test.slow();
    await loginAsUser(page, student!, course);
    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.locator("#primary-nav").getByRole("link").filter({ hasText: "Assignments" }).click();
    await page.waitForURL("**/assignments");
    await page.getByRole("link", { name: assignment!.title }).click();

    await expect(page.getByText("Self Review Notice")).toBeVisible();
    await page.getByRole("button", { name: "Finalize Submission Early" }).click();
    await page.getByRole("button", { name: "Confirm action" }).click();
    // The "Submission finalized" toast is the application's explicit signal
    // that finalize_submission_early completed and reviewAssignments has
    // refetched (see finalizeSubmissionEarly.tsx). Without it the next
    // assertion races the "Complete Self Review" button into existence.
    // Visual-test mode removes toasts from layout before screenshots, so the
    // explicit app signal is attachment rather than visibility.
    await expect(page.getByText("Submission finalized").first()).toBeAttached();
    // Even after the toast appears, the "Complete Self Review" button only
    // renders once useMyReviewAssignments() observes the new row AND
    // useRubric("self-review") returns the matching rubric (see
    // components/ui/self-review-notice.tsx). Under webkit CI load we have
    // observed both inputs lag behind the toast: the toast's setState
    // commits in the same React batch as refetchAll's listener-fired
    // setStates, but the realtime UPDATE that delivers the new
    // review_assignment row to *other* tabs/clients can race the
    // server-direct refetch — and webkit's microtask scheduling for
    // multiple-controller cascades sometimes leaves myReviewAssignments
    // empty in DOM for several frames after the toast is visible. Gate the
    // click on the DB truth: poll review_assignments with the service-role
    // supabase client until the new self-review row exists for THIS
    // student + submission. This is a tight signal (DB == truth) that
    // doesn't depend on React rendering ordering.
    await expect(async () => {
      const { data: selfReviewRubric } = await supabase
        .from("rubrics")
        .select("id")
        .eq("assignment_id", assignment!.id)
        .eq("review_round", "self-review")
        .single();
      expect(selfReviewRubric?.id).toBeTruthy();
      const { data: ra } = await supabase
        .from("review_assignments")
        .select("id, rubric_id, assignee_profile_id, submission_id")
        .eq("submission_id", submission_id!)
        .eq("assignee_profile_id", student!.private_profile_id)
        .eq("rubric_id", selfReviewRubric!.id);
      expect(ra?.length ?? 0).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000, intervals: [250, 500, 1000] });
    await page.getByRole("button", { name: "Complete Self Review" }).click();
    await expect(page.getByText('When you are done, click "Complete Review Assignment".')).toBeVisible();

    // Scroll self-review rubric to top of its container
    await page.getByRole("region", { name: "Self-Review Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });

    const doMathLineSelfReview = page.getByText("public int doMath(int a, int");
    // Same out-of-viewport hazard as the grading-review test below: ensure the line is
    // scrolled into view before the right-click so the context menu opens deterministically.
    await doMathLineSelfReview.scrollIntoViewIfNeeded();
    await doMathLineSelfReview.click({
      button: "right"
    });

    await page.getByRole("option", { name: "Leave a comment" }).click();

    await page.getByRole("textbox", { name: "Add a comment about this line" }).click();
    await page.getByRole("textbox", { name: "Add a comment about this line" }).fill(SELF_REVIEW_COMMENT);
    await page.getByRole("button", { name: "Add Comment" }).click();
    await page.getByText("Annotate line 15 with a check:").waitFor({ state: "hidden" });

    await page.getByText('5 System.out.println("Hello,').click({
      button: "right"
    });
    await page.getByRole("option", { name: "Self Review Check 1 (+5)" }).click();
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill("comment");
    await page.getByRole("button", { name: "Add Check" }).click();
    await page.getByText("Annotate line 5 with a check:").waitFor({ state: "hidden" });

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Self Review Check 2 (+5)"),
      page.getByRole("textbox", { name: "Optional: comment on check Self Review Check 2" })
    );
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page.getByRole("textbox", { name: "Optional: comment on check Self Review Check 2" }).fill("Done");
    await page.getByRole("button", { name: "Add Check" }).click();
    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review" }).first().click();
    await page.getByRole("button", { name: "Mark Review Assignment as Complete" }).click();
    await expect(page.getByText("Self-Review Rubric completed")).toBeVisible();
    await assertStudentPageAccessible(page, "pseudonymous self-review completed");
  });

  test("Instructors can grade the submission with pseudonymous mode enabled", async ({ page }) => {
    // Login + submission nav + file render + two grading-check flows + screenshots.
    // Under CI contention this can exceed the 60s default (notably the file content
    // taking longer to render before the right-click below), so allow headroom.
    test.slow();
    await loginAsUser(page, instructor!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByRole("button", { name: "Files" }).click();

    // Scroll grading rubric to top of its container
    await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });

    // Wait for the submission's source to render before right-clicking it — under load
    // the file view can lag, and clicking a not-yet-rendered line otherwise burns the
    // whole-test budget on the click's actionability wait.
    const codeLine = page.getByText("public static void main(");
    await expect(codeLine).toBeVisible({ timeout: 30_000 });
    await codeLine.click({
      button: "right"
    });
    await page.getByRole("option", { name: "Grading Review Check 1 (+10)" }).click();
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill(GRADING_REVIEW_COMMENT_1);
    await visualScreenshot(page, "Pseudonymous grading - Instructor adds a grading review check", {
      stabilizeRubric: "Grading Rubric"
    });
    await page.getByRole("button", { name: "Add Check" }).click();
    await page.getByText("Annotate line 4 with a check:").waitFor({ state: "hidden" });

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Grading Review Check 2 (+10)"),
      page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 2" })
    );
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page
      .getByRole("textbox", { name: "Optional: comment on check Grading Review Check 2" })
      .fill(GRADING_REVIEW_COMMENT_2);
    await page.getByRole("button", { name: "Add Check" }).click();

    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Grading Review Check 3 (+10)"),
      page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" })
    );
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" }).fill("Good!");
    await page.getByRole("button", { name: "Add Check" }).click();

    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review" }).first().click();
    await page.getByRole("button", { name: "Complete", exact: true }).click();
    await expect(page.getByText("Completed by")).toBeVisible();

    // Release selected submission reviews (select all in filtered view, then release)
    await page.goto(`/course/${course.id}/manage/assignments/${assignment!.id}`);

    await page.getByRole("button", { name: "All in view" }).click();
    const releaseBtn = page.getByRole("button", { name: /Release \d+ selected submission/ });
    await expect(releaseBtn).toBeEnabled();
    await releaseBtn.click();
    // Wait for the release to land in the DB before navigating to the
    // submission page. On webkit the SSR'd submission page sometimes paints
    // before the released flag has propagated, leading to the badge showing
    // "No" indefinitely (mirrors grading.test.tsx's release polling).
    await expect(async () => {
      const { data } = await supabase
        .from("submission_reviews")
        .select("released")
        .eq("submission_id", submission_id!)
        .eq("released", true);
      expect(data?.length ?? 0).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await expect(page.getByText("Released to studentYes")).toBeVisible({ timeout: 30_000 });
  });

  test("Instructors see their real name in parentheses on grading comments", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const rubricSidebar = page.locator(`#rubric-${assignment!.grading_rubric_id}`);

    // Staff should see both the pseudonym and real name
    // The format should be "Pseudonym (Real Name)"
    await expect(rubricSidebar).toContainText(instructor!.public_profile_name);
    await expect(rubricSidebar).toContainText(`(${instructor!.private_profile_name})`);

    // Scroll grading rubric to top of its container
    await stabilizeRubricSidebar(page, "Grading Rubric");
    await visualScreenshot(page, "Pseudonymous grading - Instructor sees real name in parentheses", {
      stabilizeRubric: "Grading Rubric"
    });
  });

  test("Students see only the grader's pseudonym, not their real name", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.locator("#primary-nav").getByRole("link").filter({ hasText: "Assignments" }).click();
    await page.waitForURL("**/assignments");
    await page.getByRole("link", { name: assignment!.title, exact: true }).click();
    await page.getByRole("link", { name: "1", exact: true }).click();

    await page.getByRole("button", { name: "Files" }).click();
    const doMathLine = page.getByText("public int doMath(int a, int");
    await expect(doMathLine).toBeVisible();
    // toBeVisible() only requires a non-empty bounding box, not that the element is in
    // the viewport — in a long code file this line frequently renders below the fold.
    // click({ force: true }) skips actionability checks but STILL needs the element in
    // the viewport to resolve click coordinates, so it intermittently failed with
    // "Element is outside of the viewport". Scroll it into view first so the (forced)
    // click is deterministic regardless of where the file's scroll position settles.
    await doMathLine.scrollIntoViewIfNeeded();
    await doMathLine.click({ force: true });

    const rubricSidebar = page.locator(`#rubric-${assignment!.grading_rubric_id}`);
    await expect(rubricSidebar).toContainText("Grading Review Criteria 20/20");
    await expect(rubricSidebar).toContainText(GRADING_REVIEW_COMMENT_1);
    await expect(rubricSidebar).toContainText(GRADING_REVIEW_COMMENT_2);

    // Students should see the grader's pseudonym (public profile name)
    await expect(rubricSidebar).toContainText(instructor!.public_profile_name);

    // Students should NOT see the grader's real name (private profile name)
    // Note: We check that the real name is not visible in parentheses
    await expect(rubricSidebar).not.toContainText(`(${instructor!.private_profile_name})`);

    // Scroll grading rubric to top of its container
    await stabilizeRubricSidebar(page, "Grading Rubric");
    await visualScreenshot(page, "Pseudonymous grading - Student sees only pseudonym", {
      stabilizeRubric: "Grading Rubric"
    });
    await assertStudentPageAccessible(page, "pseudonymous student grading view");
  });

  test("Student can request a regrade and sees grader's pseudonym in responses", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    // Find the region with aria-label 'Grading checks on line 4' and request a regrade
    const region = page.getByRole("region", { name: "Grading checks on line 4" });
    await expect(region).toBeVisible();
    await region.getByRole("button", { name: "Request regrade for this check" }).click();
    await page.getByRole("button", { name: "Draft Regrade Request" }).click();

    // Add comment and open the regrade request
    await region.getByPlaceholder("Add a comment to open this").click();
    await region.getByPlaceholder("Add a comment to open this").fill(REGRADE_REQUEST_COMMENT);
    await region.getByLabel("Open Request", { exact: true }).click();

    await expect(region.getByText(REGRADE_REQUEST_COMMENT).first()).toBeVisible();
    await expect(region.getByText("Submitting your comment...")).not.toBeVisible();
    await visualScreenshot(page, "Pseudonymous grading - Student opens regrade request", {
      stabilizeRubric: "Grading Rubric"
    });
    await assertStudentPageAccessible(page, "pseudonymous regrade request opened");
  });

  test("Instructor resolves regrade with pseudonymous profile and adds comment", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const region = page.getByRole("region", { name: "Grading checks on line 4" });

    // Add a comment to the regrade request
    await region.getByPlaceholder("Add a comment to continue the").click();
    await region.getByPlaceholder("Add a comment to continue the").fill(GRADER_REGRADE_RESPONSE);
    await region.getByLabel("Add Comment", { exact: true }).click();

    await expect(region.getByText("Submitting your comment...")).not.toBeVisible();
    await expect(region.getByText(GRADER_REGRADE_RESPONSE).first()).toBeVisible();

    // Instructor should see their own pseudonym AND real name in their comment
    // The format should be "Pseudonym (Real Name)"
    await expect(region).toContainText(instructor!.public_profile_name);
    await expect(region).toContainText(`(${instructor!.private_profile_name})`);

    await visualScreenshot(page, "Pseudonymous grading - Instructor sees real name in regrade comment", {
      stabilizeRubric: "Grading Rubric"
    });

    // Resolve the regrade request
    await region.getByRole("button", { name: "Resolve Request" }).click();
    await page.getByRole("button", { name: "Resolve regrade request" }).click();
  });

  test("Student sees grader pseudonym (not real name) in regrade response", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const region = page.getByRole("region", { name: "Grading checks on line 4" });

    // Student should see the grader's comment
    await expect(region.getByText(GRADER_REGRADE_RESPONSE)).toBeVisible();

    // Student should see the grader's pseudonym
    await expect(region).toContainText(instructor!.public_profile_name);

    // Student should NOT see the grader's real name
    await expect(region).not.toContainText(`(${instructor!.private_profile_name})`);

    await visualScreenshot(page, "Pseudonymous grading - Student sees only pseudonym in regrade", {
      stabilizeRubric: "Grading Rubric"
    });
    await assertStudentPageAccessible(page, "pseudonymous grading - student regrade response /files");
  });

  test("Student escalates the regrade request", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const region = page.getByRole("region", { name: "Grading checks on line 4" });

    // Add an escalation comment
    await region.getByPlaceholder("Add a comment to continue the").click();
    await region.getByPlaceholder("Add a comment to continue the").fill(STUDENT_ESCALATION_COMMENT);
    await region.getByLabel("Add Comment", { exact: true }).click();

    // Escalate to instructor
    await region.getByRole("button", { name: "Escalate to Instructor" }).click();
    await page.getByRole("button", { name: "Escalate Request" }).click();

    // Wait for the escalation popover/button to close before axe so the scan
    // doesn't race the in-flight focus-trap teardown (same pattern as the
    // grading.test.tsx escalation scan).
    await expect(
      page.getByRole("button", { name: "Escalate Request" }),
      "Escalate Request button is removed after escalation"
    ).toHaveCount(0);
    await visualScreenshot(page, "Pseudonymous grading - Student escalates regrade", {
      stabilizeRubric: "Grading Rubric"
    });
    await assertStudentPageAccessible(page, "pseudonymous grading - student escalation /files");
  });

  test("Instructor closes escalated regrade with their REAL identity (not pseudonym)", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const region = page.getByRole("region", { name: "Grading checks on line 4" });

    // Add final decision comment
    await region.getByPlaceholder("Add a comment to continue the").click();
    await region.getByPlaceholder("Add a comment to continue the").fill(INSTRUCTOR_FINAL_DECISION);
    await region.getByLabel("Add Comment", { exact: true }).click();
    await expect(region.getByText("Submitting your comment...")).not.toBeVisible();
    await expect(region.getByText(INSTRUCTOR_FINAL_DECISION)).toBeVisible();

    // Close the escalated regrade request
    await region.getByRole("button", { name: "Decide Escalation" }).click();
    await page.getByRole("button", { name: "Close regrade request" }).click();

    // Verify the regrade is closed
    await expect(region.getByText("Regrade Closed")).toBeVisible();

    await visualScreenshot(page, "Pseudonymous grading - Instructor closes escalation with real name", {
      stabilizeRubric: "Grading Rubric"
    });
  });

  test("Student sees instructor's REAL name (not pseudonym) for final escalation decision", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByRole("heading", { name: /Upcoming Assignments|Assignment Grading Overview/ })).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const region = page.getByRole("region", { name: "Grading checks on line 4" });

    // Verify the regrade is closed
    await expect(region.getByText("Regrade Closed")).toBeVisible();

    // The final decision (closed_by) should show the instructor's REAL name
    // This is because instructors sign final decisions with their real identity
    await expect(region).toContainText(`Closed`);
    await expect(region).toContainText(instructor!.private_profile_name);

    // The earlier grader comments should still show pseudonym (not real name in parentheses)
    // But the instructor's comment should also be there (with pseudonym for the comment author)
    await expect(region.getByText(GRADER_REGRADE_RESPONSE)).toBeVisible();
    await expect(region.getByText(INSTRUCTOR_FINAL_DECISION)).toBeVisible();

    await visualScreenshot(page, "Pseudonymous grading - Student sees instructor real name for final decision", {
      stabilizeRubric: "Grading Rubric"
    });
    await assertStudentPageAccessible(page, "pseudonymous regrade closed student view");
  });
});
