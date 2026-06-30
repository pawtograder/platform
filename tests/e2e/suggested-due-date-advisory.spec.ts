import { expect, test } from "@playwright/test";
import { addDays, addMinutes } from "date-fns";
import {
  createClass,
  createDueDateException,
  createUserInClass,
  insertAssignment,
  insertSubmissionViaAPI,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

/**
 * Proves the standards/mastery workflow the advisory "suggested due date" supports:
 * a student may submit -> be graded -> have the grade released -> resubmit, repeatedly,
 * until the hard deadline (`due_date`), and the new advisory `suggested_due_date`
 * changes none of the enforcement.
 *
 * Enforcement is driven entirely by the real `autograder-create-submission` edge
 * function, which compares NOW() against `calculate_final_due_date` (due_date +
 * per-student extensions). `suggested_due_date` is never consulted.
 *
 * Grading/release here uses a direct `submission_reviews` update (the pattern in
 * active-submission-gradebook-db.spec.ts). Setting `released = true` fires the
 * `submissionreviewreleasecascade` trigger, which stamps `submissions.released`.
 * (`grader_results.is_released` is only set by the bulk-release RPC, not this trigger,
 * so it is intentionally not asserted here.)
 */
test.describe("suggested due date is advisory; release does not lock resubmission", () => {
  test.describe.configure({ timeout: 300_000 });

  let classId: number;
  let instructor: TestingUser;
  let student: TestingUser;
  let suffix: string;

  test.beforeAll(async () => {
    suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Suggested Due Date ${suffix}` });
    classId = course.id;

    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `E2E Suggested Due Date Instructor ${suffix}`,
      email: `e2e-suggested-due-instructor-${suffix}@pawtograder.net`
    });
    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Suggested Due Date Student ${suffix}`,
      email: `e2e-suggested-due-student-${suffix}@pawtograder.net`
    });
  });

  async function getSubmissionRow(submissionId: number) {
    const { data, error } = await supabase
      .from("submissions")
      .select("id, is_active, ordinal, released, grading_review_id")
      .eq("id", submissionId)
      .single();
    if (error || !data) {
      throw new Error(`Failed to load submission ${submissionId}: ${error?.message ?? "missing row"}`);
    }
    return data;
  }

  // grading_review_id is populated by an AFTER trigger on submission insert; give it a beat.
  async function getGradingReviewId(submissionId: number): Promise<number> {
    let reviewId = 0;
    await expect(async () => {
      const row = await getSubmissionRow(submissionId);
      expect(row.grading_review_id).toBeTruthy();
      reviewId = row.grading_review_id as number;
    }).toPass({ timeout: 30_000 });
    return reviewId;
  }

  async function completeAndRelease(gradingReviewId: number, score: number, completedBy: string) {
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
      throw new Error(`Failed to complete+release review ${gradingReviewId}: ${error.message}`);
    }
  }

  test("student can resubmit across weekly regrade/release cycles until the hard deadline", async () => {
    // Hard deadline ~1 month out; advisory target ~1 week out. Both in the future, so
    // every round (submitted at NOW) is well before due_date and is accepted.
    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 30).toISOString(),
      suggested_due_date: addDays(new Date(), 7).toISOString(),
      name: `Mastery Assignment ${suffix}`,
      assignment_slug: `e2e-suggested-loop-${suffix}`
    });
    expect(assignment.suggested_due_date).not.toBeNull();

    const rounds: { submission_id: number; reviewId: number }[] = [];

    for (let round = 1; round <= 3; round++) {
      const { submission_id } = await insertSubmissionViaAPI({
        student_profile_id: student.private_profile_id,
        assignment_id: assignment.id,
        class_id: classId,
        sha: `resubmit-round-${round}-${suffix}`,
        repositorySuffix: `resubmit-${round}-${classId}`
      });

      // The new submission is accepted and becomes the active attempt.
      const row = await getSubmissionRow(submission_id);
      expect(row.is_active).toBe(true);
      expect(row.ordinal).toBe(round);
      expect(row.released).toBeNull(); // not graded/released yet this round

      if (round > 1) {
        // KEY ASSERTION: this round's submission was accepted even though the previous
        // round's grade was already released — release does NOT lock resubmission. The
        // prior submission is now inactive but still carries its released grade.
        const prev = rounds[round - 2];
        const prevRow = await getSubmissionRow(prev.submission_id);
        expect(prevRow.is_active).toBe(false);
        expect(prevRow.released).not.toBeNull();
      }

      // TA grades and releases this round (the weekly regrade cycle).
      const reviewId = await getGradingReviewId(submission_id);
      await completeAndRelease(reviewId, round * 10, instructor.private_profile_id);

      // The release-cascade trigger stamps submissions.released.
      await expect(async () => {
        const released = await getSubmissionRow(submission_id);
        expect(released.released).not.toBeNull();
      }).toPass({ timeout: 15_000 });

      rounds.push({ submission_id, reviewId });
    }

    // Exactly three submissions exist; only the last is active; the earlier two retain
    // their released grades (historical graded submissions persist).
    const { data: allSubs, error: allErr } = await supabase
      .from("submissions")
      .select("id, ordinal, is_active, released")
      .eq("assignment_id", assignment.id)
      .eq("profile_id", student.private_profile_id)
      .order("ordinal", { ascending: true });
    if (allErr || !allSubs) {
      throw new Error(`Failed to load submissions: ${allErr?.message ?? "missing rows"}`);
    }
    expect(allSubs.map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(allSubs.filter((s) => s.is_active).map((s) => s.ordinal)).toEqual([3]);
    expect(allSubs[0].released).not.toBeNull();
    expect(allSubs[1].released).not.toBeNull();
  });

  test("submitting after the suggested date but before the due date is accepted", async () => {
    // Suggested date already passed; hard deadline still ~1 month away.
    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), 30).toISOString(),
      suggested_due_date: addDays(new Date(), -2).toISOString(),
      name: `Past-Suggested Assignment ${suffix}`,
      assignment_slug: `e2e-suggested-past-${suffix}`
    });

    const { submission_id } = await insertSubmissionViaAPI({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: classId,
      sha: `after-suggested-${suffix}`,
      repositorySuffix: `after-suggested-${classId}`
    });

    const row = await getSubmissionRow(submission_id);
    expect(row.is_active).toBe(true); // advisory date does not gate submission
  });

  test("after the hard deadline submission is rejected until an individual extension is granted", async () => {
    // Hard deadline already passed (suggested also in the past, satisfying suggested <= due).
    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addMinutes(new Date(), -5).toISOString(),
      suggested_due_date: addDays(new Date(), -3).toISOString(),
      name: `Past-Due Assignment ${suffix}`,
      assignment_slug: `e2e-suggested-pastdue-${suffix}`
    });

    // Past the hard deadline with no extension -> rejected by the edge function.
    await expect(
      insertSubmissionViaAPI({
        student_profile_id: student.private_profile_id,
        assignment_id: assignment.id,
        class_id: classId,
        sha: `past-due-${suffix}`,
        repositorySuffix: `past-due-${classId}`
      })
    ).rejects.toThrow("You cannot submit after the due date");

    // Instructor grants an individual extension (the only post-deadline path).
    await createDueDateException(assignment.id, student.private_profile_id, classId, 72);

    // Same student can now submit past the original due date.
    const { submission_id } = await insertSubmissionViaAPI({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: classId,
      sha: `after-extension-${suffix}`,
      repositorySuffix: `after-extension-${classId}`
    });
    const row = await getSubmissionRow(submission_id);
    expect(row.is_active).toBe(true);
  });
});
