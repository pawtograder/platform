import { expect, test } from "@playwright/test";
import { addDays } from "date-fns";
import {
  createAuthenticatedClient,
  createClass,
  createUserInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase
} from "@/tests/e2e/TestingUtils";
import type { TestingUser } from "@/tests/e2e/TestingUtils";

// Regression for issue #823 (Assignments tab denominator).
//
// The student Assignments tab is driven by the `get_assignments_for_student_dashboard`
// RPC + `formatLatestSubmissionLabel` (app/course/[course_id]/assignments/page.tsx).
// When a student has a graded+released ACTIVE submission and a LATER submission that is
// not the active one (e.g. a not-for-grading submission, or after re-activating an older
// submission), the dashboard used to surface the *latest* submission. Its grading review
// is not released, so the row fell back to the autograder-only score/denominator
// ("81.67/90") instead of the active submission's released total out of full points
// ("87.67/100").
//
// This is a pure DB-integration test: it exercises the RPC directly (no browser), so it
// pins the contract `formatLatestSubmissionLabel` depends on. The companion
// HandGradingSection roll-up bug (issue #823 part 2) is covered by
// tests/unit/rubric/points.test.ts (`earnedPointsForCriterion`).
test.describe("dashboard surfaces the active submission's grade (issue #823)", () => {
  test.describe.configure({ timeout: 180_000 });

  let classId: number;
  let assignmentId: number;
  let instructor: TestingUser;
  let student: TestingUser;

  const RELEASED_GRADE = 90; // distinct from the prebaked autograder fallback (5/10)

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Dashboard Active Submission ${suffix}` });
    classId = course.id;

    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `E2E Dashboard Active Instructor ${suffix}`,
      email: `e2e-dashboard-active-instructor-${suffix}@pawtograder.net`
    });
    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Dashboard Active Student ${suffix}`,
      email: `e2e-dashboard-active-student-${suffix}@pawtograder.net`
    });

    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), -1).toISOString(),
      name: `E2E Dashboard Active Assignment ${suffix}`,
      assignment_slug: `e2e-dashboard-active-${suffix}`
    });
    assignmentId = assignment.id;
  });

  test("shows the active hand-graded submission, not a later non-active one", async () => {
    // Submission #1: graded and released. This is the one that "counts".
    const graded = await insertPreBakedSubmission({
      assignment_id: assignmentId,
      class_id: classId,
      student_profile_id: student.private_profile_id,
      repositorySuffix: `dashboard-active-graded-${classId}`
    });
    await completeGrading(graded.grading_review_id, RELEASED_GRADE, instructor.private_profile_id);

    // Submission #2: created later. insertPreBakedSubmission's insert hook makes the newest
    // submission active, so this demotes #1. Its grading review is left unreleased, mirroring a
    // fresh autograder-only submission.
    const later = await insertPreBakedSubmission({
      assignment_id: assignmentId,
      class_id: classId,
      student_profile_id: student.private_profile_id,
      repositorySuffix: `dashboard-active-later-${classId}`
    });
    expect(later.submission_id).toBeGreaterThan(graded.submission_id);

    // Re-activate the older graded submission, so active != latest — exactly the reported state
    // (active/graded #14 vs. later non-active #15).
    const instructorClient = await createAuthenticatedClient(instructor);
    const { data: setActive, error: setActiveError } = await instructorClient.rpc("submission_set_active", {
      _submission_id: graded.submission_id
    });
    if (setActiveError) {
      throw new Error(`Failed to activate graded submission: ${setActiveError.message}`);
    }
    expect(setActive).toBe(true);

    // Sanity-check the DB state the bug depends on: the graded submission is active, the later one is not.
    await expectActiveSubmission(graded.submission_id, true);
    await expectActiveSubmission(later.submission_id, false);

    // Read the dashboard exactly as the student's Assignments tab does.
    const studentClient = await createAuthenticatedClient(student);
    const { data: rows, error } = await studentClient.rpc("get_assignments_for_student_dashboard", {
      p_class_id: classId,
      p_student_profile_id: student.private_profile_id
    });
    if (error) {
      throw new Error(`Dashboard RPC failed: ${error.message}`);
    }
    const row = (rows ?? []).find((r) => r.id === assignmentId);
    expect(row, "assignment row should be present on the dashboard").toBeTruthy();

    // The dashboard must surface the ACTIVE graded submission (#1), not the later one (#2).
    expect(row!.submission_id).toBe(graded.submission_id);
    expect(row!.submission_is_active).toBe(true);

    // Because the chosen submission is graded+released, the row carries the released hand-grade
    // total and completion timestamp. formatLatestSubmissionLabel then renders
    // `#<ordinal> (grading_total_score / total_points)` — i.e. out of the FULL max score —
    // instead of the autograder-only `grader_result_score / grader_result_max_score`.
    expect(Number(row!.grading_total_score)).toBe(RELEASED_GRADE);
    expect(row!.grading_submission_review_completed_at).not.toBeNull();
    expect(Number(row!.total_points)).toBe(100);
  });

  async function completeGrading(gradingReviewId: number, score: number, completedBy: string) {
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

  async function expectActiveSubmission(submissionId: number, expectedActive: boolean) {
    const { data, error } = await supabase.from("submissions").select("is_active").eq("id", submissionId).single();
    if (error) {
      throw new Error(`Failed to read submission ${submissionId}: ${error.message}`);
    }
    expect(data.is_active).toBe(expectedActive);
  }
});
