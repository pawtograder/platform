import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookRowsCalculation } from "./GradebookProcessor.ts";
import * as Sentry from "npm:@sentry/deno";

// Declare EdgeRuntime for type safety
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA") || Deno.env.get("DENO_DEPLOYMENT_ID")!,
    sendDefaultPii: true,
    environment: Deno.env.get("ENVIRONMENT") || "development",
    integrations: [],
    tracesSampleRate: 0,
    ignoreErrors: ["Deno.core.runMicrotasks() is not supported in this environment"]
  });
}
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
};

const SCOPED_FETCH_THRESHOLD = 50;
const workerId = crypto.randomUUID();

// Helper to create unique row key for gradebook_row_recalc_state
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
  // NOTE: When we de-duplicate, there seem to be some knock-on effects that cause incorrect calculations
  // So, at the cost of repeated work we don't deduplicate anymore (to save the cost of more debugging!)
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

    // const existing = rows.get(k);
    // if (!existing) {
    rows.set(k, { primary: msg, duplicateMsgIds: [] });
    // } else {
    // existing.duplicateMsgIds.push(msg.msg_id);
    // console.log(`Found a duplicate message for ${k}`);
    // }
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

      const versionsByStudent = new Map<string, number>();
      {
        let vFrom = 0;
        const vPageSize = 1000;
        while (true) {
          const vTo = vFrom + vPageSize - 1;
          const { data: verPage, error: verErr } = await adminSupabase
            .from("gradebook_row_recalc_state")
            .select("student_id, version, dirty, is_recalculating")
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
          for (const row of verPage as unknown as Array<{
            student_id: string;
            version: number;
            dirty: boolean;
            is_recalculating: boolean;
          }>) {
            versionsByStudent.set(row.student_id, row.version);
          }
          if (verPage.length < vPageSize) break;
          vFrom += vPageSize;
        }
      }

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
        // Collect all message IDs being sent to RPC for archiving
        const allMessageIds = batchUpdates.flatMap((bu) => bu.message_ids);
        console.log(
          `[DEBUG] ${workerId} BATCH_UPDATE: About to batch update ${batchUpdates.length} students for gradebook ${gradebook_id} with ${allMessageIds.length} message IDs: [${allMessageIds.join(", ")}]`
        );

        // Log what we're sending to RPC for debugging
        const sampleBatchUpdate = batchUpdates.slice(0, 3).map((bu) => ({
          student_id: bu.student_id,
          is_private: bu.is_private,
          expected_version: bu.expected_version,
          updates_count: bu.updates.length,
          message_ids_count: bu.message_ids.length
        }));
        console.log(
          `[DEBUG] ${workerId} RPC CALL: Sample batch update (first 3):`,
          JSON.stringify(sampleBatchUpdate, null, 2)
        );

        const { error: batchError, data: batchResults } = await adminSupabase.rpc("update_gradebook_rows_batch", {
          p_batch_updates: batchUpdates
        });

        if (batchError) {
          console.error(
            `[DEBUG] ${workerId} BATCH_UPDATE ERROR: Failed to batch update rows for gradebook ${gradebook_id}. Messages NOT archived: [${allMessageIds.join(", ")}]`,
            batchError
          );
          Sentry.captureException(batchError, gbScope);
          // Log which messages failed to be archived due to RPC error
          console.error(
            `[DEBUG] ${workerId} ARCHIVE FAILED: ${allMessageIds.length} messages (msg_ids: [${allMessageIds.join(", ")}]) were NOT archived due to RPC error. These will be re-read when visibility timeout expires.`
          );
        } else {
          // Extract results array from the RPC response object
          const rpcResponse = batchResults as unknown as {
            results?: Array<{
              student_id: string;
              is_private: boolean;
              updated_count: number;
              version_matched: boolean;
              cleared: boolean;
              error?: string;
            }>;
          };
          const results = rpcResponse?.results ?? [];

          console.log(
            `[DEBUG] ${workerId} BATCH_UPDATE: Successfully processed ${results.length} students for gradebook ${gradebook_id}. Messages should be archived by RPC.`
          );

          // Log detailed results for debugging why rows aren't cleared
          if (results.length > 0) {
            const sampleResults = results.slice(0, 5).map((r) => ({
              student_id: r.student_id,
              is_private: r.is_private,
              version_matched: r.version_matched,
              cleared: r.cleared,
              updated_count: r.updated_count,
              error: r.error
            }));
            console.log(
              `[DEBUG] ${workerId} BATCH_UPDATE: Sample results (first 5):`,
              JSON.stringify(sampleResults, null, 2)
            );

            // Log breakdown of result statuses
            const statusBreakdown = {
              cleared: results.filter((r) => r.cleared).length,
              version_matched_but_not_cleared: results.filter((r) => r.version_matched && !r.cleared && !r.error)
                .length,
              version_mismatch: results.filter((r) => !r.version_matched && !r.error).length,
              has_error: results.filter((r) => r.error).length,
              updated_count_zero: results.filter((r) => r.updated_count === 0).length,
              updated_count_nonzero: results.filter((r) => r.updated_count > 0).length
            };
            console.log(
              `[DEBUG] ${workerId} BATCH_UPDATE: Result status breakdown:`,
              JSON.stringify(statusBreakdown, null, 2)
            );
          }

          // Log results summary with detailed breakdown
          const clearedCount = results.filter((r) => r.cleared).length;
          const versionMismatchCount = results.filter((r) => !r.version_matched && !r.error).length;
          const errorCount = results.filter((r) => r.error).length;
          const notClearedCount = results.filter((r) => !r.cleared && !r.error).length;
          const versionMatchedButNotCleared = results.filter((r) => r.version_matched && !r.cleared && !r.error).length;

          // Calculate which message IDs should have been archived (cleared rows with version match)
          const shouldBeArchivedMsgIds = batchUpdates
            .filter((bu) => {
              const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
              return result?.cleared && result?.version_matched && !result?.error;
            })
            .flatMap((bu) => bu.message_ids);

          if (clearedCount > 0) {
            console.log(
              `[DEBUG] ${workerId} BATCH_UPDATE: Cleared ${clearedCount} rows. Expected ${shouldBeArchivedMsgIds.length} messages to be archived: [${shouldBeArchivedMsgIds.join(", ")}]`
            );
          } else {
            console.warn(
              `[DEBUG] ${workerId} BATCH_UPDATE WARNING: No rows were cleared! ${allMessageIds.length} messages were processed but NONE will be archived. This means messages will be re-read.`
            );
          }

          if (versionMatchedButNotCleared > 0) {
            const versionMatchedButNotClearedMsgIds = batchUpdates
              .filter((bu) => {
                const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
                return result && result.version_matched && !result.cleared && !result.error;
              })
              .flatMap((bu) => bu.message_ids);
            console.warn(
              `[DEBUG] ${workerId} BATCH_UPDATE WARNING: ${versionMatchedButNotCleared} rows had version_matched=true but cleared=false! ${versionMatchedButNotClearedMsgIds.length} messages will NOT be archived: [${versionMatchedButNotClearedMsgIds.slice(0, 20).join(", ")}${versionMatchedButNotClearedMsgIds.length > 20 ? "..." : ""}]`
            );

            // Log details about why these weren't cleared
            const notClearedDetails = batchUpdates
              .filter((bu) => {
                const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
                return result && result.version_matched && !result.cleared && !result.error;
              })
              .slice(0, 5)
              .map((bu) => {
                const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
                return {
                  student_id: bu.student_id,
                  is_private: bu.is_private,
                  version_matched: result?.version_matched,
                  cleared: result?.cleared,
                  updated_count: result?.updated_count,
                  message_ids: bu.message_ids
                };
              });
            console.warn(
              `[DEBUG] ${workerId} BATCH_UPDATE: Sample of version_matched but not cleared (first 5):`,
              JSON.stringify(notClearedDetails, null, 2)
            );
          }

          if (notClearedCount > 0 && versionMatchedButNotCleared === 0) {
            const notClearedMsgIds = batchUpdates
              .filter((bu) => {
                const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
                return result && !result.cleared && !result.error;
              })
              .flatMap((bu) => bu.message_ids);
            console.warn(
              `[DEBUG] ${workerId} BATCH_UPDATE WARNING: ${notClearedCount} rows were NOT cleared (version mismatch or other reason). ${notClearedMsgIds.length} messages will NOT be archived: [${notClearedMsgIds.slice(0, 20).join(", ")}${notClearedMsgIds.length > 20 ? "..." : ""}]`
            );
          }

          if (versionMismatchCount > 0) {
            const versionMismatchMsgIds = batchUpdates
              .filter((bu) => {
                const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
                return result && !result.version_matched && !result.error;
              })
              .flatMap((bu) => bu.message_ids);
            console.log(
              `[DEBUG] ${workerId} BATCH_UPDATE: ${versionMismatchCount} rows had version mismatches (re-enqueued by RPC). ${versionMismatchMsgIds.length} original messages should still be archived: [${versionMismatchMsgIds.join(", ")}]`
            );
          }

          if (errorCount > 0) {
            console.log(`[DEBUG] ${workerId} BATCH_UPDATE: ${errorCount} rows had errors`);
            // Log which students had errors - their messages might not be archived
            const errorStudents = results.filter((r) => r.error).map((r) => r.student_id);
            const errorMessageIds = batchUpdates
              .filter((bu) => errorStudents.includes(bu.student_id))
              .flatMap((bu) => bu.message_ids);
            console.warn(
              `[DEBUG] ${workerId} ARCHIVE WARNING: Messages for students with errors might not be archived: msg_ids [${errorMessageIds.join(", ")}]`
            );
          }

          // Log summary of all message IDs and their expected archiving status
          console.log(
            `[DEBUG] ${workerId} ARCHIVE SUMMARY for gradebook ${gradebook_id}: Total messages=${allMessageIds.length}, Should be archived=${shouldBeArchivedMsgIds.length}, Will NOT be archived=${allMessageIds.length - shouldBeArchivedMsgIds.length}`
          );
        }
      } else {
        console.log(
          `[DEBUG] ${workerId} BATCH_UPDATE SKIP: No students to process for gradebook ${gradebook_id} (this should not happen)`
        );
      }
    }

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
    } else {
      console.log(
        `[DEBUG] ${workerId} UPSERT (scoped): Successfully upserted ${rowEntries.length} rows for gradebook ${gradebook_id}`
      );
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
      // Collect all message IDs being sent to RPC for archiving
      const allMessageIdsScoped = batchUpdatesScoped.flatMap((bu) => bu.message_ids);
      console.log(
        `[DEBUG] ${workerId} BATCH_UPDATE (scoped): About to batch update ${batchUpdatesScoped.length} students for gradebook ${gradebook_id} with ${allMessageIdsScoped.length} message IDs: [${allMessageIdsScoped.join(", ")}]`
      );

      const { error: batchErrorScoped, data: batchResultsScoped } = await adminSupabase.rpc(
        "update_gradebook_rows_batch",
        {
          p_batch_updates: batchUpdatesScoped
        }
      );

      if (batchErrorScoped) {
        console.error(
          `[DEBUG] ${workerId} BATCH_UPDATE ERROR (scoped): Failed to batch update rows for gradebook ${gradebook_id}. Messages NOT archived: [${allMessageIdsScoped.join(", ")}]`,
          batchErrorScoped
        );
        Sentry.captureException(batchErrorScoped, gbScope);
        // Log which messages failed to be archived due to RPC error
        console.error(
          `[DEBUG] ${workerId} ARCHIVE FAILED (scoped): ${allMessageIdsScoped.length} messages (msg_ids: [${allMessageIdsScoped.join(", ")}]) were NOT archived due to RPC error. These will be re-read when visibility timeout expires.`
        );
      } else {
        // Extract results array from the RPC response object
        const rpcResponseScoped = batchResultsScoped as unknown as {
          results?: Array<{
            student_id: string;
            is_private: boolean;
            updated_count: number;
            version_matched: boolean;
            cleared: boolean;
            error?: string;
          }>;
        };
        const results = rpcResponseScoped?.results ?? [];

        console.log(
          `[DEBUG] ${workerId} BATCH_UPDATE (scoped): Successfully processed ${results.length} students for gradebook ${gradebook_id}. Messages should be archived by RPC.`
        );

        // Log detailed results for debugging why rows aren't cleared
        if (results.length > 0) {
          const sampleResults = results.slice(0, 5).map((r) => ({
            student_id: r.student_id,
            is_private: r.is_private,
            version_matched: r.version_matched,
            cleared: r.cleared,
            updated_count: r.updated_count,
            error: r.error
          }));
          console.log(
            `[DEBUG] ${workerId} BATCH_UPDATE (scoped): Sample results (first 5):`,
            JSON.stringify(sampleResults, null, 2)
          );

          // Log breakdown of result statuses
          const statusBreakdown = {
            cleared: results.filter((r) => r.cleared).length,
            version_matched_but_not_cleared: results.filter((r) => r.version_matched && !r.cleared && !r.error).length,
            version_mismatch: results.filter((r) => !r.version_matched && !r.error).length,
            has_error: results.filter((r) => r.error).length,
            updated_count_zero: results.filter((r) => r.updated_count === 0).length,
            updated_count_nonzero: results.filter((r) => r.updated_count > 0).length
          };
          console.log(
            `[DEBUG] ${workerId} BATCH_UPDATE (scoped): Result status breakdown:`,
            JSON.stringify(statusBreakdown, null, 2)
          );
        }

        // Log results summary with detailed breakdown
        const clearedCount = results.filter((r) => r.cleared).length;
        const versionMismatchCount = results.filter((r) => !r.version_matched && !r.error).length;
        const errorCount = results.filter((r) => r.error).length;
        const notClearedCount = results.filter((r) => !r.cleared && !r.error).length;
        const versionMatchedButNotCleared = results.filter((r) => r.version_matched && !r.cleared && !r.error).length;

        // Calculate which message IDs should have been archived (cleared rows with version match)
        const shouldBeArchivedMsgIdsScoped = batchUpdatesScoped
          .filter((bu) => {
            const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
            return result?.cleared && result?.version_matched && !result?.error;
          })
          .flatMap((bu) => bu.message_ids);

        if (clearedCount > 0) {
          console.log(
            `[DEBUG] ${workerId} BATCH_UPDATE (scoped): Cleared ${clearedCount} rows. Expected ${shouldBeArchivedMsgIdsScoped.length} messages to be archived: [${shouldBeArchivedMsgIdsScoped.join(", ")}]`
          );
        } else {
          console.warn(
            `[DEBUG] ${workerId} BATCH_UPDATE WARNING (scoped): No rows were cleared! ${allMessageIdsScoped.length} messages were processed but NONE will be archived. This means messages will be re-read.`
          );
        }

        if (versionMatchedButNotCleared > 0) {
          const versionMatchedButNotClearedMsgIds = batchUpdatesScoped
            .filter((bu) => {
              const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
              return result && result.version_matched && !result.cleared && !result.error;
            })
            .flatMap((bu) => bu.message_ids);
          console.warn(
            `[DEBUG] ${workerId} BATCH_UPDATE WARNING (scoped): ${versionMatchedButNotCleared} rows had version_matched=true but cleared=false! ${versionMatchedButNotClearedMsgIds.length} messages will NOT be archived: [${versionMatchedButNotClearedMsgIds.slice(0, 20).join(", ")}${versionMatchedButNotClearedMsgIds.length > 20 ? "..." : ""}]`
          );

          // Log details about why these weren't cleared
          const notClearedDetails = batchUpdatesScoped
            .filter((bu) => {
              const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
              return result && result.version_matched && !result.cleared && !result.error;
            })
            .slice(0, 5)
            .map((bu) => {
              const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
              return {
                student_id: bu.student_id,
                is_private: bu.is_private,
                version_matched: result?.version_matched,
                cleared: result?.cleared,
                updated_count: result?.updated_count,
                message_ids: bu.message_ids
              };
            });
          console.warn(
            `[DEBUG] ${workerId} BATCH_UPDATE (scoped): Sample of version_matched but not cleared (first 5):`,
            JSON.stringify(notClearedDetails, null, 2)
          );
        }

        if (notClearedCount > 0 && versionMatchedButNotCleared === 0) {
          const notClearedMsgIds = batchUpdatesScoped
            .filter((bu) => {
              const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
              return result && !result.cleared && !result.error;
            })
            .flatMap((bu) => bu.message_ids);
          console.warn(
            `[DEBUG] ${workerId} BATCH_UPDATE WARNING (scoped): ${notClearedCount} rows were NOT cleared (version mismatch or other reason). ${notClearedMsgIds.length} messages will NOT be archived: [${notClearedMsgIds.slice(0, 20).join(", ")}${notClearedMsgIds.length > 20 ? "..." : ""}]`
          );
        }

        if (versionMismatchCount > 0) {
          const versionMismatchMsgIds = batchUpdatesScoped
            .filter((bu) => {
              const result = results.find((r) => r.student_id === bu.student_id && r.is_private === bu.is_private);
              return result && !result.version_matched && !result.error;
            })
            .flatMap((bu) => bu.message_ids);
          console.log(
            `[DEBUG] ${workerId} BATCH_UPDATE (scoped): ${versionMismatchCount} rows had version mismatches (re-enqueued by RPC). ${versionMismatchMsgIds.length} original messages should still be archived: [${versionMismatchMsgIds.join(", ")}]`
          );
        }

        if (errorCount > 0) {
          console.log(`[DEBUG] ${workerId} BATCH_UPDATE (scoped): ${errorCount} rows had errors`);
          // Log which students had errors - their messages might not be archived
          const errorStudents = results.filter((r) => r.error).map((r) => r.student_id);
          const errorMessageIds = batchUpdatesScoped
            .filter((bu) => errorStudents.includes(bu.student_id))
            .flatMap((bu) => bu.message_ids);
          console.warn(
            `[DEBUG] ${workerId} ARCHIVE WARNING (scoped): Messages for students with errors might not be archived: msg_ids [${errorMessageIds.join(", ")}]`
          );
        }

        // Log summary of all message IDs and their expected archiving status
        console.log(
          `[DEBUG] ${workerId} ARCHIVE SUMMARY (scoped) for gradebook ${gradebook_id}: Total messages=${allMessageIdsScoped.length}, Should be archived=${shouldBeArchivedMsgIdsScoped.length}, Will NOT be archived=${allMessageIdsScoped.length - shouldBeArchivedMsgIdsScoped.length}`
        );
      }
    } else {
      console.log(
        `[DEBUG] ${workerId} BATCH_UPDATE SKIP (scoped): No students to process for gradebook ${gradebook_id} (this should not happen)`
      );
    }

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
  console.log(`${workerId} Read ${result.data?.length} messages from gradebook_row_recalculate queue`);
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
    return new Response(JSON.stringify({ error: "Invalid secret" }), {
      headers: { "Content-Type": "application/json" }
    });
  }

  EdgeRuntime.waitUntil(runBatchHandler());

  // Return immediately to acknowledge the start request
  return Promise.resolve(
    new Response(
      JSON.stringify({
        message: "Gradebook batch handler started",
        timestamp: new Date().toISOString()
      }),
      {
        headers: { "Content-Type": "application/json" }
      }
    )
  );
});
