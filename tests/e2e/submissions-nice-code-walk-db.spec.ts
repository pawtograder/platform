/**
 * DB-level coverage for the code-walk columns of submissions_with_grades_for_assignment_nice
 * (supabase/migrations/20261028120000_submissions_nice_code_walk_release.sql).
 *
 * Code walks are released separately from the grading review, and the roster's `released` column
 * is `submissions.released`, which only the grading review sets. The view therefore exposes the
 * code-walk state of each row's active submission. The cases pinned here:
 *   - a released code walk, an unreleased complete one, and an incomplete one each read back as
 *     such, independent of the grading release;
 *   - a row with no code-walk review (no submission, or an assignment without a code-walk rubric)
 *     has count 0 and null booleans;
 *   - with two code-walk rubrics, the booleans are true only when every code walk satisfies them;
 *   - the view stays security_invoker: a student reads only their own row.
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

type CodeWalkState = {
  code_walk_review_count: number | null;
  code_walk_completed: boolean | null;
  code_walk_released: boolean | null;
};

async function insertCodeWalkRubric(class_id: number, assignment_id: number, name: string) {
  const { data, error } = await supabase
    .from("rubrics")
    .insert({ class_id, assignment_id, name, review_round: "code-walk" })
    .select("id")
    .single();
  if (error) throw new Error(`insertCodeWalkRubric failed: ${error.message}`);
  return data.id;
}

/** The code-walk review the rubric insert trigger backfilled for a submission. */
async function codeWalkReviewId(submission_id: number, rubric_id: number): Promise<number> {
  const { data, error } = await supabase
    .from("submission_reviews")
    .select("id")
    .eq("submission_id", submission_id)
    .eq("rubric_id", rubric_id)
    .single();
  if (error) throw new Error(`codeWalkReviewId failed: ${error.message}`);
  return data.id;
}

async function setReview(id: number, patch: { completed?: boolean; released?: boolean }, completedBy: string) {
  const update: Database["public"]["Tables"]["submission_reviews"]["Update"] = {};
  if (patch.completed !== undefined) {
    update.completed_at = patch.completed ? new Date().toISOString() : null;
    update.completed_by = patch.completed ? completedBy : null;
  }
  if (patch.released !== undefined) update.released = patch.released;
  const { error } = await supabase.from("submission_reviews").update(update).eq("id", id);
  if (error) throw new Error(`setReview(${id}) failed: ${error.message}`);
}

async function viewRows(client: SupabaseClient<Database>, assignment_id: number) {
  const { data, error } = await client
    .from("submissions_with_grades_for_assignment_nice")
    .select(
      "student_private_profile_id, activesubmissionid, released, code_walk_review_count, code_walk_completed, code_walk_released"
    )
    .eq("assignment_id", assignment_id);
  if (error) throw new Error(`view read failed: ${error.message}`);
  return data;
}

async function stateFor(client: SupabaseClient<Database>, assignment_id: number, profileId: string) {
  const row = (await viewRows(client, assignment_id)).find((r) => r.student_private_profile_id === profileId);
  if (!row) throw new Error(`no view row for ${profileId}`);
  const state: CodeWalkState = {
    code_walk_review_count: row.code_walk_review_count,
    code_walk_completed: row.code_walk_completed,
    code_walk_released: row.code_walk_released
  };
  return { state, gradingReleased: row.released !== null };
}

const NONE: CodeWalkState = { code_walk_review_count: 0, code_walk_completed: null, code_walk_released: null };

test.describe("submissions_with_grades_for_assignment_nice code-walk columns", () => {
  test.describe.configure({ mode: "serial" });

  let instructor: TestingUser;
  let students: TestingUser[];
  let instructorClient: SupabaseClient<Database>;
  let assignmentId: number;
  let plainAssignmentId: number;
  let twoRubricAssignmentId: number;
  /** Code walks on the single-rubric assignment, one per submitting student [0..2]. */
  let codeWalkIds: number[];
  /** The two code walks of student 0's submission on the two-rubric assignment. */
  let twoRubricIds: number[];
  let gradingReviewIds: number[];

  test.beforeAll(async () => {
    const course = await createClass({ name: "Roster code walk columns e2e" });
    const stamp = Date.now();
    [instructor] = await createUsersInClass([
      {
        name: "Roster Code Walk Instructor",
        email: `roster-cw-instructor-${stamp}@pawtograder.net`,
        role: "instructor",
        class_id: course.id,
        useMagicLink: true
      }
    ]);
    // Students 0-2 submit; student 3 does not.
    students = await createUsersInClass(
      [0, 1, 2, 3].map((i) => ({
        name: `Roster Code Walk Student ${i}`,
        email: `roster-cw-student-${i}-${stamp}@pawtograder.net`,
        role: "student" as const,
        class_id: course.id,
        useMagicLink: true
      }))
    );

    const newAssignment = (name: string) =>
      insertAssignment({
        class_id: course.id,
        name,
        due_date: addDays(new Date(), 3).toUTCString(),
        release_date: addDays(new Date(), -3).toUTCString()
      });
    const submit = (assignment_id: number, s: TestingUser) =>
      insertPreBakedSubmission({ assignment_id, class_id: course.id, student_profile_id: s.private_profile_id });

    const assignment = await newAssignment("Code walk columns assignment");
    assignmentId = assignment.id;
    const submissions = [];
    for (const s of students.slice(0, 3)) submissions.push(await submit(assignment.id, s));
    gradingReviewIds = submissions.map((s) => s.grading_review_id);
    // Inserting the rubric backfills a code-walk review for each existing submission.
    const rubricId = await insertCodeWalkRubric(course.id, assignment.id, "Code Walk");
    codeWalkIds = [];
    for (const s of submissions) codeWalkIds.push(await codeWalkReviewId(s.submission_id, rubricId));

    const plain = await newAssignment("No code walk assignment");
    plainAssignmentId = plain.id;
    await submit(plain.id, students[0]);

    const twoRubric = await newAssignment("Two code walk rubrics assignment");
    twoRubricAssignmentId = twoRubric.id;
    const twoRubricSubmission = await submit(twoRubric.id, students[0]);
    const rubricA = await insertCodeWalkRubric(course.id, twoRubric.id, "Code Walk A");
    const rubricB = await insertCodeWalkRubric(course.id, twoRubric.id, "Code Walk B");
    twoRubricIds = [
      await codeWalkReviewId(twoRubricSubmission.submission_id, rubricA),
      await codeWalkReviewId(twoRubricSubmission.submission_id, rubricB)
    ];

    // Start from a known state: nothing complete, nothing released.
    for (const id of [...codeWalkIds, ...twoRubricIds, ...gradingReviewIds]) {
      await setReview(id, { completed: false, released: false }, instructor.private_profile_id);
    }
    instructorClient = await createAuthenticatedClient(instructor);
  });

  test("released, unreleased and incomplete code walks read back independently of grading", async () => {
    const by = instructor.private_profile_id;
    // Student 0: code walk complete and released, grading review unreleased.
    await setReview(codeWalkIds[0], { completed: true, released: true }, by);
    // Student 1: code walk complete but unreleased, grading review released.
    await setReview(codeWalkIds[1], { completed: true }, by);
    await setReview(gradingReviewIds[1], { completed: true, released: true }, by);
    // Student 2: code walk incomplete.

    const s0 = await stateFor(instructorClient, assignmentId, students[0].private_profile_id);
    expect(s0.state).toEqual({ code_walk_review_count: 1, code_walk_completed: true, code_walk_released: true });
    expect(s0.gradingReleased).toBe(false);

    const s1 = await stateFor(instructorClient, assignmentId, students[1].private_profile_id);
    expect(s1.state).toEqual({ code_walk_review_count: 1, code_walk_completed: true, code_walk_released: false });
    expect(s1.gradingReleased).toBe(true);

    const s2 = await stateFor(instructorClient, assignmentId, students[2].private_profile_id);
    expect(s2.state).toEqual({ code_walk_review_count: 1, code_walk_completed: false, code_walk_released: false });
  });

  test("rows without a code-walk review have count 0 and null booleans", async () => {
    // No submission on a code-walk assignment.
    const s3 = await stateFor(instructorClient, assignmentId, students[3].private_profile_id);
    expect(s3.state).toEqual(NONE);
    // Submission on an assignment with no code-walk rubric.
    const plain = await stateFor(instructorClient, plainAssignmentId, students[0].private_profile_id);
    expect(plain.state).toEqual(NONE);
  });

  test("with two code-walk rubrics, released and completed require every code walk", async () => {
    const by = instructor.private_profile_id;
    const read = async () =>
      (await stateFor(instructorClient, twoRubricAssignmentId, students[0].private_profile_id)).state;

    await setReview(twoRubricIds[0], { completed: true, released: true }, by);
    expect(await read()).toEqual({ code_walk_review_count: 2, code_walk_completed: false, code_walk_released: false });

    await setReview(twoRubricIds[1], { completed: true }, by);
    expect(await read()).toEqual({ code_walk_review_count: 2, code_walk_completed: true, code_walk_released: false });

    await setReview(twoRubricIds[1], { released: true }, by);
    expect(await read()).toEqual({ code_walk_review_count: 2, code_walk_completed: true, code_walk_released: true });
  });

  test("a student reads only their own row", async () => {
    const studentClient = await createAuthenticatedClient(students[1]);
    const rows = await viewRows(studentClient, assignmentId);
    expect(rows.map((r) => r.student_private_profile_id)).toEqual([students[1].private_profile_id]);
    // Instructors see the whole roster, including the non-submitter.
    expect((await viewRows(instructorClient, assignmentId)).length).toBe(4);
  });
});
