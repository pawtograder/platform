import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookRowsCalculation } from "./GradebookProcessor.ts";
import * as Sentry from "npm:@sentry/deno";
import Bottleneck from "npm:bottleneck@2.19.5";

// Declare EdgeRuntime for type safety
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

if (Deno.env.get("SENTRY_DSN")) {
  Sentry.init({
    dsn: Deno.env.get("SENTRY_DSN")!,
    release: Deno.env.get("RELEASE_VERSION") || Deno.env.get("GIT_COMMIT_SHA") || Deno.env.get("SUPABASE_URL")!,
    sendDefaultPii: true,
    environment: Deno.env.get("ENVIRONMENT") || "development",
    integrations: [],
    tracesSampleRate: 0
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

async function processRowsAll(
  adminSupabase: ReturnType<typeof createClient<Database>>,
  scope: Sentry.Scope,
  queueMessages: QueueMessage<RowMessage>[]
): Promise<boolean> {
  // Deduplicate by (gradebook_id, student_id, is_private)
  const keyFor = (m: RowMessage) => `${m.gradebook_id}:${m.student_id}:${m.is_private}`;
  const rows = new Map<string, { primary: QueueMessage<RowMessage>; duplicateMsgIds: number[] }>();
  for (const msg of queueMessages) {
    const k = keyFor(msg.message);
    const existing = rows.get(k);
    if (!existing) {
      rows.set(k, { primary: msg, duplicateMsgIds: [] });
    } else {
      existing.duplicateMsgIds.push(msg.msg_id);
    }
  }

  // Group by (class_id, gradebook_id)
  type RowEntry = { key: string; msg: QueueMessage<RowMessage>; duplicateMsgIds: number[] };
  const gbToRows = new Map<string, RowEntry[]>();
  for (const [key, entry] of rows.entries()) {
    const { class_id, gradebook_id } = entry.primary.message;
    const gbKey = `${class_id}:${gradebook_id}`;
    const arr = gbToRows.get(gbKey) ?? [];
    arr.push({ key, msg: entry.primary, duplicateMsgIds: entry.duplicateMsgIds });
    gbToRows.set(gbKey, arr);
  }

  let didWork = false;
  for (const [gbKey, rowEntries] of gbToRows.entries()) {
    const [classIdStr, gradebookIdStr] = gbKey.split(":");
    const classId = Number(classIdStr);
    const gradebook_id = Number(gradebookIdStr);
    const gbScope = scope.clone();
    gbScope.setTag("class_id", classId);
    gbScope.setTag("gradebook_id", gradebook_id);

    const isBulk = rowEntries.length > SCOPED_FETCH_THRESHOLD;
    console.log(`${workerId} Processing ${rowEntries.length} rows for gradebook ${gradebook_id} (isBulk: ${isBulk})`);

    if (isBulk) {
      const studentIds = rowEntries.map((e) => e.msg.message.student_id);
      const is_private = rowEntries[0].msg.message.is_private;

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

      const rowsInput = studentIds.map((sid) => ({ student_id: sid, gcsRows: grouped.get(sid) ?? [] }));
      const updatesByStudent = await processGradebookRowsCalculation(adminSupabase, gbScope, {
        class_id: classId,
        gradebook_id,
        is_private,
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

      console.log(`Upserting ${rowEntries.length} rows for gradebook ${gradebook_id}`);
      const updateLimiter = new Bottleneck({
        maxConcurrent: 20
      });
      const updatePromises = await rowEntries.map((entry) =>
        updateLimiter.schedule(async () => {
          const { student_id } = entry.msg.message;
          await adminSupabase.from("gradebook_row_recalc_state").upsert({
            class_id: classId,
            gradebook_id,
            student_id,
            is_private,
            dirty: true,
            is_recalculating: true,
            updated_at: new Date().toISOString()
          });
          const updates = updatesByStudent.get(student_id) ?? [];
          if (updates.length > 0) {
            const expectedVersion = versionsByStudent.get(student_id) ?? 0;
            const payload: Database["public"]["Functions"]["update_gradebook_row"]["Args"] = {
              p_class_id: classId,
              p_gradebook_id: gradebook_id,
              p_student_id: student_id,
              p_is_private: is_private,
              p_updates:
                updates as unknown as Database["public"]["Functions"]["update_gradebook_row"]["Args"]["p_updates"],
              p_expected_version: expectedVersion
            };
            const { error: rpcError } = await adminSupabase.rpc("update_gradebook_row", payload);
            if (rpcError) {
              Sentry.captureException(rpcError, gbScope);
            }
          }
          const { data: verAfter } = await adminSupabase
            .from("gradebook_row_recalc_state")
            .select("version")
            .eq("class_id", classId)
            .eq("gradebook_id", gradebook_id)
            .eq("student_id", student_id)
            .eq("is_private", is_private)
            .single();
          const expectedVersion = versionsByStudent.get(student_id) ?? 0;
          if (((verAfter as unknown as { version?: number } | null)?.version ?? null) === expectedVersion) {
            await adminSupabase
              .from("gradebook_row_recalc_state")
              .update({ dirty: false, is_recalculating: false, updated_at: new Date().toISOString() })
              .eq("class_id", classId)
              .eq("gradebook_id", gradebook_id)
              .eq("student_id", student_id)
              .eq("is_private", is_private);
          }
          const toArchive = [entry.msg.msg_id, ...entry.duplicateMsgIds];
          for (const message_id of toArchive) {
            await adminSupabase
              .schema("pgmq_public")
              .rpc("archive", { queue_name: "gradebook_row_recalculate", message_id });
          }
          didWork = true;
        })
      );
      await Promise.all(updatePromises);
      console.log(`Finished processing ${rowEntries.length} rows for gradebook ${gradebook_id}`);
      continue;
    }

    const studentIds = rowEntries.map((e) => e.msg.message.student_id);
    const is_private = rowEntries[0].msg.message.is_private;
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

    const rowsInputScoped = studentIds.map((sid) => ({ student_id: sid, gcsRows: groupedScoped.get(sid) ?? [] }));
    const updatesByStudentScoped = await processGradebookRowsCalculation(adminSupabase, gbScope, {
      class_id: classId,
      gradebook_id,
      is_private,
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

    for (const entry of rowEntries) {
      const { student_id } = entry.msg.message;
      await adminSupabase.from("gradebook_row_recalc_state").upsert({
        class_id: classId,
        gradebook_id,
        student_id,
        is_private,
        dirty: true,
        is_recalculating: true,
        updated_at: new Date().toISOString()
      });

      const updates = updatesByStudentScoped.get(student_id) ?? [];
      if (updates.length > 0) {
        const expectedVersion = versionsByStudentScoped.get(student_id) ?? 0;
        const payload: Database["public"]["Functions"]["update_gradebook_row"]["Args"] = {
          p_class_id: classId,
          p_gradebook_id: gradebook_id,
          p_student_id: student_id,
          p_is_private: is_private,
          p_updates: updates as unknown as Database["public"]["Functions"]["update_gradebook_row"]["Args"]["p_updates"],
          p_expected_version: expectedVersion
        };
        const { error: rpcError } = await adminSupabase.rpc("update_gradebook_row", payload);
        if (rpcError) {
          Sentry.captureException(rpcError, gbScope);
        }
      }

      const { data: verAfter } = await adminSupabase
        .from("gradebook_row_recalc_state")
        .select("version")
        .eq("class_id", classId)
        .eq("gradebook_id", gradebook_id)
        .eq("student_id", student_id)
        .eq("is_private", is_private)
        .single();
      const expectedVersion = versionsByStudentScoped.get(student_id) ?? 0;
      if (((verAfter as unknown as { version?: number } | null)?.version ?? null) === expectedVersion) {
        await adminSupabase
          .from("gradebook_row_recalc_state")
          .update({ dirty: false, is_recalculating: false, updated_at: new Date().toISOString() })
          .eq("class_id", classId)
          .eq("gradebook_id", gradebook_id)
          .eq("student_id", student_id)
          .eq("is_private", is_private);
      }

      const toArchive = [entry.msg.msg_id, ...entry.duplicateMsgIds];
      for (const message_id of toArchive) {
        await adminSupabase
          .schema("pgmq_public")
          .rpc("archive", { queue_name: "gradebook_row_recalculate", message_id });
      }
      didWork = true;
    }
  }

  return didWork;
}

const workerId = crypto.randomUUID();
/**
 * Process a batch of gradebook cell calculations with dependency coordination.
 *
 */
export async function processBatch(
  adminSupabase: ReturnType<typeof createClient<Database>>,
  scope: Sentry.Scope,
  maxMessages = 500
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
    console.log(`${workerId} Processing ${queueMessages.length} messages in a single pass`);
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
