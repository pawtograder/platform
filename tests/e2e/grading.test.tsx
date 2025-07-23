import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import percySnapshot from "@percy/playwright";
import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import dotenv from "dotenv";
import {
  createClass,
  createUserInClass,
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
let assignment: Assignment | undefined;
test.beforeAll(async () => {
  course = await createClass();
  student = await createUserInClass({ role: "student", class_id: course.id });
  instructor = await createUserInClass({ role: "instructor", class_id: course.id });
  assignment = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id
  });

  const submission_res = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment!.id,
    class_id: course.id
  });
  submission_id = submission_res.submission_id;
});

const SELF_REVIEW_COMMENT_1 = "I'm pretty sure this code works, but I'm not betting my grade on it";
const SELF_REVIEW_COMMENT_2 = "This method is so clean it could pass a white glove test";
const GRADING_REVIEW_COMMENT_1 = "Your code is clear and easy to follow—great job on making your logic understandable!";
const GRADING_REVIEW_COMMENT_2 =
  "This is the kind of code that makes grading enjoyable: well-structured and thoughtful work!";

test.describe("An end-to-end grading workflow self-review to grading", () => {
  test.describe.configure({ mode: "serial" });
  test("Students can submit self-review early", async ({ page }) => {
    await loginAsUser(page, student!, course);
    //Wait for the realtime connection status to be connected
    await expect(
      page.getByRole("note", { name: "Realtime connection status: All realtime connections active" })
    ).toBeVisible();

    await page.getByRole("link").filter({ hasText: "Assignments" }).click();
    await expect(page.getByText("Upcoming Assignments")).toBeVisible();

    await page.getByRole("link", { name: assignment!.title }).click();

    await expect(page.getByText("Self Review Notice")).toBeVisible();
    await percySnapshot(page, "Student can submit self-review early");
    await page.getByRole("button", { name: "Finalize Submission Early" }).click();
    await page.getByRole("button", { name: "Confirm action" }).click();
    await page.getByRole("button", { name: "Complete Self Review" }).click();
    await expect(page.getByText('When you are done, click "Complete Review".')).toBeVisible();
    await page.getByText("public int doMath(int a, int").click({
      button: "right"
    });

    await page.getByRole("option", { name: "Leave a comment" }).click();

    await page.getByRole("textbox", { name: "Add a comment about this line" }).click();
    await page.getByRole("textbox", { name: "Add a comment about this line" }).fill(SELF_REVIEW_COMMENT_1);
    await percySnapshot(page, "Adding a comment on the self-review");
    await page.getByRole("button", { name: "Add Comment" }).click();
    await page.getByText("Annotate line 15 with a check:").waitFor({ state: "hidden" });

    await page.getByText('5 System.out.println("Hello,').click({
      button: "right"
    });
    await page.getByRole("option", { name: "Self Review Check 1 (+5)" }).click();
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill("comment");
    await percySnapshot(page, "Adding a second self-review check");
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
    await percySnapshot(page, "Adding a global self-review check with a comment");

    await page.getByRole("button", { name: "Add Check" }).click();
    //Wait for the textbox to disappear
    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review" }).click();
    await page.getByRole("button", { name: "Mark as Complete" }).click();
    await expect(page.getByText("Self-Review Rubric completed")).toBeVisible();
    await percySnapshot(page, "Self-Review Rubric completed");
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
    await percySnapshot(page, "Instructor can view the student's self-review");

    await page.getByText("public static void main(").click({
      button: "right"
    });
    await page.getByRole("option", { name: "Grading Review Check 1 (+10)" }).click();
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill(GRADING_REVIEW_COMMENT_1);
    await percySnapshot(page, "Instructor adds a grading review check");
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
    // await clickAddCheckWithRetry(page);

    //Wait for the textbox to disappear
    await page.getByRole("textbox", { name: "Optional: comment on check" }).waitFor({ state: "hidden" });

    await page.getByRole("button", { name: "Complete Review" }).click();
    await percySnapshot(page, "Instructor completes the grading review");
    await page.getByRole("button", { name: "Mark as Complete" }).click();
    await expect(page.getByText("Completed by")).toBeVisible();
    await page.getByRole("button", { name: "Release To Student" }).click();
    await expect(page.getByText("Released to studentYes")).toBeVisible();
  });
  test("Students can view their grading results", async ({ page }) => {
    await loginAsUser(page, student!, course);

    await expect(page.getByText("Upcoming Assignments")).toBeVisible();
    await page.getByRole("link").filter({ hasText: "Assignments" }).click();
    await page.getByRole("link", { name: assignment!.title, exact: true }).click();
    await page.getByRole("link", { name: "1", exact: true }).click();

    await page.getByRole("button", { name: "Files" }).click();
    await page.getByText("public int doMath(int a, int").click();

    await expect(page.locator(`#rubric-${assignment!.grading_rubric_id}`)).toContainText(
      "Grading Review Criteria 20/20"
    );
    await expect(page.locator(`#rubric-${assignment!.grading_rubric_id}`)).toContainText(GRADING_REVIEW_COMMENT_1);
    await expect(page.locator(`#rubric-${assignment!.grading_rubric_id}`)).toContainText(GRADING_REVIEW_COMMENT_2);
    await percySnapshot(page, "Student can view their grading results");

    await expect(page.getByLabel("Rubric: Grading Rubric")).toContainText(
      `${instructor!.private_profile_name} applied today`
    );
  });

});
