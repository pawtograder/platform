import { expect, test, type Page } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  loginAsUser,
  supabase
} from "./TestingUtils";

/**
 * A graded exam with one 10-point question, an instructor's own 1-point check added to that
 * question's criterion, and a grader on the student's submission.
 */
async function openExamSubmission(page: Page) {
  const course = await createClass({ name: "Exam check points E2E" });
  const student = await createUserInClass({ role: "student", class_id: course.id });
  const grader = await createUserInClass({ role: "grader", class_id: course.id });
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Midterm Exam",
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });
  const rubricId = assignment.grading_rubric_id as number;

  const { data: examId, error: examErr } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1
  });
  expect(examErr).toBeNull();
  const { error: structErr } = await supabase.rpc("exam_upsert_questions_and_regions", {
    p_exam_id: examId as number,
    p_questions: [
      { client_id: "p1", parent_client_id: null, level: 1, ordinal: 0, label: "Part A" },
      { client_id: "q1", parent_client_id: "p1", level: 2, ordinal: 0, label: "Q1" },
      {
        client_id: "c1",
        parent_client_id: "q1",
        level: 3,
        ordinal: 0,
        label: "Item 1",
        answer_type: "free_text",
        points: 10
      }
    ],
    p_regions: []
  });
  expect(structErr).toBeNull();
  const { error: syncErr } = await supabase.rpc("exam_sync_rubric_from_questions", {
    p_exam_id: examId as number,
    p_rubric_id: rubricId
  });
  expect(syncErr).toBeNull();

  const { data: criterion } = await supabase
    .from("rubric_criteria")
    .select("id")
    .eq("rubric_id", rubricId)
    .not("exam_question_id", "is", null)
    .single();
  const { error: ownCheckErr } = await supabase.from("rubric_checks").insert({
    class_id: course.id,
    assignment_id: assignment.id,
    rubric_id: rubricId,
    rubric_criteria_id: criterion!.id,
    name: "Showed work",
    ordinal: 1,
    points: 1,
    is_annotation: false,
    is_comment_required: false
  });
  expect(ownCheckErr).toBeNull();

  const submission = await insertPreBakedSubmission({
    student_profile_id: student.private_profile_id,
    assignment_id: assignment.id,
    class_id: course.id
  });
  await loginAsUser(page, grader, course);
  await page.goto(`/course/${course.id}/assignments/${assignment.id}/submissions/${submission.submission_id}/files`);
  return { gradingReviewId: submission.grading_review_id };
}

test.describe("Exam check points", () => {
  test("a grader can give part of an exam question's points", async ({ page }) => {
    const { gradingReviewId } = await openExamSubmission(page);

    await page.getByRole("checkbox", { name: /Item 1/ }).check({ force: true });
    await page.getByLabel("Points for Item 1").fill("6");
    await page.getByRole("button", { name: "Add Check" }).click();

    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("submission_reviews")
            .select("total_score, total_autograde_score")
            .eq("id", gradingReviewId)
            .single();
          return Number(data?.total_score) - Number(data?.total_autograde_score);
        },
        { timeout: 30_000 }
      )
      .toBe(6);
    await expect(page.getByText("Q1 6/10")).toBeVisible();
  });

  test("a check the instructor added has no points box", async ({ page }) => {
    await openExamSubmission(page);

    await page.getByRole("checkbox", { name: /Showed work/ }).check({ force: true });
    await expect(page.getByRole("button", { name: "Add Check" })).toBeVisible();
    await expect(page.getByLabel(/Points for/)).toHaveCount(0);
  });
});
