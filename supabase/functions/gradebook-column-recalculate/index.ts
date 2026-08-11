import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookRowsCalculation } from "./GradebookProcessor.ts";
import * as Sentry from "npm:@sentry/deno";
import { normalizeEventFingerprint } from "../_shared/SentryFingerprint.ts";
import { sentryIdentity } from "../_shared/SentryContext.ts";
import {
  MAX_VERSION_MISMATCH_ATTEMPTS,
  partitionVersionMismatchRetries,
  selectVersionMismatchedRows,
  versionMismatchBackoffSeconds,
  versionMismatchRowKey,
  type GradebookRowBatchResult
} from "../_shared/gradebookVersionMismatch.ts";

// Declare EdgeRuntime for type safety
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    beforeSend: normalizeEventFingerprint,
    ...sentryIdentity(),
    dsn: Deno.env.get("SENTRY_DSN")!,
    sendDefaultPii: true,
    integrations: [],
    tracesSampleRate: 0,
    ignoreErrors: ["Deno.core.runMicrotasks() is not supported in this environment"]
  });
}

// Guard to prevent multiple concurrent batch handlers per runtime instance
let started = false;

export type QueueMessage<T> = {
  msg_id: number;
  read_ct: number;
  vt: string;
  enqueued_at: string;
  message: T;
};

type RowMessage = {
  class_id: number;
  gradebook_id: number;
  student_id: string;
  is_private: boolean;
  /**
   * How many times this row has already been re-enqueued by version-mismatch recovery.
   *
   * It has to live in the payload. `update_gradebook_rows_batch` archives every message id it is
   * handed, unconditionally, so the recovery re-enqueue is a brand-new pgmq message whose `read_ct`
   * starts at 0 — pgmq's own read counter can never bound this loop. Absent on messages enqueued by
   * `enqueue_gradebook_row_recalculation`, which is the same as 0.
   */
  version_mismatch_attempt?: number;
};

const SCOPED_FETCH_THRESHOLD = 50;
const MAX_BATCH_UPDATE_SIZE = 75; // Maximum number of students to update per RPC call
const RECALC_QUEUE = "gradebook_row_recalculate";
const RECALC_DLQ = "gradebook_row_recalculate_dlq";
const workerId = crypto.randomUUID();

// Helper to create unique row key for gradebook_row_recalc_state
/**
 * Re-enqueue rows that lost the optimistic-version race, keeping their `is_recalculating` claim
 * held until the retry itself completes.
 *
 * Shared by the bulk and scoped paths. It previously existed only in the scoped path, so a bulk
 * version conflict left the row flagged as recalculating with nothing scheduled to pick it up: the
 * RPC had already archived every message for that row, so the row sat dirty and claimed with no
 * message and no error anywhere.
 *
 * Two things have to be true for this to be safe, and neither was:
 *   - the re-enqueue must be bounded, because the RPC archives the old message and `send_batch`
 *     mints a new one with `read_ct` at 0, so pgmq's own retry limit does not apply;
 *   - the claim must OUTLIVE the hand-off. A retry is enqueued with backoff, so there is a delay
 *     window before the new message is even visible. Releasing the claim on hand-off put the row
 *     into (dirty = true, is_recalculating = false) for that whole window, and that is the one
 *     state `enqueue_gradebook_row_recalculation` refuses to enqueue for: a grade change landing
 *     in the window neither queued another pass nor bumped `version`, so the delayed retry saw no
 *     mismatch, committed scores computed from pre-change inputs, and cleared `dirty`. Holding the
 *     claim is also exactly what the dead-letter branch below does, and for the same reason.
 *
 * A held claim is the normal state for a queued row -- `enqueue_gradebook_row_recalculation` sets
 * (dirty = true, is_recalculating = true) whenever it enqueues -- and it is self-healing: with the
 * claim set, the gating rules ALLOW re-enqueue, so a later change still queues work even if the
 * retry message is somehow lost. The batch RPC releases the claim when the retry finally succeeds.
 */
async function recoverVersionMismatchedRows({
  adminSupabase,
  classId,
  gradebook_id,
  results,
  attemptByRow,
  workerId,
  label,
  scope
}: {
  adminSupabase: SupabaseClient<Database>;
  classId: number;
  gradebook_id: number;
  results: GradebookRowBatchResult[];
  /** Recovery attempts already recorded on the incoming message, keyed by versionMismatchRowKey. */
  attemptByRow: Map<string, number>;
  workerId: string;
  label: string;
  scope: Sentry.Scope;
}): Promise<number> {
  const mismatchedRows = selectVersionMismatchedRows(results);
  if (mismatchedRows.length === 0) {
    return 0;
  }

  const { retries, dead } = partitionVersionMismatchRetries(mismatchedRows, (row) =>
    Math.max(0, attemptByRow.get(versionMismatchRowKey(row.student_id, row.is_private)) ?? 0)
  );

  console.log(
    `[DEBUG] ${workerId} VERSION_MISMATCH_RECOVERY (${label}): ${mismatchedRows.length} mismatched rows -> ${retries.reduce((n, r) => n + r.rows.length, 0)} retried, ${dead.length} dead-lettered`
  );

  // Hand the row off and KEEP the claim.
  //
  // `enqueue_gradebook_row_recalculation` refuses to enqueue for a row that is
  // (dirty = true, is_recalculating = false) -- its "already queued, skip" branch -- and allows
  // re-enqueue when the claim is held. Releasing the claim here therefore silenced exactly the
  // changes that need to invalidate the pending retry, for the whole backoff delay. Holding it
  // costs nothing: it is the state every queued row is already in.
  for (const { attempt, rows } of retries) {
    const delaySeconds = versionMismatchBackoffSeconds(attempt);
    const { error: enqueueError } = await adminSupabase.schema("pgmq_public").rpc("send_batch", {
      queue_name: RECALC_QUEUE,
      messages: rows.map((row) => ({
        class_id: classId,
        gradebook_id,
        student_id: row.student_id,
        is_private: row.is_private,
        version_mismatch_attempt: attempt
      })),
      sleep_seconds: delaySeconds
    });
    if (enqueueError) {
      console.error(
        `[DEBUG] ${workerId} VERSION_MISMATCH_RECOVERY (${label}): failed to re-enqueue ${rows.length} rows on attempt ${attempt}; leaving is_recalculating set so future changes still enqueue`,
        enqueueError
      );
      Sentry.captureException(enqueueError, scope);
      continue;
    }
    console.log(
      `[DEBUG] ${workerId} VERSION_MISMATCH_RECOVERY (${label}): re-enqueued ${rows.length} rows, attempt ${attempt}/${MAX_VERSION_MISMATCH_ATTEMPTS}, visible in ${delaySeconds}s`
    );
  }

  if (dead.length > 0) {
    // Past the ceiling. Route to the DLQ, matching github-async-worker/discord-async-worker: a
    // sibling pgmq queue plus a Sentry event tagged dlq, so the row is a durable inspectable message
    // and a paging-visible signal rather than a silent drop.
    const { error: dlqError } = await adminSupabase.schema("pgmq_public").rpc("send_batch", {
      queue_name: RECALC_DLQ,
      messages: dead.map(({ row, attempt }) => ({
        class_id: classId,
        gradebook_id,
        student_id: row.student_id,
        is_private: row.is_private,
        version_mismatch_attempt: attempt,
        expected_version: row.expected_version ?? null,
        current_version: row.current_version ?? null,
        reason: "version_mismatch_retry_ceiling",
        worker_id: workerId,
        failed_at: new Date().toISOString()
      })),
      sleep_seconds: 0
    });

    const dlqScope = scope.clone();
    dlqScope.setTag("dlq", "true");
    dlqScope.setTag("queue", RECALC_DLQ);
    dlqScope.setContext("dead_letter_queue", {
      queue: RECALC_DLQ,
      reason: "version_mismatch_retry_ceiling",
      max_attempts: MAX_VERSION_MISMATCH_ATTEMPTS,
      class_id: classId,
      gradebook_id,
      row_count: dead.length,
      rows: dead.slice(0, 20).map(({ row, attempt }) => ({
        student_id: row.student_id,
        is_private: row.is_private,
        attempt,
        expected_version: row.expected_version ?? null,
        current_version: row.current_version ?? null
      })),
      dlq_send_failed: Boolean(dlqError)
    });

    if (dlqError) {
      console.error(
        `[DEBUG] ${workerId} VERSION_MISMATCH_RECOVERY (${label}): failed to dead-letter ${dead.length} rows`,
        dlqError
      );
      Sentry.captureException(dlqError, dlqScope);
    } else {
      console.error(
        `[DEBUG] ${workerId} VERSION_MISMATCH_RECOVERY (${label}): dead-lettered ${dead.length} rows after ${MAX_VERSION_MISMATCH_ATTEMPTS} attempts`
      );
      Sentry.captureMessage(
        `Gradebook rows exceeded version-mismatch retry ceiling (${MAX_VERSION_MISMATCH_ATTEMPTS}); sent to ${RECALC_DLQ}`,
        dlqScope
      );
    }

    // Their is_recalculating claim stays put, like the retried rows above. Releasing it while
    // dirty stays true is the one combination enqueue_gradebook_row_recalculation skips, which
    // would freeze the row for good; keeping the claim means the next real grade change still
    // enqueues a message and the row can recover, while the DLQ entry records that we gave up.
  }

  // The claim is deliberately NOT cleared for handed-off rows, for the same reason the
  // dead-lettered rows above keep theirs. The retry message is durable and the batch RPC releases
  // the claim when that retry succeeds; until then the row stays (dirty = true,
  // is_recalculating = true), which is both the state every queued row is in and the state that
  // lets a concurrent grade change enqueue another pass and bump `version`, so a stale retry loses
  // the race instead of committing over it.

  return mismatchedRows.length;
}

function rowKey(classId: number, gradebookId: number, studentId: string, isPrivate: boolean): string {
  return `${classId}:${gradebookId}:${studentId}:${isPrivate}`;
}

async function processRowsAll(
  adminSupabase: ReturnType<typeof createClient<Database>>,
  scope: Sentry.Scope,
  queueMessages: QueueMessage<RowMessage>[]
): Promise<boolean> {
  // Track all row keys being processed to detect duplicates
  const rowKeyCounts = new Map<string, number>();
  const rowKeyToMessages = new Map<string, QueueMessage<RowMessage>[]>();

  // Deduplicate by (gradebook_id, student_id, is_private)
  // Aggregate duplicate message IDs so all messages can be archived
  const keyFor = (m: RowMessage) => `${m.gradebook_id}:${m.student_id}:${m.is_private}`;
  const rows = new Map<string, { primary: QueueMessage<RowMessage>; duplicateMsgIds: number[] }>();
  for (const msg of queueMessages) {
    const k = keyFor(msg.message);
    // Track row keys for duplicate detection
    const fullRowKey = rowKey(
      msg.message.class_id,
      msg.message.gradebook_id,
      msg.message.student_id,
      msg.message.is_private
    );
    rowKeyCounts.set(fullRowKey, (rowKeyCounts.get(fullRowKey) ?? 0) + 1);
    if (!rowKeyToMessages.has(fullRowKey)) {
      rowKeyToMessages.set(fullRowKey, []);
    }
    rowKeyToMessages.get(fullRowKey)!.push(msg);

    // Aggregate duplicate message IDs - critical for archiving all messages
    const existing = rows.get(k);
    if (!existing) {
      rows.set(k, { primary: msg, duplicateMsgIds: [] });
    } else {
      // Add this message's ID to the duplicate list so it gets archived
      existing.duplicateMsgIds.push(msg.msg_id);
      // Carry the highest recovery attempt across the duplicates. Only the primary message's
      // payload survives deduplication, so dropping the counter here would silently reset the
      // retry ceiling every time a row happened to be enqueued twice.
      existing.primary.message.version_mismatch_attempt = Math.max(
        existing.primary.message.version_mismatch_attempt ?? 0,
        msg.message.version_mismatch_attempt ?? 0
      );
      console.log(
        `[DEBUG] ${workerId} Found duplicate message for ${k}: msg_id ${msg.msg_id} added to duplicates (total duplicates: ${existing.duplicateMsgIds.length})`
      );
    }
  }

  // Log duplicate row keys detected
  const duplicates = Array.from(rowKeyCounts.entries()).filter(([, count]) => count > 1);
  if (duplicates.length > 0) {
    console.log(`[DEBUG] ${workerId} Found ${duplicates.length} duplicate row keys in batch:`);
    for (const [rowKey, count] of duplicates) {
      const messages = rowKeyToMessages.get(rowKey)!;
      console.log(
        `[DEBUG] ${workerId} Row key ${rowKey} appears ${count} times (msg_ids: ${messages.map((m) => m.msg_id).join(", ")})`
      );
    }
  } else {
    console.log(`[DEBUG] ${workerId} No duplicate row keys detected in batch of ${queueMessages.length} messages`);
  }

  // Group by (class_id, gradebook_id, is_private)
  type RowEntry = { key: string; msg: QueueMessage<RowMessage>; duplicateMsgIds: number[] };
  const gbToRows = new Map<string, RowEntry[]>();
  for (const [key, entry] of rows.entries()) {
    const { class_id, gradebook_id, is_private } = entry.primary.message;
    const gbKey = `${class_id}:${gradebook_id}:${is_private}`;
    const arr = gbToRows.get(gbKey) ?? [];
    arr.push({ key, msg: entry.primary, duplicateMsgIds: entry.duplicateMsgIds });
    gbToRows.set(gbKey, arr);
  }

  let didWork = false;
  for (const [gbKey, rowEntries] of gbToRows.entries()) {
    const [classIdStr, gradebookIdStr, isPrivateStr] = gbKey.split(":");
    const classId = Number(classIdStr);
    const gradebook_id = Number(gradebookIdStr);
    const is_private = isPrivateStr === "true";
    const gbScope = scope.clone();
    gbScope.setTag("class_id", classId);
    gbScope.setTag("gradebook_id", gradebook_id);

    const isBulk = rowEntries.length > SCOPED_FETCH_THRESHOLD;
    console.log(`${workerId} Processing ${rowEntries.length} rows for gradebook ${gradebook_id} (isBulk: ${isBulk})`);

    // Recovery attempts already recorded on the incoming messages, so the ceiling survives the
    // archive-and-resend cycle that resets pgmq's own read_ct. Shared by both paths below.
    const attemptByRow = new Map<string, number>();
    for (const entry of rowEntries) {
      const key = versionMismatchRowKey(entry.msg.message.student_id, entry.msg.message.is_private);
      attemptByRow.set(key, Math.max(attemptByRow.get(key) ?? 0, entry.msg.message.version_mismatch_attempt ?? 0));
    }

    if (isBulk) {
      const studentIds = rowEntries.map((e) => e.msg.message.student_id);

      const allGcs: Array<{
        id: number;
        gradebook_column_id: number;
        is_missing: boolean;
        is_excused: boolean;
        is_droppable: boolean;
        score_override: number | null;
        score: number | null;
        released: boolean;
        score_override_note: string | null;
        incomplete_values: Database["public"]["Tables"]["gradebook_column_students"]["Row"]["incomplete_values"];
        student_id: string;
      }> = [];
      let from = 0;
      const pageSize = 1000;
      while (true) {
        const to = from + pageSize - 1;
        const { data: page, error: gcsError } = await adminSupabase
          .from("gradebook_column_students")
          .select(
            "id, gradebook_column_id, is_missing, is_excused, is_droppable, score_override, score, released, score_override_note, incomplete_values, student_id"
          )
          .eq("class_id", classId)
          .eq("gradebook_id", gradebook_id)
          .eq("is_private", is_private)
          .order("id", { ascending: true })
          .range(from, to);
        if (gcsError) {
          Sentry.captureException(gcsError, gbScope);
          break;
        }
        if (!page || page.length === 0) break;
        allGcs.push(...(page as unknown as typeof allGcs));
        if (page.length < pageSize) break;
        from += pageSize;
      }

      const grouped: Map<string, typeof allGcs> = new Map();
      for (const r of allGcs) {
        const arr = grouped.get(r.student_id as string) ?? [];
        arr.push(r);
        grouped.set(r.student_id as string, arr);
      }

      const rowsInput = studentIds.map((sid) => ({ student_id: sid, is_private, gcsRows: grouped.get(sid) ?? [] }));
      const updatesByStudent = await processGradebookRowsCalculation(adminSupabase, gbScope, {
        class_id: classId,
        gradebook_id,
        rows: rowsInput
      });

      console.log(`Upserting ${rowEntries.length} rows for gradebook ${gradebook_id}`);

      // Track row keys being upserted for duplicate detection
      const upsertRowKeys = rowEntries.map((entry) => {
        const key = rowKey(classId, gradebook_id, entry.msg.message.student_id, is_private);
        return key;
      });
      const upsertRowKeyCounts = new Map<string, number>();
      for (const key of upsertRowKeys) {
        upsertRowKeyCounts.set(key, (upsertRowKeyCounts.get(key) ?? 0) + 1);
      }
      const duplicateUpserts = Array.from(upsertRowKeyCounts.entries()).filter(([, count]) => count > 1);
      if (duplicateUpserts.length > 0) {
        console.log(
          `[DEBUG] ${workerId} UPSERT: Found ${duplicateUpserts.length} duplicate row keys in upsert batch for gradebook ${gradebook_id}:`
        );
        for (const [rowKey, count] of duplicateUpserts) {
          console.log(`[DEBUG] ${workerId} UPSERT: Row key ${rowKey} appears ${count} times in upsert`);
        }
      }
      console.log(
        `[DEBUG] ${workerId} UPSERT: About to upsert ${rowEntries.length} rows for gradebook ${gradebook_id} (unique keys: ${new Set(upsertRowKeys).size}): ${Array.from(new Set(upsertRowKeys)).slice(0, 10).join(", ")}${upsertRowKeys.length > 10 ? "..." : ""}`
      );

      // Batch upsert all rows in a single statement to trigger broadcast once
      // Sort by primary key to prevent deadlocks when multiple workers process overlapping rows
      const batchUpsertData = rowEntries
        .map((entry) => ({
          class_id: classId,
          gradebook_id,
          student_id: entry.msg.message.student_id,
          is_private,
          dirty: true,
          is_recalculating: true,
          updated_at: new Date().toISOString()
        }))
        .sort((a, b) => {
          // Sort by primary key columns: class_id, gradebook_id, student_id, is_private
          if (a.class_id !== b.class_id) return a.class_id - b.class_id;
          if (a.gradebook_id !== b.gradebook_id) return a.gradebook_id - b.gradebook_id;
          if (a.student_id !== b.student_id) return a.student_id.localeCompare(b.student_id);
          return a.is_private === b.is_private ? 0 : a.is_private ? 1 : -1;
        });

      const { error: upsertError } = await adminSupabase
        .from("gradebook_row_recalc_state")
        .upsert(batchUpsertData, { onConflict: "class_id,gradebook_id,student_id,is_private" });

      if (upsertError) {
        console.error(
          `[DEBUG] ${workerId} UPSERT ERROR: Failed to upsert rows for gradebook ${gradebook_id}:`,
          upsertError
        );
        Sentry.captureException(upsertError, gbScope);
      } else {
        console.log(
          `[DEBUG] ${workerId} UPSERT: Successfully upserted ${rowEntries.length} rows for gradebook ${gradebook_id}`
        );
      }

      // Read versions AFTER the upsert so expected_version matches the
      // post-upsert value. Reading before the upsert caused systematic
      // version mismatches that left rows permanently stuck.
      const versionsByStudent = new Map<string, number>();
      {
        let vFrom = 0;
        const vPageSize = 1000;
        while (true) {
          const vTo = vFrom + vPageSize - 1;
          const { data: verPage, error: verErr } = await adminSupabase
            .from("gradebook_row_recalc_state")
            .select("student_id, version")
            .eq("class_id", classId)
            .eq("gradebook_id", gradebook_id)
            .eq("is_private", is_private)
            .order("student_id", { ascending: true })
            .range(vFrom, vTo);
          if (verErr) {
            Sentry.captureException(verErr, gbScope);
            break;
          }
          if (!verPage || verPage.length === 0) break;
          for (const row of verPage as unknown as Array<{ student_id: string; version: number }>) {
            versionsByStudent.set(row.student_id, row.version);
          }
          if (verPage.length < vPageSize) break;
          vFrom += vPageSize;
        }
      }

      // Batch update all students in a single RPC call
      // Group entries by student to collect message IDs
      const entriesByStudent = new Map<string, typeof rowEntries>();
      for (const entry of rowEntries) {
        const { student_id } = entry.msg.message;
        const arr = entriesByStudent.get(student_id) ?? [];
        arr.push(entry);
        entriesByStudent.set(student_id, arr);
      }

      const batchUpdates = Array.from(entriesByStudent.entries()).map(([student_id, entries]) => {
        const updates = updatesByStudent.get(student_id) ?? [];
        const expectedVersion = versionsByStudent.get(student_id) ?? 0;

        // Collect all message IDs for this student (including duplicates)
        const messageIds = entries.flatMap((entry) => [entry.msg.msg_id, ...entry.duplicateMsgIds]);

        // Include students even with no updates - the RPC will clear state when version matches
        return {
          class_id: classId,
          gradebook_id,
          student_id,
          is_private,
          expected_version: expectedVersion,
          message_ids: messageIds,
          updates: updates
        };
      });

      // Log version info for debugging (after batchUpdates is created)
      if (batchUpdates.length > 0) {
        const sampleExpectedVersions = batchUpdates.slice(0, 5).map((bu) => ({
          student_id: bu.student_id,
          expected_version: bu.expected_version,
          actual_version: versionsByStudent.get(bu.student_id) ?? null,
          version_matches: (versionsByStudent.get(bu.student_id) ?? -1) === bu.expected_version
        }));
        console.log(
          `[DEBUG] ${workerId} VERSION CHECK: Sample expected vs actual versions (first 5):`,
          JSON.stringify(sampleExpectedVersions, null, 2)
        );
      }

      if (batchUpdates.length > 0) {
        // Split into chunks of MAX_BATCH_UPDATE_SIZE to avoid timeouts
        const chunks: (typeof batchUpdates)[] = [];
        for (let i = 0; i < batchUpdates.length; i += MAX_BATCH_UPDATE_SIZE) {
          chunks.push(batchUpdates.slice(i, i + MAX_BATCH_UPDATE_SIZE));
        }

        console.log(
          `[DEBUG] ${workerId} BATCH_UPDATE: Processing ${batchUpdates.length} students in ${chunks.length} chunks (max ${MAX_BATCH_UPDATE_SIZE} per chunk) for gradebook ${gradebook_id}`
        );

        // Process each chunk separately
        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex];
          const allMessageIds = chunk.flatMap((bu) => bu.message_ids);

          console.log(
            `[DEBUG] ${workerId} BATCH_UPDATE: Processing chunk ${chunkIndex + 1}/${chunks.length} with ${chunk.length} students and ${allMessageIds.length} message IDs`
          );

          const batchStartTime = Date.now();
          const { error: batchError, data: batchResults } = await adminSupabase.rpc("update_gradebook_rows_batch", {
            p_batch_updates:
              chunk as unknown as Database["public"]["Functions"]["update_gradebook_rows_batch"]["Args"]["p_batch_updates"]
          });
          const batchDuration = Date.now() - batchStartTime;

          if (batchError) {
            console.error(
              `[DEBUG] ${workerId} BATCH_UPDATE ERROR (chunk ${chunkIndex + 1}/${chunks.length}): Failed to batch update rows for gradebook ${gradebook_id} after ${batchDuration}ms. Messages NOT archived: [${allMessageIds.join(", ")}]`,
              batchError
            );
            Sentry.captureException(batchError, gbScope);
            console.error(
              `[DEBUG] ${workerId} ARCHIVE FAILED (chunk ${chunkIndex + 1}): ${allMessageIds.length} messages were NOT archived due to RPC error. These will be re-read when visibility timeout expires.`
            );
            continue; // Skip to next chunk
          }
          // Extract results array from the RPC response object
          const rpcResponse = batchResults as unknown as {
            results?: Array<{
              student_id: string;
              is_private: boolean;
              updated_count: number;
              version_matched: boolean;
              cleared: boolean;
              expected_version?: number | null;
              current_version?: number | null;
              error?: string;
            }>;
            archive_count?: number;
            archive_errors?: number;
            expanded_count?: number;
            version_matched_count?: number;
            updated_gcs_count?: number;
            cleared_state_count?: number;
          };
          const results = rpcResponse?.results ?? [];

          console.log(
            `[DEBUG] ${workerId} BATCH_UPDATE (chunk ${chunkIndex + 1}/${chunks.length}): Completed in ${batchDuration}ms. Processed ${results.length} students, archived ${rpcResponse?.archive_count ?? 0}/${allMessageIds.length} messages`
          );

          if (rpcResponse?.archive_errors && rpcResponse.archive_errors > 0) {
            console.warn(
              `[DEBUG] ${workerId} ARCHIVE ERRORS (chunk ${chunkIndex + 1}): ${rpcResponse.archive_errors} messages failed to archive.`
            );
          }

          // Log summary for this chunk
          const clearedCount = results.filter((r) => r.cleared).length;
          const versionMismatchCount = results.filter((r) => !r.version_matched && !r.error).length;
          const errorCount = results.filter((r) => r.error).length;

          if (clearedCount < results.length) {
            console.warn(
              `[DEBUG] ${workerId} BATCH_UPDATE (chunk ${chunkIndex + 1}): Only ${clearedCount}/${results.length} rows cleared. Version mismatches: ${versionMismatchCount}, Errors: ${errorCount}`
            );
          }

          // The bulk path used to compute versionMismatchCount only to log it. Recovery lived
          // solely in the scoped path below, so a version conflict here left the row marked
          // is_recalculating forever — which also blocks every future enqueue for that row.
          await recoverVersionMismatchedRows({
            adminSupabase,
            classId,
            gradebook_id,
            results,
            attemptByRow,
            workerId,
            label: "bulk",
            scope: gbScope
          });
        }
      } else {
        console.log(
          `[DEBUG] ${workerId} BATCH_UPDATE SKIP: No students to process for gradebook ${gradebook_id} (this should not happen)`
        );
      }
    } else {
      const studentIds = rowEntries.map((e) => e.msg.message.student_id);
      const { data: scopedGcs, error: scopedErr } = await adminSupabase
        .from("gradebook_column_students")
        .select(
          "id, gradebook_column_id, is_missing, is_excused, is_droppable, score_override, score, released, score_override_note, incomplete_values, student_id"
        )
        .eq("class_id", classId)
        .eq("gradebook_id", gradebook_id)
        .eq("is_private", is_private)
        .in("student_id", studentIds);
      if (scopedErr) {
        Sentry.captureException(scopedErr, gbScope);
        continue;
      }

      const groupedScoped: Map<string, NonNullable<typeof scopedGcs>> = new Map();
      for (const r of scopedGcs ?? []) {
        const arr = groupedScoped.get(r.student_id as string) ?? [];
        arr.push(r);
        groupedScoped.set(r.student_id as string, arr);
      }

      const rowsInputScoped = studentIds.map((sid) => ({
        student_id: sid,
        is_private,
        gcsRows: groupedScoped.get(sid) ?? []
      }));
      const updatesByStudentScoped = await processGradebookRowsCalculation(adminSupabase, gbScope, {
        class_id: classId,
        gradebook_id,
        rows: rowsInputScoped
      });

      // Track row keys being upserted for duplicate detection
      const upsertRowKeysScoped = rowEntries.map((entry) => {
        const key = rowKey(classId, gradebook_id, entry.msg.message.student_id, is_private);
        return key;
      });
      const upsertRowKeyCountsScoped = new Map<string, number>();
      for (const key of upsertRowKeysScoped) {
        upsertRowKeyCountsScoped.set(key, (upsertRowKeyCountsScoped.get(key) ?? 0) + 1);
      }
      const duplicateUpsertsScoped = Array.from(upsertRowKeyCountsScoped.entries()).filter(([, count]) => count > 1);
      if (duplicateUpsertsScoped.length > 0) {
        console.log(
          `[DEBUG] ${workerId} UPSERT (scoped): Found ${duplicateUpsertsScoped.length} duplicate row keys in upsert batch for gradebook ${gradebook_id}:`
        );
        for (const [rowKey, count] of duplicateUpsertsScoped) {
          console.log(`[DEBUG] ${workerId} UPSERT (scoped): Row key ${rowKey} appears ${count} times in upsert`);
        }
      }
      console.log(
        `[DEBUG] ${workerId} UPSERT (scoped): About to upsert ${rowEntries.length} rows for gradebook ${gradebook_id} (unique keys: ${new Set(upsertRowKeysScoped).size}): ${Array.from(new Set(upsertRowKeysScoped)).slice(0, 10).join(", ")}${upsertRowKeysScoped.length > 10 ? "..." : ""}`
      );

      // Batch upsert all rows in a single statement to trigger broadcast once
      // Sort by primary key to prevent deadlocks when multiple workers process overlapping rows
      const batchUpsertDataScoped = rowEntries
        .map((entry) => ({
          class_id: classId,
          gradebook_id,
          student_id: entry.msg.message.student_id,
          is_private,
          dirty: true,
          is_recalculating: true,
          updated_at: new Date().toISOString()
        }))
        .sort((a, b) => {
          // Sort by primary key columns: class_id, gradebook_id, student_id, is_private
          if (a.class_id !== b.class_id) return a.class_id - b.class_id;
          if (a.gradebook_id !== b.gradebook_id) return a.gradebook_id - b.gradebook_id;
          if (a.student_id !== b.student_id) return a.student_id.localeCompare(b.student_id);
          return a.is_private === b.is_private ? 0 : a.is_private ? 1 : -1;
        });

      const { error: upsertErrorScoped } = await adminSupabase
        .from("gradebook_row_recalc_state")
        .upsert(batchUpsertDataScoped, { onConflict: "class_id,gradebook_id,student_id,is_private" });

      if (upsertErrorScoped) {
        console.error(
          `[DEBUG] ${workerId} UPSERT ERROR (scoped): Failed to upsert rows for gradebook ${gradebook_id}:`,
          upsertErrorScoped
        );
        Sentry.captureException(upsertErrorScoped, gbScope);
        continue; // Abort this gradebook - do not run batch RPC/archive; messages will retry on visibility timeout
      } else {
        console.log(
          `[DEBUG] ${workerId} UPSERT (scoped): Successfully upserted ${rowEntries.length} rows for gradebook ${gradebook_id}`
        );
      }

      // Read versions AFTER the upsert so expected_version matches the
      // post-upsert value. Reading before the upsert caused systematic
      // version mismatches: the upsert increments version, then the
      // batch RPC tried to clear with the stale pre-upsert version.
      const versionsByStudentScoped = new Map<string, number>();
      {
        const { data: verRows, error: verErr } = await adminSupabase
          .from("gradebook_row_recalc_state")
          .select("student_id, version")
          .eq("class_id", classId)
          .eq("gradebook_id", gradebook_id)
          .eq("is_private", is_private)
          .in("student_id", studentIds);
        if (verErr) {
          Sentry.captureException(verErr, gbScope);
        }
        for (const row of (verRows as unknown as Array<{ student_id: string; version: number }>) ?? []) {
          versionsByStudentScoped.set(row.student_id, row.version);
        }
      }

      // Batch update all students in a single RPC call
      // Group entries by student to collect message IDs
      const entriesByStudentScoped = new Map<string, typeof rowEntries>();
      for (const entry of rowEntries) {
        const { student_id } = entry.msg.message;
        const arr = entriesByStudentScoped.get(student_id) ?? [];
        arr.push(entry);
        entriesByStudentScoped.set(student_id, arr);
      }

      const batchUpdatesScoped = Array.from(entriesByStudentScoped.entries()).map(([student_id, entries]) => {
        const updates = updatesByStudentScoped.get(student_id) ?? [];
        const expectedVersion = versionsByStudentScoped.get(student_id) ?? 0;

        // Collect all message IDs for this student (including duplicates)
        const messageIds = entries.flatMap((entry) => [entry.msg.msg_id, ...entry.duplicateMsgIds]);

        // Include students even with no updates - the RPC will clear state when version matches
        return {
          class_id: classId,
          gradebook_id,
          student_id,
          is_private,
          expected_version: expectedVersion,
          message_ids: messageIds,
          updates: updates
        };
      });

      if (batchUpdatesScoped.length > 0) {
        // Split into chunks of MAX_BATCH_UPDATE_SIZE to avoid timeouts
        const chunksScoped: (typeof batchUpdatesScoped)[] = [];
        for (let i = 0; i < batchUpdatesScoped.length; i += MAX_BATCH_UPDATE_SIZE) {
          chunksScoped.push(batchUpdatesScoped.slice(i, i + MAX_BATCH_UPDATE_SIZE));
        }

        console.log(
          `[DEBUG] ${workerId} BATCH_UPDATE (scoped): Processing ${batchUpdatesScoped.length} students in ${chunksScoped.length} chunks (max ${MAX_BATCH_UPDATE_SIZE} per chunk) for gradebook ${gradebook_id}`
        );

        // Process each chunk separately
        for (let chunkIndex = 0; chunkIndex < chunksScoped.length; chunkIndex++) {
          const chunkScoped = chunksScoped[chunkIndex];
          const allMessageIdsScoped = chunkScoped.flatMap((bu) => bu.message_ids);

          console.log(
            `[DEBUG] ${workerId} BATCH_UPDATE (scoped): Processing chunk ${chunkIndex + 1}/${chunksScoped.length} with ${chunkScoped.length} students and ${allMessageIdsScoped.length} message IDs`
          );

          const batchStartTimeScoped = Date.now();
          const { error: batchErrorScoped, data: batchResultsScoped } = await adminSupabase.rpc(
            "update_gradebook_rows_batch",
            {
              p_batch_updates:
                chunkScoped as unknown as Database["public"]["Functions"]["update_gradebook_rows_batch"]["Args"]["p_batch_updates"]
            }
          );
          const batchDurationScoped = Date.now() - batchStartTimeScoped;

          if (batchErrorScoped) {
            console.error(
              `[DEBUG] ${workerId} BATCH_UPDATE ERROR (scoped, chunk ${chunkIndex + 1}/${chunksScoped.length}): Failed to batch update rows for gradebook ${gradebook_id} after ${batchDurationScoped}ms. Messages NOT archived: [${allMessageIdsScoped.join(", ")}]`,
              batchErrorScoped
            );
            Sentry.captureException(batchErrorScoped, gbScope);
            console.error(
              `[DEBUG] ${workerId} ARCHIVE FAILED (scoped, chunk ${chunkIndex + 1}): ${allMessageIdsScoped.length} messages were NOT archived due to RPC error. These will be re-read when visibility timeout expires.`
            );
            continue; // Skip to next chunk
          }
          // Extract results array from the RPC response object
          const rpcResponseScoped = batchResultsScoped as unknown as {
            results?: Array<{
              student_id: string;
              is_private: boolean;
              updated_count: number;
              version_matched: boolean;
              cleared: boolean;
              expected_version?: number | null;
              current_version?: number | null;
              error?: string;
            }>;
            archive_count?: number;
            archive_errors?: number;
            expanded_count?: number;
            version_matched_count?: number;
            updated_gcs_count?: number;
            cleared_state_count?: number;
          };
          const results = rpcResponseScoped?.results ?? [];

          console.log(
            `[DEBUG] ${workerId} BATCH_UPDATE (scoped, chunk ${chunkIndex + 1}/${chunksScoped.length}): Completed in ${batchDurationScoped}ms. Processed ${results.length} students, archived ${rpcResponseScoped?.archive_count ?? 0}/${allMessageIdsScoped.length} messages`
          );

          if (rpcResponseScoped?.archive_errors && rpcResponseScoped.archive_errors > 0) {
            console.warn(
              `[DEBUG] ${workerId} ARCHIVE ERRORS (scoped, chunk ${chunkIndex + 1}): ${rpcResponseScoped.archive_errors} messages failed to archive.`
            );
          }

          // Log summary for this chunk
          const clearedCount = results.filter((r) => r.cleared).length;
          const versionMismatchCount = results.filter((r) => !r.version_matched && !r.error).length;
          const errorCount = results.filter((r) => r.error).length;

          if (clearedCount < results.length) {
            console.warn(
              `[DEBUG] ${workerId} BATCH_UPDATE (scoped, chunk ${chunkIndex + 1}): Only ${clearedCount}/${results.length} rows cleared. Version mismatches: ${versionMismatchCount}, Errors: ${errorCount}`
            );
          }

          await recoverVersionMismatchedRows({
            adminSupabase,
            classId,
            gradebook_id,
            results,
            attemptByRow,
            workerId,
            label: "scoped",
            scope: gbScope
          });
        }
      } else {
        console.log(
          `[DEBUG] ${workerId} BATCH_UPDATE SKIP (scoped): No students to process for gradebook ${gradebook_id} (this should not happen)`
        );
      }
    } // end else (scoped/non-bulk path)

    didWork = true;
  }

  return didWork;
}

/**
 * Process a batch of gradebook cell calculations with dependency coordination.
 *
 */
export async function processBatch(
  adminSupabase: ReturnType<typeof createClient<Database>>,
  scope: Sentry.Scope,
  maxMessages = 200
) {
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "gradebook_row_recalculate",
    sleep_seconds: 60, // Short sleep since we're polling frequently
    n: maxMessages
  });
  if (result.error) {
    Sentry.captureException(result.error, scope);
    console.error("Queue read error:", result.error);
    return false;
  }

  scope.setTag("queue_length", result.data?.length || 0);
  if (result.data && result.data.length > 0) {
    const queueMessages = result.data as QueueMessage<RowMessage>[];

    // Log message details including read_ct to track stuck messages
    const messageDetails = queueMessages.map((msg) => ({
      msg_id: msg.msg_id,
      read_ct: msg.read_ct,
      enqueued_at: msg.enqueued_at,
      message: msg.message
    }));
    console.log(
      `${workerId} Processing ${queueMessages.length} messages in a single pass. Message details:`,
      JSON.stringify(messageDetails, null, 2)
    );

    // Log high read_ct messages that might be stuck
    const highReadCtMessages = queueMessages.filter((msg) => msg.read_ct > 5);
    if (highReadCtMessages.length > 0) {
      console.warn(
        `${workerId} WARNING: Found ${highReadCtMessages.length} messages with read_ct > 5 (possibly stuck):`,
        highReadCtMessages.map((m) => ({
          msg_id: m.msg_id,
          read_ct: m.read_ct,
          message: m.message
        }))
      );
    }

    const didWork = await processRowsAll(adminSupabase, scope, queueMessages);
    return didWork;
  } else {
    // console.log("No messages in queue");
    return false;
  }
}

export async function runBatchHandler() {
  const scope = new Sentry.Scope();
  scope.setTag("function", "gradebook_column_recalculate");

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let isRunning = true;
  let consecutiveErrors = 0;
  const maxConsecutiveErrors = 5;

  // Handle graceful shutdown
  const controller = new AbortController();
  const shutdownHandler = () => {
    console.log(`${workerId} Received shutdown signal, stopping batch handler...`);
    isRunning = false;
    controller.abort();
  };

  // Listen for termination signals (if supported in edge runtime)
  try {
    Deno.addSignalListener("SIGINT", shutdownHandler);
    Deno.addSignalListener("SIGTERM", shutdownHandler);
  } catch (e) {
    console.error("Error adding signal listeners:", e);
    // Signal listeners might not be available in edge runtime
    console.log("Signal listeners not available in this environment");
  }

  while (isRunning) {
    try {
      const hasWork = await processBatch(adminSupabase, scope);
      consecutiveErrors = 0; // Reset error count on successful processing

      // If there was work, check again immediately, otherwise wait 10 seconds
      if (!hasWork) {
        // console.log("Waiting 10 seconds before next poll...");
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }
    } catch (error) {
      consecutiveErrors++;
      scope.setTag("consecutive_errors", consecutiveErrors);
      console.error(`Batch processing error (${consecutiveErrors}/${maxConsecutiveErrors}):`, error);
      Sentry.captureException(error, scope);

      if (consecutiveErrors >= maxConsecutiveErrors) {
        Sentry.captureMessage("Too many consecutive errors, stopping batch handler", scope);
        console.error("Too many consecutive errors, stopping batch handler");
        break;
      }

      // Wait before retrying on error
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  console.log("Batch handler stopped");
}

Deno.serve((req) => {
  const headers = req.headers;
  const secret = headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";
  if (secret !== expectedSecret) {
    // 401, not a bare `new Response(...)`. Response defaults to 200, so a rejected poke read as a
    // healthy worker: pg_cron's net.http_post logged success while no handler ever started and the
    // gradebook recalculation queue silently stopped draining. Same shape wrapRequestHandler's
    // catch-all was just fixed for, and the same 401 the two async workers already return.
    return new Response(JSON.stringify({ error: "Invalid or missing secret" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="gradebook_column_recalculate", error="invalid_token"'
      }
    });
  }

  // pg_cron pokes this endpoint twice a minute. Without a guard, every poke parked ANOTHER
  // infinite poll loop on the same isolate via waitUntil — the loops never exit on their own, the
  // 2s CPU limit never fires on a sleeping loop, and each one lived the full wall-clock budget.
  // That is a large part of why memory here tracked uptime rather than load.
  const already_running = started;
  if (!started) {
    started = true;
    // Reset on exit: runBatchHandler breaks out of its loop after maxConsecutiveErrors, and without
    // this the flag would stay true forever and the worker would never restart even once the
    // underlying fault cleared.
    EdgeRuntime.waitUntil(
      runBatchHandler().finally(() => {
        started = false;
      })
    );
  } else {
    console.log(`[serve] Batch handler already started, skipping`);
  }

  // Return immediately to acknowledge the start request
  return Promise.resolve(
    new Response(
      JSON.stringify({
        message: "Gradebook batch handler started",
        already_running,
        timestamp: new Date().toISOString()
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    )
  );
});
