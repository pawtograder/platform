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

// Regression for the issue #823 follow-up audit: get_student_summary is SECURITY DEFINER
// and student-callable, and used to surface a grading review's total_score before it was
// released. Staff may see in-progress totals; a student calling it for their own profile
// must not — until the review is released.
type StudentSummary = {
  assignments?: { assignment_id: number; total_score: number | null; autograder_score: number | null }[];
};

test.describe("get_student_summary gates unreleased grading scores (issue #823 follow-up)", () => {
  test.describe.configure({ timeout: 180_000 });

  let classId: number;
  let assignmentId: number;
  let instructor: TestingUser;
  let student: TestingUser;
  let gradingReviewId: number;

  const HAND_GRADE = 73; // distinct, non-zero so "gated → null" is unambiguous

  test.beforeAll(async () => {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const course = await createClass({ name: `E2E Student Summary Gate ${suffix}` });
    classId = course.id;

    instructor = await createUserInClass({
      role: "instructor",
      class_id: classId,
      name: `E2E Student Summary Instructor ${suffix}`,
      email: `e2e-student-summary-instructor-${suffix}@pawtograder.net`
    });
    student = await createUserInClass({
      role: "student",
      class_id: classId,
      name: `E2E Student Summary Student ${suffix}`,
      email: `e2e-student-summary-student-${suffix}@pawtograder.net`
    });

    const assignment = await insertAssignment({
      class_id: classId,
      due_date: addDays(new Date(), -1).toISOString(),
      name: `E2E Student Summary Assignment ${suffix}`,
      assignment_slug: `e2e-student-summary-${suffix}`
    });
    assignmentId = assignment.id;

    const submission = await insertPreBakedSubmission({
      assignment_id: assignmentId,
      class_id: classId,
      student_profile_id: student.private_profile_id,
      repositorySuffix: `student-summary-${classId}`
    });
    gradingReviewId = submission.grading_review_id;
  });

  test("student does not see total_score until release; staff always does", async () => {
    // Grading is COMPLETED but NOT released.
    await setGrading({ completed: true, released: false });

    const studentClient = await createAuthenticatedClient(student);
    const instructorClient = await createAuthenticatedClient(instructor);

    // Student: scores gated to null while unreleased.
    let studentRow = await assignmentRow(studentClient);
    expect(studentRow?.total_score ?? null).toBeNull();
    expect(studentRow?.autograder_score ?? null).toBeNull();

    // Staff: sees the in-progress total even though it is unreleased.
    const staffRow = await assignmentRow(instructorClient);
    expect(Number(staffRow?.total_score)).toBe(HAND_GRADE);

    // After release, the student sees it too.
    await setGrading({ completed: true, released: true });
    studentRow = await assignmentRow(studentClient);
    expect(Number(studentRow?.total_score)).toBe(HAND_GRADE);
  });

  async function setGrading({ completed, released }: { completed: boolean; released: boolean }) {
    const { error } = await supabase
      .from("submission_reviews")
      .update({
        completed_at: completed ? new Date().toISOString() : null,
        completed_by: completed ? instructor.private_profile_id : null,
        released,
        total_score: HAND_GRADE
      })
      .eq("id", gradingReviewId);
    if (error) {
      throw new Error(`Failed to update grading review: ${error.message}`);
    }
  }

  async function assignmentRow(client: Awaited<ReturnType<typeof createAuthenticatedClient>>) {
    const { data, error } = await client.rpc("get_student_summary", {
      p_class_id: classId,
      p_student_profile_id: student.private_profile_id
    });
    if (error) {
      throw new Error(`get_student_summary failed: ${error.message}`);
    }
    const summary = data as StudentSummary;
    return (summary.assignments ?? []).find((a) => a.assignment_id === assignmentId);
  }
});
