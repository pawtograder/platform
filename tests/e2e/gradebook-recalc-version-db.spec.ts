/**
 * A grade change on a gradebook row that is already queued or mid-recalculation must invalidate the
 * pass in flight: enqueue_gradebook_row_recalculation bumps the row's version, so a worker pass that
 * read its inputs before the change loses update_gradebook_rows_batch's version check instead of
 * committing stale calculated scores and clearing `dirty`.
 *
 * The batch enqueue already did this; the single-row enqueue (called by the submission and review
 * triggers) only queued another message. See
 * supabase/migrations/20261125120000_gradebook_enqueue_inflight_bumps_version.sql.
 */
import { expect, test } from "@playwright/test";
import { createClass, createUserInClass, supabase, type TestingUser } from "./TestingUtils";

test.describe("gradebook recalculation version", () => {
  test.describe.configure({ timeout: 240_000 });
  let classId: number;
  let gradebookId: number;
  let student: TestingUser;

  test.beforeAll(async () => {
    const course = await createClass({ name: "E2E Gradebook Recalc Version" });
    classId = course.id;
    student = await createUserInClass({ role: "student", class_id: classId, name: "Recalc Version Student" });
    const { data, error } = await supabase.from("classes").select("gradebook_id").eq("id", classId).single();
    if (error || !data?.gradebook_id) throw new Error(`No gradebook for class ${classId}: ${error?.message}`);
    gradebookId = data.gradebook_id;
  });

  async function rowState() {
    const { data, error } = await supabase
      .from("gradebook_row_recalc_state")
      .select("dirty, is_recalculating, version")
      .eq("class_id", classId)
      .eq("gradebook_id", gradebookId)
      .eq("student_id", student.private_profile_id)
      .eq("is_private", true)
      .single();
    if (error) throw new Error(`Failed to read row state: ${error.message}`);
    return data;
  }

  test("enqueueing a row that is already recalculating bumps its version", async () => {
    // Let the enrollment's own recalculation finish first. The worker only processes rows that have
    // queued messages, so once this row is idle nothing but this test touches it until the enqueue.
    await expect
      .poll(
        async () => {
          const { data } = await supabase
            .from("gradebook_row_recalc_state")
            .select("dirty, is_recalculating")
            .eq("class_id", classId)
            .eq("student_id", student.private_profile_id)
            .eq("is_private", true)
            .maybeSingle();
          return data === null || (!data.dirty && !data.is_recalculating);
        },
        { timeout: 180_000 }
      )
      .toBe(true);

    // A pass in flight: the row is claimed, and the worker has recorded the version it will check.
    const { error: claimError } = await supabase.from("gradebook_row_recalc_state").upsert(
      {
        class_id: classId,
        gradebook_id: gradebookId,
        student_id: student.private_profile_id,
        is_private: true,
        dirty: true,
        is_recalculating: true
      },
      { onConflict: "class_id,gradebook_id,student_id,is_private" }
    );
    expect(claimError).toBeNull();
    const before = await rowState();
    expect(before.is_recalculating).toBe(true);

    // A grade change lands while that pass is running.
    const { error: enqueueError } = await supabase.rpc("enqueue_gradebook_row_recalculation", {
      p_class_id: classId,
      p_gradebook_id: gradebookId,
      p_student_id: student.private_profile_id,
      p_is_private: true,
      p_reason: "e2e: grade changed mid-pass"
    });
    expect(enqueueError).toBeNull();
    // The live worker may already be re-running the row, so only the version is stable to assert.
    expect((await rowState()).version).toBeGreaterThan(before.version);

    // The pass that started before the change can no longer commit or clear the row.
    const { data, error } = await supabase.rpc("update_gradebook_rows_batch", {
      p_batch_updates: [
        {
          class_id: classId,
          gradebook_id: gradebookId,
          student_id: student.private_profile_id,
          is_private: true,
          expected_version: before.version,
          message_ids: [],
          updates: []
        }
      ]
    });
    expect(error).toBeNull();
    const result = (data as { results: { version_matched: boolean; cleared: boolean }[] }).results[0];
    expect(result.version_matched).toBe(false);
    expect(result.cleared).toBe(false);
  });
});
