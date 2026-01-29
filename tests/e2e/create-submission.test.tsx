import { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import { test, expect } from "../global-setup";
import { addDays, addMinutes } from "date-fns";
import {
  createClass,
  insertAssignment,
  insertSubmissionViaAPI,
  loginAsUser,
  supabase,
  TestingUser,
  createUsersInClass,
  submitFeedbackViaAPI,
  createSampleGradingResult
} from "./TestingUtils";
import { argosScreenshot } from "@argos-ci/playwright";

let course: Course;
let student: TestingUser | undefined;

let assignmentInFuture: Assignment | undefined;
let assignmentInPast: Assignment | undefined;
let assignmentExtended: Assignment | undefined;
let assignmentWithNotGraded: Assignment | undefined;
let assignmentWithGradedAndNotGraded: Assignment | undefined;

test.beforeAll(async () => {
  course = await createClass();
  [student] = await createUsersInClass([
    {
      name: "Create Submission Student",
      role: "student",
      class_id: course.id,
      useMagicLink: true
    }
  ]);
  assignmentInFuture = await insertAssignment({
    due_date: addDays(new Date(), 1).toUTCString(),
    class_id: course.id,
    name: "Create Submission Assignment Future"
  });
  assignmentInPast = await insertAssignment({
    due_date: addMinutes(new Date(), -5).toUTCString(),
    class_id: course.id,
    name: "Create Submission Assignment Past"
  });
  assignmentExtended = await insertAssignment({
    due_date: addMinutes(new Date(), -5).toUTCString(),
    class_id: course.id,
    name: "Create Submission Assignment Extended"
  });
  assignmentWithGradedAndNotGraded = await insertAssignment({
    due_date: addMinutes(new Date(), 5).toUTCString(),
    allow_not_graded_submissions: true,
    class_id: course.id,
    name: "Create Submission Assignment Graded and Not Graded"
  });
  await supabase.from("assignment_due_date_exceptions").insert({
    assignment_id: assignmentExtended.id,
    class_id: course.id,
    creator_id: student.private_profile_id,
    student_id: student.private_profile_id,
    hours: 24,
    minutes: 0,
    tokens_consumed: 1,
    note: "Test note"
  });

  // Create assignment for NOT-GRADED testing
  assignmentWithNotGraded = await insertAssignment({
    due_date: addMinutes(new Date(), -5).toUTCString(),
    allow_not_graded_submissions: true,
    class_id: course.id,
    name: "Create Submission Assignment Not Graded"
  });
});
test.describe("Create submission", () => {
  test("If the deadline is in the future, the student can create a submission", async ({ page }) => {
    const submission = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentInFuture!.id,
      class_id: course.id
    });
    expect(submission).toBeDefined();
    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const submissionPage = `/course/${course.id}/assignments/${assignmentInFuture!.id}/submissions/${submission.submission_id}`;
    await page.goto(submissionPage);
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.getByText("package com.pawtograder.example.java")).toBeVisible();
  });
  test("If the deadline has passed, the student cannot create a submission", async () => {
    const submission = insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentInPast!.id,
      class_id: course.id
    });
    await expect(submission).rejects.toThrow("You cannot submit after the due date");
  });
  test("If the student has extended their due date, they can create a submission", async ({ page }) => {
    const submission = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentExtended!.id,
      class_id: course.id
    });
    expect(submission).toBeDefined();
    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const submissionPage = `/course/${course.id}/assignments/${assignmentInFuture!.id}/submissions/${submission.submission_id}`;
    await page.goto(submissionPage);
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.getByText("package com.pawtograder.example.java")).toBeVisible();
  });

  test("Student can create NOT-GRADED submission after deadline when assignment allows it", async ({ page }) => {
    const submission = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentWithNotGraded!.id,
      commit_message: "#NOT-GRADED",
      class_id: course.id
    });
    expect(submission).toBeDefined();

    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const submissionPage = `/course/${course.id}/assignments/${assignmentWithNotGraded!.id}/submissions/${submission.submission_id}`;
    await page.goto(submissionPage);
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.getByText("package com.pawtograder.example.java")).toBeVisible();
  });

  test("NOT-GRADED submission does not become active", async ({ page }) => {
    const activeSHA = "active";
    const notGradedSHA = "not-gra";
    await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentWithGradedAndNotGraded!.id,
      commit_message: "here's my submission!",
      sha: activeSHA,
      class_id: course.id
    });
    await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentWithGradedAndNotGraded!.id,
      commit_message: "#NOT-GRADED",
      sha: notGradedSHA,
      class_id: course.id
    });
    await loginAsUser(page, student!, course);
    await expect(page.getByRole("link").filter({ hasText: "Assignments" })).toBeVisible();
    const assignmentPage = `/course/${course.id}/assignments/${assignmentWithGradedAndNotGraded!.id}`;
    await page.goto(assignmentPage);

    // Expect to see one active and one pending submission
    const activeRow = page.getByRole("row").filter({ hasText: activeSHA });
    const notGradedRow = page.getByRole("row").filter({ hasText: notGradedSHA });
    await expect(activeRow).toBeVisible();
    await expect(notGradedRow).toBeVisible();
    await expect(activeRow.getByText("Pending")).toBeVisible();
    await expect(notGradedRow.getByText("Not for grading")).toBeVisible();
    await argosScreenshot(page, "Showing active and not-graded submissions");
    await page.getByRole("link", { name: "Not for grading" }).click();
    await expect(page.getByText("Viewing a not-for-grading submission")).toBeVisible();
  });

  test("Submit feedback API creates grader_result and grader_result_tests", async () => {
    // Create a submission first
    const sha = "feedback" + Math.random().toString(36).substring(2, 8);
    const submission = await insertSubmissionViaAPI({
      student_profile_id: student!.private_profile_id,
      assignment_id: assignmentInFuture!.id,
      sha: sha,
      class_id: course.id
    });
    expect(submission).toBeDefined();
    expect(submission.submission_id).toBeDefined();

    // Submit feedback via the API
    const gradingResult = createSampleGradingResult();
    const response = await submitFeedbackViaAPI({
      repository: submission.repository_name,
      sha: sha,
      feedback: gradingResult
    });

    // Assert valid response
    expect(response).toBeDefined();
    expect(response.is_ok).toBe(true);
    expect(response.message).toContain("registered");
    expect(response.details_url).toContain(`/submissions/${submission.submission_id}`);
    expect(response.supabase_url).toBeDefined();
    expect(response.supabase_anon_key).toBeDefined();

    // Verify grader_result was created
    const { data: graderResult, error: graderResultError } = await supabase
      .from("grader_results")
      .select("*")
      .eq("submission_id", submission.submission_id)
      .single();

    expect(graderResultError).toBeNull();
    expect(graderResult).toBeDefined();
    expect(graderResult!.score).toBe(gradingResult.feedback.score);
    expect(graderResult!.max_score).toBe(gradingResult.feedback.max_score);
    expect(graderResult!.lint_passed).toBe(true);
    expect(graderResult!.ret_code).toBe(0);

    // Verify grader_result_tests were created
    const { data: graderResultTests, error: testsError } = await supabase
      .from("grader_result_tests")
      .select("*")
      .eq("grader_result_id", graderResult!.id)
      .order("name");

    expect(testsError).toBeNull();
    expect(graderResultTests).toBeDefined();
    expect(graderResultTests!.length).toBe(4); // We created 4 tests in createSampleGradingResult

    // Verify individual test details
    const test1 = graderResultTests!.find((t) => t.name === "Test 1 - Basic functionality");
    expect(test1).toBeDefined();
    expect(test1!.score).toBe(25);
    expect(test1!.max_score).toBe(25);
    expect(test1!.part).toBe("Part A");

    const test2 = graderResultTests!.find((t) => t.name === "Test 2 - Edge cases");
    expect(test2).toBeDefined();
    expect(test2!.score).toBe(20);
    expect(test2!.max_score).toBe(25);

    const hiddenTest = graderResultTests!.find((t) => t.name === "Test 4 - Hidden test");
    expect(hiddenTest).toBeDefined();
    expect(hiddenTest!.is_released).toBe(false); // hide_until_released: true

    // Verify grader_result_output was created
    const { data: graderResultOutput, error: outputError } = await supabase
      .from("grader_result_output")
      .select("*")
      .eq("grader_result_id", graderResult!.id);

    expect(outputError).toBeNull();
    expect(graderResultOutput).toBeDefined();
    expect(graderResultOutput!.length).toBeGreaterThan(0);

    // Check that visible output was stored
    const visibleOutput = graderResultOutput!.find((o) => o.visibility === "visible");
    expect(visibleOutput).toBeDefined();
    expect(visibleOutput!.output).toBe("All visible tests passed!");
  });
});
