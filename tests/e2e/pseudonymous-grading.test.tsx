import { Assignment, Course, RubricCheck, RubricPart } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { type Page } from "@playwright/test";
import { argosScreenshot } from "@argos-ci/playwright";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  TestingUser
} from "./TestingUtils";

dotenv.config({ path: ".env.local" });

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
      email: "pseudonymous-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Pseudonymous Instructor",
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
    await loginAsUser(page, student!, course);
    // Wait for the realtime connection status to be connected
    await expect(
      page.getByRole("note", { name: "Realtime connection status: All realtime connections active" })
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("link").filter({ hasText: "Assignments" }).click();
    await page.waitForURL("**/assignments");
    await expect(page.getByText("Upcoming Assignments")).toBeVisible();

    await page.getByRole("link", { name: assignment!.title }).click();

    await expect(page.getByText("Self Review Notice")).toBeVisible();
    await page.getByRole("button", { name: "Finalize Submission Early" }).click();
    await page.getByRole("button", { name: "Confirm action" }).click();
    await page.getByRole("button", { name: "Complete Self Review" }).click();
    await expect(page.getByText('When you are done, click "Complete Review Assignment".')).toBeVisible();

    // Scroll self-review rubric to top of its container
    await page.getByRole("region", { name: "Self-Review Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });

    await page.getByText("public int doMath(int a, int").click({
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

    await page.getByRole("button", { name: "Complete Review" }).click();
    await page.getByRole("button", { name: "Mark Review Assignment as Complete" }).click();
    await expect(page.getByText("Self-Review Rubric completed")).toBeVisible();
  });

  test("Instructors can grade the submission with pseudonymous mode enabled", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByRole("button", { name: "Files" }).click();

    // Scroll grading rubric to top of its container
    await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });

    await page.getByText("public static void main(").click({
      button: "right"
    });
    await page.getByRole("option", { name: "Grading Review Check 1 (+10)" }).click();
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill(GRADING_REVIEW_COMMENT_1);
    await argosScreenshot(page, "Pseudonymous grading - Instructor adds a grading review check");
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

    await page.getByRole("button", { name: "Complete Review" }).click();
    await page.getByRole("button", { name: "Mark as Complete" }).click();
    await expect(page.getByText("Completed by")).toBeVisible();

    // Release All Submission Reviews
    await page.goto(`/course/${course.id}/manage/assignments/${assignment!.id}`);

    await page.getByRole("button", { name: "Release All Submission Reviews", exact: true }).click();
    await expect(page.getByRole("button", { name: "Release All Submission Reviews", exact: true })).toBeEnabled();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await expect(page.getByText("Released to studentYes")).toBeVisible();
  });

  test("Instructors see their real name in parentheses on grading comments", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const rubricSidebar = page.locator(`#rubric-${assignment!.grading_rubric_id}`);

    // Staff should see both the pseudonym and real name
    // The format should be "Pseudonym (Real Name)"
    await expect(rubricSidebar).toContainText(instructor!.public_profile_name);
    await expect(rubricSidebar).toContainText(`(${instructor!.private_profile_name})`);

    // Scroll grading rubric to top of its container
    await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(100);
    await argosScreenshot(page, "Pseudonymous grading - Instructor sees real name in parentheses");
  });

  test("Students see only the grader's pseudonym, not their real name", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.getByRole("link").filter({ hasText: "Assignments" }).click();
    await page.waitForURL("**/assignments");
    await page.getByRole("link", { name: assignment!.title, exact: true }).click();
    await page.getByRole("link", { name: "1", exact: true }).click();

    await page.getByRole("button", { name: "Files" }).click();
    await page.getByText("public int doMath(int a, int").click();

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
    await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(100);
    await argosScreenshot(page, "Pseudonymous grading - Student sees only pseudonym");
  });

  test("Student can request a regrade and sees grader's pseudonym in responses", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
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

    await expect(region.getByText(REGRADE_REQUEST_COMMENT)).toBeVisible();
    await expect(region.getByText("Submitting your comment...")).not.toBeVisible();
    await argosScreenshot(page, "Pseudonymous grading - Student opens regrade request");
  });

  test("Instructor resolves regrade with pseudonymous profile and adds comment", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const region = page.getByRole("region", { name: "Grading checks on line 4" });

    // Add a comment to the regrade request
    await region.getByPlaceholder("Add a comment to continue the").click();
    await region.getByPlaceholder("Add a comment to continue the").fill(GRADER_REGRADE_RESPONSE);
    await region.getByLabel("Add Comment", { exact: true }).click();

    await expect(region.getByText(GRADER_REGRADE_RESPONSE)).toBeVisible();
    await expect(region.getByText("Submitting your comment...")).not.toBeVisible();

    // Instructor should see their own pseudonym AND real name in their comment
    // The format should be "Pseudonym (Real Name)"
    await expect(region).toContainText(instructor!.public_profile_name);
    await expect(region).toContainText(`(${instructor!.private_profile_name})`);

    await argosScreenshot(page, "Pseudonymous grading - Instructor sees real name in regrade comment");

    // Resolve the regrade request
    await region.getByRole("button", { name: "Resolve Request" }).click();
    await page.getByRole("button", { name: "Resolve with No Change" }).click();
  });

  test("Student sees grader pseudonym (not real name) in regrade response", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const region = page.getByRole("region", { name: "Grading checks on line 4" });

    // Student should see the grader's comment
    await expect(region.getByText(GRADER_REGRADE_RESPONSE)).toBeVisible();

    // Student should see the grader's pseudonym
    await expect(region).toContainText(instructor!.public_profile_name);

    // Student should NOT see the grader's real name
    await expect(region).not.toContainText(`(${instructor!.private_profile_name})`);

    await argosScreenshot(page, "Pseudonymous grading - Student sees only pseudonym in regrade");
  });

  test("Student escalates the regrade request", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const region = page.getByRole("region", { name: "Grading checks on line 4" });

    // Add an escalation comment
    await region.getByPlaceholder("Add a comment to continue the").click();
    await region.getByPlaceholder("Add a comment to continue the").fill(STUDENT_ESCALATION_COMMENT);
    await region.getByLabel("Add Comment", { exact: true }).click();
    await expect(region.getByText(STUDENT_ESCALATION_COMMENT)).toBeVisible();

    // Escalate to instructor
    await region.getByRole("button", { name: "Escalate to Instructor" }).click();
    await page.getByRole("button", { name: "Escalate Request" }).click();

    await argosScreenshot(page, "Pseudonymous grading - Student escalates regrade");
  });

  test("Instructor closes escalated regrade with their REAL identity (not pseudonym)", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);

    const region = page.getByRole("region", { name: "Grading checks on line 4" });

    // Add final decision comment
    await region.getByPlaceholder("Add a comment to continue the").click();
    await region.getByPlaceholder("Add a comment to continue the").fill(INSTRUCTOR_FINAL_DECISION);
    await region.getByLabel("Add Comment", { exact: true }).click();
    await expect(region.getByText(INSTRUCTOR_FINAL_DECISION)).toBeVisible();

    // Close the escalated regrade request
    await region.getByRole("button", { name: "Decide Escalation" }).click();
    await page.getByRole("button", { name: "Uphold Grader's Decision" }).click();

    // Verify the regrade is closed
    await expect(region.getByText("Regrade Closed")).toBeVisible();

    await argosScreenshot(page, "Pseudonymous grading - Instructor closes escalation with real name");
  });

  test("Student sees instructor's REAL name (not pseudonym) for final escalation decision", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
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

    await argosScreenshot(page, "Pseudonymous grading - Student sees instructor real name for final decision");
  });
});
