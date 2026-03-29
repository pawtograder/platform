/**
 * Regression for GitHub issue #504: extending an assignment due date after the
 * deadline must shift existing self-review review_assignments.due_date.
 *
 * Requires local Supabase, SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and
 * RUN_SUPABASE_INTEGRATION_TESTS=true (avoids failures when .env.local points at
 * a stopped local API). Example:
 *   RUN_SUPABASE_INTEGRATION_TESTS=true npx jest tests/unit/issue-504-self-review-deadline-on-assignment-extend.test.ts
 */
import {
  createClass,
  createUsersInClass,
  insertAssignment,
  insertPreBakedSubmission,
  supabase
} from "../e2e/TestingUtils";

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config({ path: ".env.local" });
} catch {
  /* optional */
}

const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const integrationEnabled = process.env.RUN_SUPABASE_INTEGRATION_TESTS === "true";
const dbUrl =
  process.env.SUPABASE_DB_URL ?? process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const describeIntegration = url && serviceKey && integrationEnabled ? describe : describe.skip;

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

    // Self-review rows are created by check_assignment_deadlines_passed (cron in prod), not an RPC.
    const { TextEncoder, TextDecoder } = await import("node:util");
    if (typeof globalThis.TextEncoder === "undefined") {
      globalThis.TextEncoder = TextEncoder as typeof globalThis.TextEncoder;
      globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;
    }
    const { Client } = await import("pg");
    const pgClient = new Client({ connectionString: dbUrl });
    await pgClient.connect();
    try {
      await pgClient.query("SELECT public.check_assignment_deadlines_passed()");
    } finally {
      await pgClient.end();
    }

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

    const { error: updErr } = await supabase
      .from("assignments")
      .update({ due_date: newAssignmentDue.toISOString() })
      .eq("id", assignment.id);
    if (updErr) throw new Error(updErr.message);

    const { data: assignAfter, error: assignAfterErr } = await supabase
      .from("assignments")
      .select("due_date")
      .eq("id", assignment.id)
      .single();
    if (assignAfterErr || !assignAfter) throw new Error(assignAfterErr?.message ?? "assign after");

    const assignDeltaMs = new Date(assignAfter.due_date).getTime() - assignBeforeMs;

    const { data: afterRow, error: afterErr } = await supabase
      .from("review_assignments")
      .select("due_date")
      .eq("id", beforeRows.id)
      .single();
    if (afterErr || !afterRow) throw new Error(afterErr?.message ?? "after select failed");

    const afterDue = new Date(afterRow.due_date).getTime();
    expect(afterDue - beforeDue).toBe(assignDeltaMs);

    // cleanup: class cascade deletes related rows in typical schema
    await supabase.from("classes").delete().eq("id", course.id);
  });
});
