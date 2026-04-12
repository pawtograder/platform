/**
 * Regression for GitHub issue #504: extending an assignment due date after the
 * deadline must shift existing self-review review_assignments.due_date.
 *
 * Requires local Supabase, SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and
 * RUN_SUPABASE_INTEGRATION_TESTS=true (avoids failures when .env.local points at
 * a stopped local API). Example:
 *   RUN_SUPABASE_INTEGRATION_TESTS=true npx jest tests/unit/issue-504-self-review-deadline-on-assignment-extend.test.ts
 *
 * Leaves the created class and related rows in the database (use db reset or manual cleanup).
 */
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase
} from "@/tests/e2e/TestingUtils";

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config({ path: ".env.local" });
} catch {
  /* optional */
}

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const integrationEnabled = process.env.RUN_SUPABASE_INTEGRATION_TESTS === "true";

const describeIntegration = url && serviceKey && integrationEnabled ? describe : describe.skip;

function throwIfSetError(error: { message: string } | null, context: string): void {
  if (error) {
    throw new Error(`${context}: ${error.message}`);
  }
}

describeIntegration("issue #504: self-review deadline follows assignment extension", () => {
  test("extending assignment due_date shifts self-review review_assignment due_date", async () => {
    const course = await createClass({ name: `Issue 504 ${Date.now()}` });

    const [student] = await createUsersInClass([
      {
        name: "Issue 504 Student",
        email: `issue504-student-${Date.now()}@pawtograder.net`,
        role: "student",
        class_id: course.id,
        useMagicLink: true
      }
    ]);

    // Past due so check_assignment_deadlines_passed assigns self-reviews (mirrors production cron).
    const originalDue = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const assignment = await insertAssignment({
      due_date: originalDue.toUTCString(),
      class_id: course.id,
      name: "Issue 504 assignment"
    });

    await insertPreBakedSubmission({
      student_profile_id: student.private_profile_id,
      assignment_id: assignment.id,
      class_id: course.id
    });

    const { error: deadlineCheckErr } = await supabase.rpc("check_assignment_deadlines_passed");
    throwIfSetError(deadlineCheckErr, "check_assignment_deadlines_passed");

    const selfRubricId = assignment.self_review_rubric_id;
    if (selfRubricId == null) {
      throw new Error("assignment missing self_review_rubric_id");
    }

    const { data: beforeRows, error: beforeErr } = await supabase
      .from("review_assignments")
      .select("id, due_date")
      .eq("assignment_id", assignment.id)
      .eq("assignee_profile_id", student.private_profile_id)
      .eq("rubric_id", selfRubricId)
      .maybeSingle();
    if (beforeErr) throw new Error(beforeErr.message);
    if (!beforeRows) {
      throw new Error("Expected a self-review review_assignment after check_assignment_deadlines_passed");
    }

    const beforeDue = new Date(beforeRows.due_date).getTime();

    const { data: assignBefore, error: assignBeforeErr } = await supabase
      .from("assignments")
      .select("due_date")
      .eq("id", assignment.id)
      .single();
    if (assignBeforeErr || !assignBefore) throw new Error(assignBeforeErr?.message ?? "assign before");

    const assignBeforeMs = new Date(assignBefore.due_date).getTime();
    const extensionMs = 12 * 60 * 60 * 1000;
    const newAssignmentDue = new Date(assignBeforeMs + extensionMs);

    const { data: updatedAssignment, error: updErr } = await supabase
      .from("assignments")
      .update({ due_date: newAssignmentDue.toISOString() })
      .eq("id", assignment.id)
      .select("due_date")
      .single();
    if (updErr) throw new Error(updErr.message);
    if (!updatedAssignment) {
      throw new Error("Assignment update returned no row; due_date may not have been applied");
    }

    const assignDeltaMs = new Date(updatedAssignment.due_date).getTime() - assignBeforeMs;
    if (assignDeltaMs === 0) {
      throw new Error("Assignment due_date did not change after update");
    }

    const { data: afterRow, error: afterErr } = await supabase
      .from("review_assignments")
      .select("due_date")
      .eq("id", beforeRows.id)
      .single();
    if (afterErr || !afterRow) throw new Error(afterErr?.message ?? "after select failed");

    const afterDue = new Date(afterRow.due_date).getTime();
    expect(afterDue - beforeDue).toBe(assignDeltaMs);
  });
});
