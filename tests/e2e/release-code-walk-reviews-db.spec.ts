/**
 * DB-level coverage for release_code_walk_reviews_for_assignment /
 * unrelease_code_walk_reviews_for_assignment
 * (supabase/migrations/20261020120000_release_code_walk_reviews_for_assignment.sql).
 *
 * 20260811130000 scoped "Release all" to the grading review so it stopped publishing self-review and
 * meta-grading rounds, which left code walks releasable only one submission at a time. These RPCs
 * release code walks in bulk, and the properties pinned here are the ones that would leak grades
 * or comments if they regressed:
 *   - only completed code walks are released, and incomplete ones stay hidden;
 *   - grading, self-review and meta-grading reviews of the same submissions never change;
 *   - the statement-level release cascade still releases the code walk's comments;
 *   - releasing a code walk or self-review does not publish the submission's hidden autograder
 *     tests; only the grading review does (20261020120100);
 *   - code walks on inactive submissions are skipped;
 *   - RLS, not the function, decides what a grader or student can flip (SECURITY INVOKER).
 *
 * Lives at tests/e2e/ root, NOT in a subdirectory, so playwright.config.ts's testIgnore does not
 * skip it.
 */
import { test, expect } from "../global-setup";
import { addDays } from "date-fns";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";
import {
  createAuthenticatedClient,
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase,
  type TestingUser
} from "./TestingUtils";

type ReviewRow = { id: number; released: boolean; completed_at: string | null };

async function insertRubric(
  class_id: number,
  assignment_id: number,
  review_round: "code-walk" | "meta-grading-review"
) {
  const { data, error } = await supabase
    .from("rubrics")
    .insert({ class_id, assignment_id, name: `${review_round} rubric`, review_round })
    .select("id")
    .single();
  if (error) throw new Error(`insertRubric(${review_round}) failed: ${error.message}`);
  return data.id;
}

/** Find the submission's review for a rubric, creating it when no trigger did. */
async function ensureReview(class_id: number, submission_id: number, rubric_id: number): Promise<number> {
  const existing = await supabase
    .from("submission_reviews")
    .select("id")
    .eq("submission_id", submission_id)
    .eq("rubric_id", rubric_id)
    .maybeSingle();
  if (existing.error) throw new Error(`ensureReview lookup failed: ${existing.error.message}`);
  if (existing.data) return existing.data.id;
  const { data, error } = await supabase
    .from("submission_reviews")
    .insert({
      class_id,
      submission_id,
      rubric_id,
      name: "review",
      total_score: 0,
      tweak: 0,
      total_autograde_score: 0,
      released: false
    })
    .select("id")
    .single();
  if (error) throw new Error(`ensureReview insert failed: ${error.message}`);
  return data.id;
}

async function readReviews(ids: number[]): Promise<Map<number, ReviewRow>> {
  const { data, error } = await supabase.from("submission_reviews").select("id, released, completed_at").in("id", ids);
  if (error) throw new Error(`readReviews failed: ${error.message}`);
  return new Map(data.map((r) => [r.id, r]));
}

/** is_released for every grader_result_tests row of a submission. */
async function testsReleased(submissionId: number): Promise<boolean[]> {
  const { data, error } = await supabase
    .from("grader_result_tests")
    .select("is_released, grader_results!inner(submission_id)")
    .eq("grader_results.submission_id", submissionId);
  if (error) throw new Error(`testsReleased failed: ${error.message}`);
  return data.map((t) => t.is_released);
}

async function commentReleased(commentId: number): Promise<boolean> {
  const { data, error } = await supabase.from("submission_comments").select("released").eq("id", commentId).single();
  if (error) throw new Error(`commentReleased failed: ${error.message}`);
  return data.released;
}

test.describe("release_code_walk_reviews_for_assignment / unrelease_code_walk_reviews_for_assignment", () => {
  test.describe.configure({ mode: "serial" });

  let instructor: TestingUser;
  let grader: TestingUser;
  let student: TestingUser;
  let instructorClient: SupabaseClient<Database>;
  let graderClient: SupabaseClient<Database>;
  let studentClient: SupabaseClient<Database>;
  let assignmentId: number;
  let submissionIds: number[] = [];

  /** Code walks: [0] and [1] completed, [2] incomplete. */
  let codeWalkIds: number[] = [];
  /** A completed code walk on a submission that is no longer active. */
  let inactiveCodeWalkId: number;
  let inactiveSubmissionId: number;
  /** Grading, self-review and meta-grading reviews of the same submissions, all completed. */
  let otherRoundIds: number[] = [];
  let codeWalkCommentId: number;
  let gradingCommentId: number;

  test.beforeAll(async () => {
    const course = await createClass({ name: "Release code walks e2e" });
    const stamp = Date.now();
    [instructor, grader] = await createUsersInClass([
      {
        name: "Code Walk Instructor",
        email: `codewalk-instructor-${stamp}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      },
      {
        name: "Code Walk Grader",
        email: `codewalk-grader-${stamp}@pawtograder.net`,
        role: "grader",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    const students = await createUsersInClass(
      [0, 1, 2, 3].map((i) => ({
        name: `Code Walk Student ${i}`,
        email: `codewalk-student-${i}-${stamp}@pawtograder.net`,
        role: "student" as const,
        class_id: course.id,
        useMagicLink: true
      }))
    );
    student = students[0];

    const assignment = await insertAssignment({
      class_id: course.id,
      name: "Release code walks assignment",
      due_date: addDays(new Date(), 3).toUTCString(),
      release_date: addDays(new Date(), -3).toUTCString()
    });
    assignmentId = assignment.id;

    const submissions: Awaited<ReturnType<typeof insertPreBakedSubmission>>[] = [];
    for (const s of students) {
      submissions.push(
        await insertPreBakedSubmission({
          assignment_id: assignment.id,
          class_id: course.id,
          student_profile_id: s.private_profile_id
        })
      );
    }
    // The fourth submission is deactivated below; the rest of the suite works on the first three.
    const inactive = submissions.pop()!;
    inactiveSubmissionId = inactive.submission_id;
    submissionIds = submissions.map((s) => s.submission_id);

    const codeWalkRubricId = await insertRubric(course.id, assignment.id, "code-walk");
    const metaRubricId = await insertRubric(course.id, assignment.id, "meta-grading-review");
    expect(assignment.self_review_rubric_id).toBeTruthy();

    codeWalkIds = [];
    otherRoundIds = [];
    for (const s of submissions) {
      codeWalkIds.push(await ensureReview(course.id, s.submission_id, codeWalkRubricId));
      otherRoundIds.push(s.grading_review_id);
      otherRoundIds.push(await ensureReview(course.id, s.submission_id, assignment.self_review_rubric_id!));
      otherRoundIds.push(await ensureReview(course.id, s.submission_id, metaRubricId));
    }
    inactiveCodeWalkId = await ensureReview(course.id, inactiveSubmissionId, codeWalkRubricId);
    const { error: deactivateError } = await supabase
      .from("submissions")
      .update({ is_active: false })
      .eq("id", inactiveSubmissionId);
    if (deactivateError) throw new Error(`deactivate submission failed: ${deactivateError.message}`);

    // Complete everything except the third code walk, so a mis-scoped UPDATE would have eligible
    // grading/self-review/meta-grading rows to release.
    const completed = { completed_at: new Date().toISOString(), completed_by: instructor.private_profile_id };
    const { error: completeError } = await supabase
      .from("submission_reviews")
      .update(completed)
      .in("id", [codeWalkIds[0], codeWalkIds[1], inactiveCodeWalkId, ...otherRoundIds]);
    if (completeError) throw new Error(`complete reviews failed: ${completeError.message}`);
    const { error: resetError } = await supabase
      .from("submission_reviews")
      .update({ released: false })
      .in("id", [...codeWalkIds, inactiveCodeWalkId, ...otherRoundIds]);
    if (resetError) throw new Error(`reset released failed: ${resetError.message}`);

    // Hide the autograder tests of the first two submissions, as hide_until_released tests are.
    const { data: graderResults, error: grError } = await supabase
      .from("grader_results")
      .select("id")
      .in("submission_id", [submissionIds[0], submissionIds[1]]);
    if (grError) throw new Error(`grader_results lookup failed: ${grError.message}`);
    const { error: hideError } = await supabase
      .from("grader_result_tests")
      .update({ is_released: false })
      .in(
        "grader_result_id",
        graderResults.map((g) => g.id)
      );
    if (hideError) throw new Error(`hide grader tests failed: ${hideError.message}`);
    expect(await testsReleased(submissionIds[0])).toEqual([false, false]);

    const comment = (submission_review_id: number) =>
      supabase
        .from("submission_comments")
        .insert({
          submission_id: submissions[0].submission_id,
          class_id: course.id,
          author: instructor.private_profile_id,
          comment: "code walk feedback",
          submission_review_id,
          released: false
        })
        .select("id")
        .single();
    const cw = await comment(codeWalkIds[0]);
    if (cw.error) throw new Error(`code walk comment failed: ${cw.error.message}`);
    codeWalkCommentId = cw.data.id;
    const gr = await comment(submissions[0].grading_review_id);
    if (gr.error) throw new Error(`grading comment failed: ${gr.error.message}`);
    gradingCommentId = gr.data.id;

    instructorClient = await createAuthenticatedClient(instructor);
    graderClient = await createAuthenticatedClient(grader);
    studentClient = await createAuthenticatedClient(student);
  });

  test("a student releases nothing", async () => {
    const { data, error } = await studentClient.rpc("release_code_walk_reviews_for_assignment", {
      p_assignment_id: assignmentId
    });
    // SECURITY INVOKER: either RLS hides the assignment (the existence check raises) or it filters
    // every row out of the UPDATE. Both outcomes leave the reviews unchanged.
    if (!error) expect(data).toBe(0);
    const reviews = await readReviews([...codeWalkIds, ...otherRoundIds]);
    for (const r of reviews.values()) expect(r.released).toBe(false);
  });

  test("anon cannot call either RPC", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient<Database>(
      process.env.SUPABASE_URL!,
      (process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
    for (const rpc of [
      "release_code_walk_reviews_for_assignment",
      "unrelease_code_walk_reviews_for_assignment"
    ] as const) {
      const { error } = await anon.rpc(rpc, { p_assignment_id: assignmentId });
      expect(error, `${rpc} should be denied to anon`).not.toBeNull();
    }
  });

  test("an instructor releases only the completed code walks", async () => {
    const { data, error } = await instructorClient.rpc("release_code_walk_reviews_for_assignment", {
      p_assignment_id: assignmentId
    });
    expect(error).toBeNull();
    expect(data).toBe(2);

    const reviews = await readReviews([...codeWalkIds, ...otherRoundIds]);
    expect(reviews.get(codeWalkIds[0])?.released).toBe(true);
    expect(reviews.get(codeWalkIds[1])?.released).toBe(true);
    expect(reviews.get(codeWalkIds[2])?.released).toBe(false);
    for (const id of otherRoundIds) {
      expect(reviews.get(id)?.released, `review ${id} is not a code walk and must not be released`).toBe(false);
    }
  });

  test("the release cascades to the code walk's comments only", async () => {
    expect(await commentReleased(codeWalkCommentId)).toBe(true);
    expect(await commentReleased(gradingCommentId)).toBe(false);

    // The cascade marks a submission released only for its grading review.
    const { data, error } = await supabase.from("submissions").select("id, released").in("id", submissionIds);
    expect(error).toBeNull();
    for (const s of data ?? []) expect(s.released).toBeNull();
  });

  test("releasing code walks does not publish hidden autograder tests", async () => {
    // Before 20261020120100 the cascade released every test of the submission for any review.
    expect(await testsReleased(submissionIds[0])).toEqual([false, false]);
    expect(await testsReleased(submissionIds[1])).toEqual([false, false]);
  });

  test("releasing a self-review does not publish hidden autograder tests either", async () => {
    const selfReviewId = otherRoundIds[3 * 1 + 1]; // submission [1]: [grading, self-review, meta]
    const { error } = await supabase.from("submission_reviews").update({ released: true }).eq("id", selfReviewId);
    expect(error).toBeNull();
    expect(await testsReleased(submissionIds[1])).toEqual([false, false]);
    const { error: resetError } = await supabase
      .from("submission_reviews")
      .update({ released: false })
      .eq("id", selfReviewId);
    expect(resetError).toBeNull();
  });

  test("code walks on inactive submissions are not released", async () => {
    const reviews = await readReviews([inactiveCodeWalkId]);
    expect(reviews.get(inactiveCodeWalkId)?.released).toBe(false);
  });

  test("releasing again is a no-op", async () => {
    const { data, error } = await instructorClient.rpc("release_code_walk_reviews_for_assignment", {
      p_assignment_id: assignmentId
    });
    expect(error).toBeNull();
    expect(data).toBe(0);
  });

  test("a grader cannot unrelease released, completed code walks", async () => {
    // The UPDATE policy limits graders to rows that are unreleased or incomplete.
    const { data, error } = await graderClient.rpc("unrelease_code_walk_reviews_for_assignment", {
      p_assignment_id: assignmentId
    });
    expect(error).toBeNull();
    expect(data).toBe(0);
    const reviews = await readReviews(codeWalkIds);
    expect(reviews.get(codeWalkIds[0])?.released).toBe(true);
    expect(reviews.get(codeWalkIds[1])?.released).toBe(true);
  });

  test("an instructor unreleases every released code walk, complete or not", async () => {
    // A code walk released per submission before it was finished must still be reversible.
    const { error: releaseError } = await supabase
      .from("submission_reviews")
      .update({ released: true })
      .eq("id", codeWalkIds[2]);
    expect(releaseError).toBeNull();

    const { data, error } = await instructorClient.rpc("unrelease_code_walk_reviews_for_assignment", {
      p_assignment_id: assignmentId
    });
    expect(error).toBeNull();
    expect(data).toBe(3);

    const reviews = await readReviews([...codeWalkIds, ...otherRoundIds]);
    for (const r of reviews.values()) expect(r.released).toBe(false);
    expect(await commentReleased(codeWalkCommentId)).toBe(false);
  });

  test("unrelease leaves released grading reviews alone, and releasing grading publishes tests", async () => {
    const gradingReviewId = otherRoundIds[0];
    const { error: releaseError } = await supabase
      .from("submission_reviews")
      .update({ released: true })
      .eq("id", gradingReviewId);
    expect(releaseError).toBeNull();

    const { data, error } = await instructorClient.rpc("unrelease_code_walk_reviews_for_assignment", {
      p_assignment_id: assignmentId
    });
    expect(error).toBeNull();
    expect(data).toBe(0);
    expect((await readReviews([gradingReviewId])).get(gradingReviewId)?.released).toBe(true);
    // The grading review is the one release that still publishes the hidden tests.
    expect(await testsReleased(submissionIds[0])).toEqual([true, true]);
    expect(await testsReleased(submissionIds[1])).toEqual([false, false]);
  });

  test("an unknown assignment raises", async () => {
    const { error } = await instructorClient.rpc("release_code_walk_reviews_for_assignment", {
      p_assignment_id: -1
    });
    expect(error?.message).toContain("does not exist");
  });
});
