import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createClass,
  createUserInClass,
  insertAssignment,
  insertSubmissionViaAPI,
  createDueDateException,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

/**
 * End-to-end coverage for the standards/mastery resubmission workflow enabled by
 * the advisory `suggested_due_date` column.
 *
 * The key behaviors proven here:
 *  - A student may submit, be graded, have the grade RELEASED, and then resubmit
 *    again — repeatedly — without being blocked. A released grade never locks
 *    resubmission. (This is the iterate-to-mastery loop the TA drives weekly.)
 *  - `suggested_due_date` is purely advisory: submissions are accepted after it
 *    has passed, as long as the real `due_date` (hard deadline) has not.
 *  - `due_date` remains the hard cutoff: a push after it is rejected, and an
 *    instructor-granted due-date extension is the only way back in.
 */

/** 40-char hex sha so each round looks like a distinct push. */
function fakeSha(seed: string): string {
  let h = "";
  for (let i = 0; i < 40; i++) {
    h += (((seed.charCodeAt(i % seed.length) + i * 7) % 16) >>> 0).toString(16);
  }
  return h;
}

/** Mark a grading review complete and released, mirroring active-submission-gradebook-db.spec.ts. */
async function completeAndReleaseGrading(gradingReviewId: number, score: number, completedBy: string) {
  const { error } = await supabase
    .from("submission_reviews")
    .update({
      completed_at: new Date().toISOString(),
      completed_by: completedBy,
      released: true,
      total_score: score
    })
    .eq("id", gradingReviewId);
  if (error) {
    throw new Error(`Failed to complete grading review ${gradingReviewId}: ${error.message}`);
  }
}

test.describe("late due date / suggested due date resubmission loop", () => {
  test.describe.configure({ timeout: 180_000 });

  let classId: number;
  let student: TestingUser;
  let grader: TestingUser;

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Suggested Due Date ${suffix}` });
    classId = course.id;
    student = await createUserInClass({ role: "student", class_id: classId, randomSuffix: suffix });
    grader = await createUserInClass({ role: "grader", class_id: classId, randomSuffix: suffix });
  });

  test("student can submit -> be graded -> released -> resubmit, repeatedly, while the window is open", async () => {
    // suggested_due_date already in the PAST, due_date a month out: the resubmission
    // window is open even though the recommended target date has passed.
    const assignment = await insertAssignment({
      class_id: classId,
      name: "Mastery HW (open window)",
      suggested_due_date: addDays(new Date(), -1).toISOString(),
      due_date: addDays(new Date(), 30).toISOString()
    });
    const assignmentId = assignment.id;

    const ROUNDS = 3;
    const submissionIds: number[] = [];

    for (let round = 1; round <= ROUNDS; round++) {
      // Each round is a fresh push (new sha), simulating a weekly resubmission.
      const { submission_id } = await insertSubmissionViaAPI({
        student_profile_id: student.private_profile_id,
        assignment_id: assignmentId,
        class_id: classId,
        sha: fakeSha(`open-${round}`),
        commit_message: `#submit round ${round}`
      });
      submissionIds.push(submission_id);

      // The new submission must be active, have the next ordinal, and (once the
      // insert-time review wiring settles) a grading_review_id we can grade.
      let gradingReviewId = 0;
      await expect(async () => {
        const { data: thisSub } = await supabase
          .from("submissions")
          .select("id, is_active, ordinal, grading_review_id")
          .eq("id", submission_id)
          .single();
        expect(thisSub!.is_active).toBe(true);
        expect(thisSub!.ordinal).toBe(round);
        expect(thisSub!.grading_review_id).not.toBeNull();
        gradingReviewId = thisSub!.grading_review_id!;
      }).toPass({ timeout: 15_000 });

      if (round > 1) {
        const prevId = submissionIds[round - 2];
        const { data: prevSub } = await supabase
          .from("submissions")
          .select("id, is_active, released")
          .eq("id", prevId)
          .single();
        // The crux: the previous grade was released, yet THIS round's submission was
        // accepted anyway -> releasing a grade does not lock resubmission.
        expect(prevSub!.is_active).toBe(false);
        expect(prevSub!.released).not.toBeNull();
      }

      // Grade this round's submission and release it.
      await completeAndReleaseGrading(gradingReviewId, round, grader.private_profile_id);

      // The release trigger should stamp submissions.released.
      await expect(async () => {
        const { data: releasedSub } = await supabase
          .from("submissions")
          .select("released")
          .eq("id", submission_id)
          .single();
        expect(releasedSub!.released).not.toBeNull();
      }).toPass({ timeout: 15_000 });
    }

    // Exactly ROUNDS submissions exist, ordinals 1..ROUNDS, only the last is active,
    // and every earlier round still carries its released grade.
    const { data: allSubs } = await supabase
      .from("submissions")
      .select("id, ordinal, is_active, released")
      .eq("assignment_id", assignmentId)
      .eq("profile_id", student.private_profile_id)
      .order("ordinal", { ascending: true });
    expect(allSubs).toHaveLength(ROUNDS);
    expect(allSubs!.map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(allSubs!.filter((s) => s.is_active)).toHaveLength(1);
    expect(allSubs![ROUNDS - 1].is_active).toBe(true);
    for (let i = 0; i < ROUNDS - 1; i++) {
      expect(allSubs![i].released).not.toBeNull();
    }
  });

  test("a submission after the suggested date but before the due date is accepted", async () => {
    const assignment = await insertAssignment({
      class_id: classId,
      name: "Mastery HW (between dates)",
      suggested_due_date: addDays(new Date(), -2).toISOString(),
      due_date: addDays(new Date(), 5).toISOString()
    });

    // Push time is "now" — strictly after the suggested date, before the due date.
    const { submission_id } = await insertSubmissionViaAPI({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: classId,
      sha: fakeSha("between"),
      commit_message: "#submit between suggested and due"
    });
    expect(submission_id).toBeGreaterThan(0);
  });

  test("due_date is the hard cutoff: rejected past it, accepted again after an instructor extension", async () => {
    // Both dates in the past: suggested earlier than due, and due already elapsed.
    const assignment = await insertAssignment({
      class_id: classId,
      name: "Mastery HW (closed window)",
      suggested_due_date: addDays(new Date(), -10).toISOString(),
      due_date: addDays(new Date(), -1).toISOString()
    });

    // A push after the hard deadline is rejected by the edge function.
    await expect(
      insertSubmissionViaAPI({
        student_profile_id: student.private_profile_id,
        assignment_id: assignment.id,
        class_id: classId,
        sha: fakeSha("too-late"),
        commit_message: "#submit too late"
      })
    ).rejects.toThrow();

    // Instructor grants an individual extension that pushes the deadline past now
    // (due_date was ~24h ago, so 48h of extension clears it).
    await createDueDateException(assignment.id, student.private_profile_id, classId, 48);

    // With the extension in place, the same student can submit again.
    const { submission_id } = await insertSubmissionViaAPI({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: classId,
      sha: fakeSha("after-extension"),
      commit_message: "#submit after extension"
    });
    const { data: sub } = await supabase.from("submissions").select("id, is_active").eq("id", submission_id).single();
    expect(sub!.is_active).toBe(true);
  });
});
