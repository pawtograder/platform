/**
 * DB-level coverage for promote_whatif_grader_result and the AFTER DELETE trigger on
 * grader_result_tests.
 *
 * promote_whatif_grader_result deleted the old official grader result, repointed the rerun, and
 * returned {'promoted': true} — without recomputing the submission review. Nothing else covered it
 * either: grader_results lost its recompute trigger in 20250425172859, and the grader_result_tests
 * triggers were AFTER INSERT / AFTER UPDATE only (they use REFERENCING NEW TABLE, which a DELETE
 * trigger cannot declare). So submission_reviews.total_autograde_score kept the value derived from
 * the result that had just been deleted — in the one feature whose entire purpose is correcting a
 * wrong grade.
 *
 * Lives at tests/e2e/ root so playwright.config.ts's testIgnore does not skip it.
 */
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  TestingUser
} from "./TestingUtils";
import type { Assignment, Course } from "@/utils/supabase/DatabaseTypes";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

async function readAutogradeScore(reviewId: number): Promise<number> {
  const { data, error } = await supabase
    .from("submission_reviews")
    .select("total_autograde_score")
    .eq("id", reviewId)
    .single();
  if (error) throw new Error(`readAutogradeScore failed: ${error.message}`);
  return Number(data.total_autograde_score ?? 0);
}

/**
 * Replace the official result's tests with known scores.
 *
 * The prebaked submission already owns a grader_results row, and grader_results is UNIQUE on
 * submission_id, so the official result has to be reused rather than re-inserted.
 */
async function setOfficialTestScores(classId: number, submissionId: number, scores: number[]): Promise<number> {
  const { data, error } = await supabase.from("grader_results").select("id").eq("submission_id", submissionId).single();
  if (error) throw new Error(`find official grader result failed: ${error.message}`);

  const { error: delError } = await supabase.from("grader_result_tests").delete().eq("grader_result_id", data.id);
  if (delError) throw new Error(`clear official tests failed: ${delError.message}`);

  const { error: insError } = await supabase.from("grader_result_tests").insert(
    scores.map((score, i) => ({
      class_id: classId,
      grader_result_id: data.id,
      submission_id: submissionId,
      name: `official-${i}`,
      score,
      max_score: 50,
      output: "",
      output_format: "text"
    }))
  );
  if (insError) throw new Error(`insert official tests failed: ${insError.message}`);
  return data.id;
}

/** Insert a grader result with the given test scores. `submissionId` null models a what-if run. */
async function insertGraderResult({
  classId,
  submissionId,
  rerunForSubmissionId,
  testScores
}: {
  classId: number;
  submissionId: number | null;
  rerunForSubmissionId: number | null;
  testScores: number[];
}): Promise<number> {
  const { data, error } = await supabase
    .from("grader_results")
    .insert({
      class_id: classId,
      submission_id: submissionId,
      rerun_for_submission_id: rerunForSubmissionId,
      score: testScores.reduce((a, b) => a + b, 0),
      max_score: 100,
      lint_passed: true,
      lint_output: "",
      lint_output_format: "text"
    })
    .select("id")
    .single();
  if (error) throw new Error(`insertGraderResult failed: ${error.message}`);

  const { error: testsError } = await supabase.from("grader_result_tests").insert(
    testScores.map((score, i) => ({
      class_id: classId,
      grader_result_id: data.id,
      submission_id: submissionId,
      name: `test-${i}`,
      score,
      max_score: 50,
      output: "",
      output_format: "text"
    }))
  );
  if (testsError) throw new Error(`insert grader_result_tests failed: ${testsError.message}`);

  return data.id;
}

test.describe("promote_whatif_grader_result — the promoted score reaches the grade", () => {
  test.describe.configure({ mode: "serial" });

  let course: Course;
  let student: TestingUser;
  let instructor: TestingUser;
  let assignment: Assignment;
  let submissionId: number;
  let reviewId: number;
  // promote_whatif_grader_result authorizes off auth.uid(), so the service-role client cannot call
  // it — under service role auth.uid() is NULL and the RPC raises "User not authenticated".
  let instructorClient: SupabaseClient<Database>;

  test("setup: an official grader result worth a known autograde score", async () => {
    course = await createClass();
    const users = await createUsersInClass([
      { class_id: course.id, role: "student", useMagicLink: false },
      { class_id: course.id, role: "instructor", useMagicLink: true }
    ]);
    student = users[0];
    instructor = users[1];
    instructorClient = await createAuthenticatedClient(instructor);

    assignment = await insertAssignment({
      due_date: addDays(new Date(), 7).toUTCString(),
      class_id: course.id,
      name: "What-if promotion recompute"
    });

    const submission = await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });
    submissionId = submission.submission_id;
    reviewId = submission.grading_review_id;

    // Reuse the prebaked submission's own grader result, giving it known test scores.
    await setOfficialTestScores(course.id, submissionId, [10, 10]);

    expect(await readAutogradeScore(reviewId)).toBe(20);
  });

  test("deleting autograder tests lowers the stored score", async () => {
    // Without the AFTER DELETE trigger this stayed at 20: removing tests fired nothing at all.
    const { data: rows } = await supabase
      .from("grader_result_tests")
      .select("id")
      .eq("submission_id", submissionId)
      .limit(1);
    const victimId = rows?.[0]?.id;
    expect(victimId).toBeDefined();

    await supabase.from("grader_result_tests").delete().eq("id", victimId!);

    expect(await readAutogradeScore(reviewId)).toBe(10);
  });

  test("promoting a what-if result updates the grade with no further write", async () => {
    // A what-if run carries submission_id NULL on the result AND on its tests.
    const whatIfId = await insertGraderResult({
      classId: course.id,
      submissionId: null,
      rerunForSubmissionId: submissionId,
      testScores: [40, 5]
    });

    const { data, error } = await instructorClient.rpc("promote_whatif_grader_result", {
      p_grader_result_id: whatIfId,
      p_class_id: course.id
    });
    if (error) throw new Error(`promote failed: ${error.message}`);
    expect((data as { promoted?: boolean })?.promoted).toBe(true);

    // The assertion that matters: no extra update, no page refresh, no unrelated edit.
    expect(await readAutogradeScore(reviewId)).toBe(45);
  });

  test("the promoted result's tests are repointed at the submission", async () => {
    // Previously only the parent grader_results row was repointed, leaving the tests orphaned from
    // the submission and invisible to everything that joins on grader_result_tests.submission_id.
    const { data, error } = await supabase.from("grader_result_tests").select("id").eq("submission_id", submissionId);
    if (error) throw new Error(`select tests failed: ${error.message}`);
    expect(data?.length).toBe(2);
  });
});
