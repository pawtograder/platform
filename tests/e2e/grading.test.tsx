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
  supabase,
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
let grader: TestingUser | undefined;
let student2: TestingUser | undefined;
let submission_id2: number | undefined;
test.beforeAll(async () => {
  course = await createClass();
  [student, instructor, grader, student2] = await createUsersInClass([
    {
      name: "Grading Student",
      email: "grading-student@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Grading Instructor",
      email: "grading-instructor@pawtograder.net",
      role: "instructor",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Grading Grader",
      email: "grading-grader@pawtograder.net",
      role: "grader",
      class_id: course.id,
      useMagicLink: true
    },
    {
      name: "Grading Student 2",
      email: "grading-student2@pawtograder.net",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Grading Assignment"
  });

  const submission_res = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = submission_res.submission_id;

  const submission_res2 = await insertPreBakedSubmission({
    student_profile_id: student2.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id2 = submission_res2.submission_id;
  // Assign grader to the first rubric part
  const private_profile_id = grader!.private_profile_id;
  const review_assignment_res = await supabase
    .from("review_assignments")
    .insert({
      assignee_profile_id: private_profile_id,
      class_id: course.id,
      assignment_id: assignment!.id,
      submission_id: submission_id2!,
      submission_review_id: submission_res2.grading_review_id!,
      rubric_id: assignment!.grading_rubric_id!,
      due_date: addDays(new Date(), 1).toUTCString()
    })
    .select("id")
    .single();
  if (review_assignment_res.error) {
    console.error(review_assignment_res.error);
    throw new Error(`Failed to create review assignment: ${review_assignment_res.error.message}`);
  }
  await supabase
    .from("review_assignment_rubric_parts")
    .insert({
      review_assignment_id: review_assignment_res.data!.id,
      rubric_part_id: assignment!.rubricParts[2]!.id,
      class_id: course.id
    })
    .select("id");
});

const SELF_REVIEW_COMMENT_1 = "I'm pretty sure this code works, but I'm not betting my grade on it";
const SELF_REVIEW_COMMENT_2 = "This method is so clean it could pass a white glove test";
const GRADING_REVIEW_COMMENT_1 = "Your code is clear and easy to follow—great job on making your logic understandable!";
const GRADING_REVIEW_COMMENT_2 =
  "This is the kind of code that makes grading enjoyable: well-structured and thoughtful work!";
const GRADING_REVIEW_COMMENT_3 = "I have stared at this for a long time, and I am still not sure what to write here.";

const REGRADE_COMMENT = "I think that I deserve better than a 10/10!";
const REGRADE_RESOLUTION = "I do not think it is possible to get more than 10/10!";
const REGRADE_ESCALATION = "But I heard that Ben Bitdiddle got an 11/10!";
const REGRADE_FINAL_COMMENT = "Alright, 11/10 it is then!";

test.describe("An end-to-end grading workflow self-review to grading", () => {
  test.describe.configure({ mode: "serial" });
  test("Students can submit self-review early", async ({ page }) => {
    await loginAsUser(page, student!, course);
    //Wait for the realtime connection status to be connected
    await expect(
      page.getByRole("note", { name: "Realtime connection status: All realtime connections active" })
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("link").filter({ hasText: "Assignments" }).click();
    await expect(page.getByText("Upcoming Assignments")).toBeVisible();

    await page.getByRole("link", { name: assignment!.title }).click();

    await expect(page.getByText("Self Review Notice")).toBeVisible();
    await argosScreenshot(page, "Student can submit self-review early");
    await page.getByRole("button", { name: "Finalize Submission Early" }).click();
    await page.getByRole("button", { name: "Confirm action" }).click();
    await page.getByRole("button", { name: "Complete Self Review" }).click();
    await expect(page.getByText('When you are done, click "Complete Review Assignment".')).toBeVisible();

    //Scroll self-review rubric to top of its container
    await page.getByRole("region", { name: "Self-Review Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });

    await page.getByText("public int doMath(int a, int").click({
      button: "right"
    });

    await page.getByRole("option", { name: "Leave a comment" }).click();

    await page.getByRole("textbox", { name: "Add a comment about this line" }).click();
    await page.getByRole("textbox", { name: "Add a comment about this line" }).fill(SELF_REVIEW_COMMENT_1);
    await argosScreenshot(page, "Adding a comment on the self-review");
    await page.getByRole("button", { name: "Add Comment" }).click();
    await page.getByText("Annotate line 15 with a check:").waitFor({ state: "hidden" });

    await page.getByText('5 System.out.println("Hello,').click({
      button: "right"
    });
    await page.getByRole("option", { name: "Self Review Check 1 (+5)" }).click();
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill("comment");
    await argosScreenshot(page, "Adding a second self-review check");
    await page.getByRole("button", { name: "Add Check" }).click();
    // await clickAddCheckWithRetry(page);
    await page.getByText("Annotate line 5 with a check:").waitFor({ state: "hidden" });

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Self Review Check 2 (+5)"),
      page.getByRole("textbox", { name: "Optional: comment on check Self Review Check 2" })
    );
    //Wait for the add check button to stabilize
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page
      .getByRole("textbox", { name: "Optional: comment on check Self Review Check 2" })
      .fill(SELF_REVIEW_COMMENT_2);
    await argosScreenshot(page, "Adding a global self-review check with a comment");

    await page.getByRole("button", { name: "Add Check" }).click();
    //Wait for the textbox to disappear
    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review" }).click();
    await page.getByRole("button", { name: "Mark Review Assignment as Complete" }).click();
    await expect(page.getByText("Self-Review Rubric completed")).toBeVisible();
    await argosScreenshot(page, "Self-Review Rubric completed");
  });

  test("Instructors can view the student's self-review and create their own grading review", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await page.getByRole("button", { name: "Files" }).click();

    await expect(page.getByLabel("Rubric: Self-Review Rubric")).toContainText(
      `${student!.private_profile_name} applied today at`
    );
    //Make sure that we get a very nice screenshot with a fully-loaded page
    await expect(page.getByText("public static void main(")).toBeVisible();
    await expect(page.getByText("public int doMath(int a, int")).toBeVisible();
    await expect(page.getByText(SELF_REVIEW_COMMENT_1)).toBeVisible();
    await expect(page.getByText(SELF_REVIEW_COMMENT_2)).toBeVisible();
    //Scroll self-review rubric to top of its container
    await page.getByRole("region", { name: "Self-Review Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(100); // Ensure scroll completes before screenshot
    await argosScreenshot(page, "Instructor can view the student's self-review");

    //Scroll grading rubric to top of its container
    await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });

    await page.getByText("public static void main(").click({
      button: "right"
    });
    await page.getByRole("option", { name: "Grading Review Check 1 (+10)" }).click();
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill(GRADING_REVIEW_COMMENT_1);
    await argosScreenshot(page, "Instructor adds a grading review check");
    await page.getByRole("button", { name: "Add Check" }).click();
    // await clickAddCheckWithRetry(page);
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

    //Wait for the textbox to disappear
    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Grading Review Check 3 (+10)"),
      page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" })
    );
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page
      .getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" })
      .fill(GRADING_REVIEW_COMMENT_3);
    await page.getByRole("button", { name: "Add Check" }).click();

    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review" }).click();
    await argosScreenshot(page, "Instructor completes the grading review");
    await page.getByRole("button", { name: "Mark as Complete" }).click();
    await expect(page.getByText("Completed by")).toBeVisible();

    // Release All Submission Reviews
    await page.goto(`/course/${course.id}/manage/assignments/${assignment!.id}`);

    await page.getByRole("button", { name: "Release All Submission Reviews", exact: true }).click();
    await expect(page.getByRole("button", { name: "Release All Submission Reviews", exact: true })).toBeEnabled();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}`);
    await expect(page.getByText("Released to studentYes")).toBeVisible();
  });
  test("Students can view their grading results and request a regrade", async ({ page }) => {
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
    //Scroll grading rubric to top of its container
    await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(100); // Ensure scroll completes before screenshot
    await argosScreenshot(page, "Student can view their grading results");

    await expect(rubricSidebar).toContainText(`${instructor!.private_profile_name} applied today`);
    // Find the region with aria-label 'Grading checks on line 4'
    const region = await page.getByRole("region", { name: "Grading checks on line 4" });
    await expect(region).toBeVisible();
    await region.getByRole("button", { name: "Request regrade for this check" }).click();
    await argosScreenshot(page, "Student can request a regrade");
    await page.getByRole("button", { name: "Draft Regrade Request" }).click();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to open this")
      .click();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to open this")
      .fill(REGRADE_COMMENT);
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByLabel("Open Request", { exact: true })
      .click();
    await expect(region.getByText(REGRADE_COMMENT)).toBeVisible();
    await expect(region.getByText("Submitting your comment...")).not.toBeVisible();
    await argosScreenshot(page, "Student can add a comment to open the regrade request");
  });
  test("Instructors can view the student's regrade request and resolve it", async ({ page }) => {
    await loginAsUser(page, instructor!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .click();
    await argosScreenshot(page, "Instructors can view the regrade request");
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .fill(REGRADE_RESOLUTION);
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByLabel("Add Comment", { exact: true })
      .click();
    await expect(
      page.getByLabel("Grading checks on line 4").filter({ hasText: "I do not think it is possible" })
    ).toBeVisible();
    await expect(page.getByText("Submitting your comment...")).not.toBeVisible();
    await page.getByLabel("Grading checks on line 4").getByRole("button", { name: "Resolve Request" }).click();
    await argosScreenshot(page, "Instructors can resolve the regrade request");
    await page.getByRole("spinbutton").fill("40");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await expect(page.getByText("This is a significant change (>50%)")).toBeVisible();
    await page.getByRole("button", { name: "Override Score and Resolve Request", exact: true }).click();
  });
  test("Students can view the instructor's regrade resolution and appeal it", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .click();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .fill(REGRADE_ESCALATION);
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByLabel("Add Comment", { exact: true })
      .click();
    await page.getByLabel("Grading checks on line 4").getByRole("button", { name: "Appeal to Instructor" }).click();
    await argosScreenshot(page, "Students can appeal their regrade request");
    await page.getByRole("button", { name: "Escalate Request" }).click();
  });
  test("Instructors can view the student's regrade appeal and resolve it", async ({ page }) => {
    const region = await page.getByRole("region", { name: "Grading checks on line 4" });
    await loginAsUser(page, instructor!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id}/files`);
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .click();
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByPlaceholder("Add a comment to continue the")
      .fill(REGRADE_FINAL_COMMENT);
    await argosScreenshot(page, "Instructors can view the student's regrade appeal");
    await page
      .getByRole("region", { name: "Grading checks on line 4" })
      .getByLabel("Add Comment", { exact: true })
      .click();
    await expect(page.getByLabel("Grading checks on line 4").filter({ hasText: REGRADE_FINAL_COMMENT })).toBeVisible();
    await expect(region.getByText("Submitting your comment...")).not.toBeVisible();
    await page.getByLabel("Grading checks on line 4").getByRole("button", { name: "Decide Appeal" }).click();
    await page.getByRole("spinbutton").fill("100");
    await expect(page.getByText("This is a significant change")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Decide Appeal and Close Request" }).click();
    await argosScreenshot(page, "Instructors can close the regrade request");
    await expect(page.getByLabel("Grading checks on line 4").getByRole("heading")).toContainText("Regrade Closed");
  });
  test("Graders assigned to a rubric part see just that rubric part to grade", async ({ page }) => {
    await loginAsUser(page, grader!, course);
    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.goto(`/course/${course.id}/assignments/${assignment!.id}/submissions/${submission_id2}/files`);
    //Scroll grading rubric to top of its container
    await page.getByRole("region", { name: "Grading Rubric" }).evaluate((el) => {
      el.scrollIntoView({ block: "start", behavior: "instant" });
    });
    await page.waitForTimeout(100); // Ensure scroll completes before screenshot
    await expect(page.getByText("(on Grading Review Part 2)")).toBeVisible();
    await expect(page.getByText("Grading Review Part 1")).not.toBeVisible();
    await expect(page.getByRole("button", { name: "View + Grade Full Rubric" })).toBeVisible();
    await argosScreenshot(page, "Graders assigned to a rubric part see just that rubric part to grade");
    await page.getByText("Third check for grading review").click();

    await clickWithTextboxRetry(
      page,
      page.getByLabel("Grading Review Check 3 (+10)"),
      page.getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" })
    );
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page
      .getByRole("textbox", { name: "Optional: comment on check Grading Review Check 3" })
      .fill(GRADING_REVIEW_COMMENT_3);
    await page.getByRole("button", { name: "Add Check" }).click();

    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review Assignment" }).click();
    await page.getByRole("button", { name: "Mark Review Assignment as" }).click();
  });
});
