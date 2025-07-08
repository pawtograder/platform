import { test, expect, type Page } from "@playwright/test";
import percySnapshot from "@percy/playwright";
import { createClient } from "@supabase/supabase-js";
import { Database } from "@/utils/supabase/SupabaseTypes";

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

const password = "test";
const test_run_batch = "abcd" + Math.random().toString(36).substring(2, 15);
const workerIndex = process.env.TEST_WORKER_INDEX || "undefined-worker-index";
const student_email = `student-${workerIndex}-${test_run_batch}@pawtograder.net`;
const instructor_email = `instructor-${workerIndex}-${test_run_batch}@pawtograder.net`;
let submission_id: number | undefined;
test.beforeAll(async () => {
  const supabase = createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  //Add a student to the database

  const { data: studentData, error: studentError } = await supabase.auth.admin.createUser({
    email: student_email,
    password: password,
    email_confirm: true
  });
  if (studentError) {
    console.error(studentError);
    throw new Error("Failed to create student user");
  }
  const new_student_uid = studentData?.user?.id;
  const student_private_profile_id = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("user_id", new_student_uid)
    .single();
  if (!student_private_profile_id.data?.private_profile_id) {
    throw new Error("Student private profile id not found");
  }
  const { data: instructorData, error: instructorError } = await supabase.auth.admin.createUser({
    email: instructor_email,
    password: password,
    email_confirm: true
  });
  if (instructorError) {
    console.error(instructorError);
    throw new Error("Failed to create instructor user");
  }
  const new_instructor_uid = instructorData?.user?.id;
  const instructor_private_profile_id = await supabase
    .from("user_roles")
    .select("private_profile_id")
    .eq("user_id", new_instructor_uid)
    .single();
  if (!instructor_private_profile_id.data?.private_profile_id) {
    throw new Error("Instructor private profile id not found");
  }

  //Insert a submission for the student
  const { data: repositoryData, error: repositoryError } = await supabase
    .from("repositories")
    .insert({
      assignment_id: 1,
      repository: `not-actually/repository-${test_run_batch}-${workerIndex}`,
      class_id: 1,
      profile_id: student_private_profile_id.data?.private_profile_id,
      synced_handout_sha: "none"
    })
    .select("id")
    .single();
  if (repositoryError) {
    console.error(repositoryError);
    throw new Error("Failed to create repository");
  }
  const repository_id = repositoryData?.id;
  const { data: checkRunData, error: checkRunError } = await supabase
    .from("repository_check_runs")
    .insert({
      class_id: 1,
      repository_id: repository_id,
      check_run_id: 1,
      status: "{}",
      sha: "none",
      commit_message: "none"
    })
    .select("id")
    .single();
  if (checkRunError) {
    console.error(checkRunError);
    throw new Error("Failed to create check run");
  }
  const check_run_id = checkRunData?.id;
  const { data: submissionData, error: submissionError } = await supabase
    .from("submissions")
    .insert({
      assignment_id: 1,
      profile_id: student_private_profile_id.data?.private_profile_id,
      sha: "none",
      repository: "not-actually/repository",
      run_attempt: 1,
      run_number: 1,
      class_id: 1,
      repository_check_run_id: check_run_id,
      repository_id: repository_id
    })
    .select("id")
    .single();
  if (submissionError) {
    console.error(submissionError);
    throw new Error("Failed to create submission");
  }
  submission_id = submissionData?.id;
  const { error: submissionFileError } = await supabase.from("submission_files").insert({
    name: "sample.java",
    contents: `package com.pawtograder.example.java;

public class Entrypoint {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
    }

  /*
   * This method takes two integers and returns their sum.
   * 
   * @param a the first integer
   * @param b the second integer
   * @return the sum of a and b
   */
  public int doMath(int a, int b) {
      return a+b;
  }

  /**
   * This method returns a message, "Hello, World!"
   * @return
   */
  public String getMessage() {
      
      return "Hello, World!";
  }
}`,
    class_id: 1,
    submission_id: submission_id,
    profile_id: student_private_profile_id.data?.private_profile_id
  });
  if (submissionFileError) {
    console.error(submissionFileError);
    throw new Error("Failed to create submission file");
  }
  const { data: graderResultData, error: graderResultError } = await supabase
    .from("grader_results")
    .insert({
      submission_id: submission_id,
      score: 5,
      class_id: 1,
      profile_id: instructor_private_profile_id.data?.private_profile_id,
      lint_passed: true,
      lint_output: "no lint output",
      lint_output_format: "markdown",
      max_score: 10
    })
    .select("id")
    .single();
  if (graderResultError) {
    console.error(graderResultError);
    throw new Error("Failed to create grader result");
  }
  const { error: graderResultTestError } = await supabase.from("grader_result_tests").insert([
    {
      score: 5,
      max_score: 5,
      name: "test 1",
      name_format: "text",
      output: "here is a bunch of output\n**wow**",
      output_format: "markdown",
      class_id: 1,
      student_id: student_private_profile_id.data?.private_profile_id,
      grader_result_id: graderResultData.id,
      is_released: true
    },
    {
      score: 5,
      max_score: 5,
      name: "test 2",
      name_format: "text",
      output: "here is a bunch of output\n**wow**",
      output_format: "markdown",
      class_id: 1,
      student_id: student_private_profile_id.data?.private_profile_id,
      grader_result_id: graderResultData.id,
      is_released: true
    }
  ]);
  if (graderResultTestError) {
    console.error(graderResultTestError);
    throw new Error("Failed to create grader result test");
  }
});

test.describe("An end-to-end grading workflow self-review to grading", () => {
  test.describe.configure({ mode: "serial" });
  test("Students can submit self-review early", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("textbox", { name: "Sign in email" }).click();
    await page.getByRole("textbox", { name: "Sign in email" }).fill(student_email);
    await page.getByRole("textbox", { name: "Sign in email" }).press("Tab");
    await page.getByRole("textbox", { name: "Sign in password" }).fill(password);
    await page.getByRole("textbox", { name: "Sign in password" }).press("Enter");
    await page.getByRole("button", { name: "Sign in with email" }).click();
    await page.getByRole("link", { name: "Demo Assignment" }).click();

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
    await page.getByRole("textbox", { name: "Add a comment about this line" }).fill("here is a comment");
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
    await page.getByRole("textbox", { name: "Optional: comment on check Self Review Check 2" }).fill("Hi");
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
    await page.goto("/");
    await page.getByRole("textbox", { name: "Sign in email" }).click();
    await page.getByRole("textbox", { name: "Sign in email" }).fill(instructor_email);
    await page.getByRole("textbox", { name: "Sign in password" }).click();
    await page.getByRole("textbox", { name: "Sign in password" }).fill(password);
    await page.getByRole("button", { name: "Sign in with email" }).click();
    await expect(page.getByRole("link", { name: "Demo Assignment" })).toBeVisible();
    await page.goto(`/course/1/assignments/1/submissions/${submission_id}`);
    await page.getByRole("button", { name: "Files" }).click();

    await expect(page.getByLabel("Rubric: Self-Review Rubric")).toContainText(`${student_email} applied today at`);
    await expect(page.getByText("public static void main(")).toBeVisible();
    await percySnapshot(page, "Instructor can view the student's self-review");

    await page.getByText("public static void main(").click({
      button: "right"
    });
    await page.getByRole("option", { name: "Grading Review Check 1 (+10)" }).click();
    await page.getByRole("button", { name: "Add Check" }).waitFor({ state: "visible", timeout: 1000 });
    await page.getByRole("textbox", { name: "Optionally add a comment, or" }).fill("grading comment again");
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
      .fill("grading comment");
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
    await page.goto("/");
    await page.getByRole("textbox", { name: "Sign in email" }).click();
    await page.getByRole("textbox", { name: "Sign in email" }).fill(student_email);
    await page.getByRole("textbox", { name: "Sign in email" }).press("Tab");
    await page.getByRole("textbox", { name: "Sign in password" }).fill(password);
    await page.getByRole("button", { name: "Sign in with email" }).click();
    await page.getByRole("link", { name: "Demo Assignment" }).click();
    await page.getByRole("link", { name: "1", exact: true }).click();

    await page.getByRole("button", { name: "Files" }).click();
    await page.getByText("public int doMath(int a, int").click();

    await expect(page.locator("#rubric-1")).toContainText("Grading Review Criteria 20/20");
    await percySnapshot(page, "Student can view their grading results");

    await expect(page.getByLabel("Rubric: Grading Rubric")).toContainText(`${instructor_email} applied today`);
    await expect(page.locator("body")).toContainText("grading comment again");
  });
});
