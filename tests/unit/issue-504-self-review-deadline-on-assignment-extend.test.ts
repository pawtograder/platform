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
const dbUrl =
  process.env.SUPABASE_DB_URL ?? process.env.DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const describeIntegration = url && serviceKey && integrationEnabled ? describe : describe.skip;

/**
 * Teardown: delete_assignment_with_all_data (postgres-only RPC) removes the assignment graph;
 * then remove class-scoped defaults (discussion, help queue) and the class row.
 */
async function deleteIntegrationTestAssignmentAndClass(
  pgClient: import("pg").Client,
  classId: number,
  assignmentId: number,
  selfReviewSettingId: number
): Promise<void> {
  await pgClient.query("BEGIN");
  try {
    const { rows } = await pgClient.query(
      `SELECT public.delete_assignment_with_all_data($1::bigint, $2::bigint) AS result`,
      [assignmentId, classId]
    );
    const result = rows[0]?.result as { success?: boolean } | undefined;
    if (result && result.success !== true) {
      throw new Error(`delete_assignment_with_all_data: ${JSON.stringify(result)}`);
    }

    await pgClient.query(`DELETE FROM assignment_self_review_settings WHERE id = $1`, [selfReviewSettingId]);
    await pgClient.query(
      `DELETE FROM discussion_thread_likes
       WHERE discussion_thread IN (SELECT id FROM discussion_threads WHERE class_id = $1)`,
      [classId]
    );
    await pgClient.query(
      `DELETE FROM discussion_thread_read_status
       WHERE discussion_thread_id IN (SELECT id FROM discussion_threads WHERE class_id = $1)
          OR discussion_thread_root_id IN (SELECT id FROM discussion_threads WHERE class_id = $1)`,
      [classId]
    );
    await pgClient.query(
      `DELETE FROM discussion_thread_watchers
       WHERE discussion_thread_root_id IN (SELECT id FROM discussion_threads WHERE class_id = $1)`,
      [classId]
    );
    await pgClient.query(
      `UPDATE discussion_threads SET parent = NULL, answer = NULL, root = NULL WHERE class_id = $1`,
      [classId]
    );
    await pgClient.query(`DELETE FROM discussion_threads WHERE class_id = $1`, [classId]);
    await pgClient.query(
      `DELETE FROM discussion_topic_followers
       WHERE topic_id IN (SELECT id FROM discussion_topics WHERE class_id = $1)`,
      [classId]
    );
    await pgClient.query(`DELETE FROM discussion_topics WHERE class_id = $1`, [classId]);
    await pgClient.query(
      `DELETE FROM help_request_message_read_receipts
       WHERE message_id IN (SELECT id FROM help_request_messages WHERE class_id = $1)`,
      [classId]
    );
    await pgClient.query(`UPDATE help_request_messages SET reply_to_message_id = NULL WHERE class_id = $1`, [classId]);
    await pgClient.query(`DELETE FROM help_request_messages WHERE class_id = $1`, [classId]);
    await pgClient.query(
      `DELETE FROM video_meeting_session_users
       WHERE video_meeting_session_id IN (SELECT id FROM video_meeting_sessions WHERE class_id = $1)`,
      [classId]
    );
    await pgClient.query(`DELETE FROM video_meeting_sessions WHERE class_id = $1`, [classId]);
    await pgClient.query(`DELETE FROM help_requests WHERE class_id = $1`, [classId]);
    await pgClient.query(`DELETE FROM help_queues WHERE class_id = $1`, [classId]);
    await pgClient.query(`DELETE FROM class_sections WHERE class_id = $1`, [classId]);
    await pgClient.query(`DELETE FROM gradebook_column_students WHERE class_id = $1`, [classId]);
    await pgClient.query(`UPDATE gradebooks SET final_grade_column = NULL WHERE class_id = $1`, [classId]);
    await pgClient.query(`DELETE FROM gradebook_columns WHERE class_id = $1`, [classId]);
    await pgClient.query(`UPDATE classes SET gradebook_id = NULL WHERE id = $1`, [classId]);
    await pgClient.query(`DELETE FROM gradebooks WHERE class_id = $1`, [classId]);
    await pgClient.query(`DELETE FROM user_roles WHERE class_id = $1`, [classId]);
    await pgClient.query(`DELETE FROM profiles WHERE class_id = $1`, [classId]);
    await pgClient.query(`DELETE FROM classes WHERE id = $1`, [classId]);
    await pgClient.query("COMMIT");
  } catch (e) {
    await pgClient.query("ROLLBACK");
    throw e;
  }
}

describeIntegration("issue #504: self-review deadline follows assignment extension", () => {
  test("extending assignment due_date shifts self-review review_assignment due_date", async () => {
    let courseId: number | undefined;
    let assignmentId: number | undefined;
    let selfReviewSettingId: number | undefined;

    try {
      const course = await createClass({ name: `Issue 504 ${Date.now()}` });
      courseId = course.id;

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
      assignmentId = assignment.id;
      selfReviewSettingId = assignment.self_review_setting_id;

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
    } finally {
      if (courseId !== undefined && assignmentId !== undefined && selfReviewSettingId !== undefined) {
        const { TextEncoder, TextDecoder } = await import("node:util");
        if (typeof globalThis.TextEncoder === "undefined") {
          globalThis.TextEncoder = TextEncoder as typeof globalThis.TextEncoder;
          globalThis.TextDecoder = TextDecoder as typeof globalThis.TextDecoder;
        }
        const { Client } = await import("pg");
        const cleanupClient = new Client({ connectionString: dbUrl });
        await cleanupClient.connect();
        try {
          await deleteIntegrationTestAssignmentAndClass(cleanupClient, courseId, assignmentId, selfReviewSettingId);
        } catch (cleanupErr) {
          const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
          throw new Error(`Test cleanup failed: ${msg}`);
        } finally {
          await cleanupClient.end();
        }
      } else if (courseId !== undefined) {
        const { error: deleteError } = await supabase.from("classes").delete().eq("id", courseId);
        if (deleteError) {
          throw new Error(`Test cleanup failed: ${deleteError.message}`);
        }
      }
    }
  });
});
