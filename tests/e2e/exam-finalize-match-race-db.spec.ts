/**
 * #1270: a match edit that lands while a finalize message is still queued, in flight or redelivered
 * cannot give one student's submission another student's pages, files or artifact.
 *
 * finalize reads matched_profile_id, calls exam_create_submission, then writes storage keys, file
 * rows and the exam_v1 artifact under the profile it read. exam_create_submission now takes that
 * profile and, under the row lock, refuses when the row names someone else
 * (20261118130000_exam_create_submission_expected_profile.sql). These tests drive the interleavings
 * over direct connections (courseGeminiKeyDb.ts helpers: postgres, or a user's PostgREST-equivalent
 * transaction) and, for the end-to-end case, the real exam worker, which passes the profile it read.
 *
 * Needs the disposable-database variables courseGeminiKeyDb.ts checks (CI's e2e-local sets them).
 */
import { expect, test } from "@playwright/test";
import type { Client } from "pg";
import { addDays } from "date-fns";
import { backendPid, beginAsUser, privilegedClient, waitUntilBlocked } from "./courseGeminiKeyDb";
import { processToReview, runExamWorker, seedUploadedBatch } from "./examScanFixture";
import { createClass, createUserInClass, insertAssignment, supabase } from "./TestingUtils";

const STALE = /matched to a different student than this finalize read/;

/** A confirmed scanned exam for Alice in a batch that is back in review (as after error and Retry). */
async function seedConfirmedRow() {
  const course = await createClass({ name: "Finalize match race" });
  const instructor = await createUserInClass({ role: "instructor", class_id: course.id });
  const alice = await createUserInClass({ role: "student", class_id: course.id, name: "Alice Race" });
  const bob = await createUserInClass({ role: "student", class_id: course.id, name: "Bob Race" });
  const assignment = await insertAssignment({
    class_id: course.id,
    name: "Race exam",
    assignment_type: "exam",
    due_date: addDays(new Date(), 7).toISOString()
  });
  const { data: examId } = await supabase.rpc("exam_create", {
    p_assignment_id: assignment.id,
    p_source_type: "pdf",
    p_num_pages: 1
  });
  const { data: batch } = await supabase
    .from("exam_scan_batches")
    .insert({ class_id: course.id, exam_id: examId as number, total_pages: 1, pages_per_exam: 1, status: "review" })
    .select("id")
    .single();
  const { data: row, error } = await supabase
    .from("exam_scanned_submissions")
    .insert({
      class_id: course.id,
      exam_id: examId as number,
      batch_id: batch!.id,
      exam_index: 0,
      matched_profile_id: alice.private_profile_id,
      match_status: "confirmed"
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { course, instructor, alice, bob, assignmentId: assignment.id, rowId: row!.id };
}

/** exam_create_submission as the worker calls it (service_role), inside the caller's transaction. */
async function createAsWorker(client: Client, rowId: number, expected: string | null) {
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE service_role");
  return client.query<{ id: number }>("SELECT public.exam_create_submission($1, $2) AS id", [rowId, expected]);
}

/** MatchReview's re-pick: choose another student (suggested), then Confirm. */
async function repick(client: Client, rowId: number, profileId: string) {
  await client.query(
    "UPDATE public.exam_scanned_submissions SET matched_profile_id = $1, match_status = 'suggested' WHERE id = $2",
    [profileId, rowId]
  );
  await client.query("UPDATE public.exam_scanned_submissions SET match_status = 'confirmed' WHERE id = $1", [rowId]);
}

async function submissionsFor(assignmentId: number) {
  const { data } = await supabase.from("submissions").select("id, profile_id").eq("assignment_id", assignmentId);
  return data ?? [];
}

test.describe("finalize cannot split a scanned exam between two students (#1270)", () => {
  test("a stale expected student is refused, and nothing is created", async () => {
    const { alice, bob, assignmentId, rowId } = await seedConfirmedRow();
    await supabase
      .from("exam_scanned_submissions")
      .update({ matched_profile_id: bob.private_profile_id })
      .eq("id", rowId);
    const { data, error } = await supabase.rpc("exam_create_submission", {
      p_scanned_submission_id: rowId,
      p_expected_profile_id: alice.private_profile_id
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("P0001");
    expect(error?.message).toMatch(STALE);
    expect(await submissionsFor(assignmentId)).toEqual([]);
    const { data: row } = await supabase
      .from("exam_scanned_submissions")
      .select("matched_profile_id, submission_id")
      .eq("id", rowId)
      .single();
    expect(row).toEqual({ matched_profile_id: bob.private_profile_id, submission_id: null });
  });

  test("a stale caller cannot adopt a submission that already exists for someone else", async () => {
    const { alice, bob, assignmentId, rowId } = await seedConfirmedRow();
    // Another copy of the message read Bob and finished first.
    await supabase
      .from("exam_scanned_submissions")
      .update({ matched_profile_id: bob.private_profile_id })
      .eq("id", rowId);
    const first = await supabase.rpc("exam_create_submission", {
      p_scanned_submission_id: rowId,
      p_expected_profile_id: bob.private_profile_id
    });
    expect(first.error).toBeNull();
    // The copy that read Alice must not get Bob's submission id back to write Alice's files into.
    const stale = await supabase.rpc("exam_create_submission", {
      p_scanned_submission_id: rowId,
      p_expected_profile_id: alice.private_profile_id
    });
    expect(stale.data).toBeNull();
    expect(stale.error?.message).toMatch(STALE);
    expect(await submissionsFor(assignmentId)).toEqual([{ id: first.data, profile_id: bob.private_profile_id }]);
  });

  test("edit first: the finalize call waits for the edit, then refuses", async () => {
    const { instructor, alice, bob, assignmentId, rowId } = await seedConfirmedRow();
    const editor = await privilegedClient();
    const worker = await privilegedClient();
    const monitor = await privilegedClient();
    try {
      // Backend pids first: a connection runs one query at a time, so asking a blocked one is a hang.
      const [editorPid, workerPid] = [await backendPid(editor), await backendPid(worker)];
      await beginAsUser(editor, instructor.user_id);
      await repick(editor, rowId, bob.private_profile_id);
      const pending = createAsWorker(worker, rowId, alice.private_profile_id).then(
        () => "created",
        (e: Error) => e.message
      );
      const blocked = await waitUntilBlocked(monitor, workerPid, editorPid, 5000);
      expect(blocked.observed).toBe(true);
      await editor.query("COMMIT");
      expect(await pending).toMatch(STALE);
      await worker.query("ROLLBACK");
    } finally {
      await Promise.all([editor.end(), worker.end(), monitor.end()]);
    }
    expect(await submissionsFor(assignmentId)).toEqual([]);
  });

  test("finalize first: the edit waits, then the freeze trigger refuses it", async () => {
    const { instructor, alice, bob, assignmentId, rowId } = await seedConfirmedRow();
    const editor = await privilegedClient();
    const worker = await privilegedClient();
    const monitor = await privilegedClient();
    let created: number;
    try {
      const [editorPid, workerPid] = [await backendPid(editor), await backendPid(worker)];
      created = Number((await createAsWorker(worker, rowId, alice.private_profile_id)).rows[0].id); // pg returns bigint as text
      await beginAsUser(editor, instructor.user_id);
      const pending = repick(editor, rowId, bob.private_profile_id).then(
        () => "edited",
        (e: Error) => e.message
      );
      const blocked = await waitUntilBlocked(monitor, editorPid, workerPid, 5000);
      expect(blocked.observed).toBe(true);
      await worker.query("COMMIT");
      expect(await pending).toMatch(/already has submission/);
      await editor.query("ROLLBACK");
    } finally {
      await Promise.all([editor.end(), worker.end(), monitor.end()]);
    }
    expect(await submissionsFor(assignmentId)).toEqual([{ id: created!, profile_id: alice.private_profile_id }]);
  });

  test("a redelivered message and the seeder's one-argument call both get the same submission", async () => {
    const { alice, assignmentId, rowId } = await seedConfirmedRow();
    const calls = await Promise.all([
      supabase.rpc("exam_create_submission", {
        p_scanned_submission_id: rowId,
        p_expected_profile_id: alice.private_profile_id
      }),
      supabase.rpc("exam_create_submission", {
        p_scanned_submission_id: rowId,
        p_expected_profile_id: alice.private_profile_id
      })
    ]);
    const legacy = await supabase.rpc("exam_create_submission", { p_scanned_submission_id: rowId });
    for (const c of [...calls, legacy]) expect(c.error).toBeNull();
    expect(new Set([calls[0].data, calls[1].data, legacy.data]).size).toBe(1);
    expect(await submissionsFor(assignmentId)).toEqual([{ id: legacy.data, profile_id: alice.private_profile_id }]);
  });

  test("only the service role can call it, and another course's staff cannot edit the match", async () => {
    const { instructor, bob, rowId } = await seedConfirmedRow();
    const other = await createClass({ name: "Finalize match race, other course" });
    const outsider = await createUserInClass({ role: "instructor", class_id: other.id });
    const client = await privilegedClient();
    try {
      await beginAsUser(client, instructor.user_id);
      await expect(client.query("SELECT public.exam_create_submission($1, null)", [rowId])).rejects.toMatchObject({
        code: "42501"
      });
      await client.query("ROLLBACK");
      await beginAsUser(client, outsider.user_id);
      const edit = await client.query(
        "UPDATE public.exam_scanned_submissions SET matched_profile_id = $1 WHERE id = $2",
        [bob.private_profile_id, rowId]
      );
      expect(edit.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });

  test("PostgREST serves the two-argument signature, and the one-argument call still resolves", async () => {
    // What the worker will send once it passes the student it read (a separate, later change), and
    // what today's worker sends, both through PostgREST rather than a direct connection.
    const { alice, bob, rowId } = await seedConfirmedRow();
    const stale = await supabase.rpc("exam_create_submission", {
      p_scanned_submission_id: rowId,
      p_expected_profile_id: bob.private_profile_id
    });
    expect(stale.error?.message).toMatch(STALE);
    const current = await supabase.rpc("exam_create_submission", {
      p_scanned_submission_id: rowId,
      p_expected_profile_id: alice.private_profile_id
    });
    expect(current.error).toBeNull();
    const legacy = await supabase.rpc("exam_create_submission", { p_scanned_submission_id: rowId });
    expect(legacy.error).toBeNull();
    expect(legacy.data).toBe(current.data);
  });

  test("end to end: a re-pick while the worker's finalize is in flight leaves one owner everywhere", async () => {
    test.setTimeout(240_000);
    const { course, instructor, alice, bob, assignment, batchId } = await seedUploadedBatch("race");
    const carol = await createUserInClass({ role: "student", class_id: course.id, name: "Carol Late" });
    await processToReview(batchId);
    await supabase
      .from("exam_scanned_submissions")
      .update({ match_status: "confirmed" })
      .eq("batch_id", batchId)
      .not("matched_profile_id", "is", null);
    const { data: aliceRow } = await supabase
      .from("exam_scanned_submissions")
      .select("id")
      .eq("batch_id", batchId)
      .eq("matched_profile_id", alice.private_profile_id)
      .single();
    const rowId = aliceRow!.id;

    const editor = await privilegedClient();
    const monitor = await privilegedClient();
    try {
      // Hold Alice's row the way an instructor's edit would, so the worker reads Alice and then
      // waits inside exam_create_submission.
      await beginAsUser(editor, instructor.user_id);
      await editor.query("SELECT id FROM public.exam_scanned_submissions WHERE id = $1 FOR UPDATE", [rowId]);
      const { error: finErr } = await supabase.rpc("enqueue_exam_finalize", { p_batch_id: batchId });
      expect(finErr).toBeNull();
      void runExamWorker();
      const editorPid = await backendPid(editor);
      await expect
        .poll(
          async () =>
            (
              await monitor.query<{ n: number }>(
                "SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY (pg_blocking_pids(pid))",
                [editorPid]
              )
            ).rows[0].n,
          { timeout: 30_000, intervals: [100, 250, 500] }
        )
        .toBeGreaterThan(0);
      // The batch went back to review (error, then Retry) while that message is still in flight,
      // so the freeze trigger lets the re-pick through.
      await supabase.from("exam_scan_batches").update({ status: "review" }).eq("id", batchId);
      await repick(editor, rowId, carol.private_profile_id);
      await editor.query("COMMIT");
    } finally {
      await Promise.all([editor.end(), monitor.end()]);
    }

    // Keep the worker going (the refused call is retried after a backoff) until the row is finalized.
    await expect
      .poll(
        async () => {
          await runExamWorker();
          const { data } = await supabase
            .from("exam_scanned_submissions")
            .select("finalized_at")
            .eq("id", rowId)
            .single();
          return data?.finalized_at != null;
        },
        { timeout: 150_000, intervals: [2000, 5000] }
      )
      .toBe(true);

    const { data: row } = await supabase
      .from("exam_scanned_submissions")
      .select("matched_profile_id, submission_id")
      .eq("id", rowId)
      .single();
    const { data: sub } = await supabase
      .from("submissions")
      .select("profile_id")
      .eq("id", row!.submission_id!)
      .single();
    const { data: files } = await supabase
      .from("submission_files")
      .select("profile_id, storage_key")
      .eq("submission_id", row!.submission_id!);
    const { data: artifacts } = await supabase
      .from("submission_artifacts")
      .select("profile_id, data")
      .eq("submission_id", row!.submission_id!);
    const owners = {
      scanned: row!.matched_profile_id,
      submission: sub!.profile_id,
      files: [...new Set((files ?? []).map((f) => f.profile_id))],
      fileKeys: [...new Set((files ?? []).map((f) => f.storage_key?.split("/profiles/")[1]?.split("/")[0]))],
      artifacts: [...new Set((artifacts ?? []).map((a) => a.profile_id))],
      artifactKeys: [
        ...new Set(
          (artifacts ?? []).flatMap((a) =>
            ((a.data as { pages: { storage_key: string }[] }).pages ?? []).map(
              (p) => p.storage_key.split("/profiles/")[1]?.split("/")[0]
            )
          )
        )
      ]
    };
    const c = carol.private_profile_id;
    expect(owners).toEqual({ scanned: c, submission: c, files: [c], fileKeys: [c], artifacts: [c], artifactKeys: [c] });
    // The interleaving really happened: the first finalize was refused and a retry finished the job.
    const audit = await privilegedClient();
    try {
      // The worker stamps finalized_at before it archives the message, so wait for the archive.
      await expect
        .poll(
          async () => {
            const { rows: retried } = await audit.query(
              `SELECT 1 FROM pgmq.a_exam_processing
                WHERE message->>'method' = 'finalize' AND (message->'args'->>'scanned_submission_id')::bigint = $1
                  AND coalesce((message->>'retry_count')::int, 0) >= 1`,
              [rowId]
            );
            return retried.length;
          },
          { timeout: 150_000, intervals: [2000, 5000] }
        )
        .toBeGreaterThan(0);
    } finally {
      await audit.end();
    }
    // Bob's exam, finalized alongside, is untouched.
    const { data: bobSub } = await supabase
      .from("submissions")
      .select("profile_id")
      .eq("assignment_id", assignment.id)
      .eq("profile_id", bob.private_profile_id);
    expect(bobSub).toHaveLength(1);
  });
});
