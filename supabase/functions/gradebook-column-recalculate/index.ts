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

const SCOPED_FETCH_THRESHOLD = 20;

async function processRowsForClass(
  adminSupabase: ReturnType<typeof createClient<Database>>,
  scope: Sentry.Scope,
  queueMessages: QueueMessage<RowMessage>[],
  classId: number
): Promise<boolean> {
  const classScope = scope.clone();
  classScope.setTag("class_id", classId);

  // Build a map of (gradebook_id, student_id, is_private) → messages
  const keyFor = (m: RowMessage) => `${m.gradebook_id}:${m.student_id}:${m.is_private}`;
  const rows = new Map<string, QueueMessage<RowMessage>[]>();
  for (const msg of queueMessages) {
    const k = keyFor(msg.message);
    const arr = rows.get(k) ?? [];
    arr.push(msg);
    rows.set(k, arr);
  }

  // Group rows by gradebook_id to maximize data reuse
  const gbToRows = new Map<number, { key: string; msg: QueueMessage<RowMessage> }[]>();
  for (const [key, msgs] of rows.entries()) {
    const first = msgs[0];
    const gb = first.message.gradebook_id;
    const arr = gbToRows.get(gb) ?? [];
    arr.push({ key, msg: first });
    gbToRows.set(gb, arr);
  }

  let didWork = false;
  for (const [gradebook_id, rowEntries] of gbToRows.entries()) {
    const isBulk = rowEntries.length > SCOPED_FETCH_THRESHOLD;

    console.log(`${workerId} Processing ${rowEntries.length} rows for gradebook ${gradebook_id} (isBulk: ${isBulk})`);
    if (isBulk) {
      // Full-class fetch for this gradebook & privacy: compute all rows first, then bulk RPC per row
      const studentIds = rowEntries.map((e) => e.msg.message.student_id);
      const is_private = rowEntries[0].msg.message.is_private;

      // Paginate through all rows with pageSize 1000
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
          Sentry.captureException(gcsError, classScope);
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
      const updatesByStudent = await processGradebookRowsCalculation(adminSupabase, classScope, {
        class_id: classId,
        gradebook_id,
        is_private,
        rows: rowsInput
      });

      // Pre-fetch versions for all rows in this gradebook/privacy (avoid IN with many ids)
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
            Sentry.captureException(verErr, classScope);
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

      // Apply updates and archive per row
      for (const entry of rowEntries) {
        const { student_id } = entry.msg.message;
        // Ensure UI and gating reflect processing now
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
            Sentry.captureException(rpcError, classScope);
          }
        }
        // Clear row state only if version hasn't changed mid-run
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
        // Archive the message
        await adminSupabase
          .schema("pgmq_public")
          .rpc("archive", { queue_name: "gradebook_row_recalculate", message_id: entry.msg.msg_id });
        didWork = true;
      }
      continue;
    }

    // Small, scoped multi-row path: still batch compile and dependency fetch once
    const studentIds = rowEntries.map((e) => e.msg.message.student_id);
    const is_private = rowEntries[0].msg.message.is_private;

    // Fetch only the needed rows for these students
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
      Sentry.captureException(scopedErr, classScope);
      continue;
    }

    const groupedScoped: Map<string, NonNullable<typeof scopedGcs>> = new Map();
    for (const r of scopedGcs ?? []) {
      const arr = groupedScoped.get(r.student_id as string) ?? [];
      arr.push(r);
      groupedScoped.set(r.student_id as string, arr);
    }

    const rowsInputScoped = studentIds.map((sid) => ({ student_id: sid, gcsRows: groupedScoped.get(sid) ?? [] }));
    const updatesByStudentScoped = await processGradebookRowsCalculation(adminSupabase, classScope, {
      class_id: classId,
      gradebook_id,
      is_private,
      rows: rowsInputScoped
    });

    // Prefetch versions for these students only
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
        Sentry.captureException(verErr, classScope);
      }
      for (const row of (verRows as unknown as Array<{ student_id: string; version: number }>) ?? []) {
        versionsByStudentScoped.set(row.student_id, row.version);
      }
    }

    // Apply updates and archive per row
    for (const entry of rowEntries) {
      const { student_id } = entry.msg.message;
      // Ensure UI and gating reflect processing now
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
          p_updates:
            updates as unknown as Database["public"]["Functions"]["update_gradebook_row"]["Args"]["p_updates"],
          p_expected_version: expectedVersion
        };
        const { error: rpcError } = await adminSupabase.rpc("update_gradebook_row", payload);
        if (rpcError) {
          Sentry.captureException(rpcError, classScope);
        }
      }

      // Clear row state only if version hasn't changed mid-run
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

      // Archive the message
      await adminSupabase
        .schema("pgmq_public")
        .rpc("archive", { queue_name: "gradebook_row_recalculate", message_id: entry.msg.msg_id });
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
  maxMessages = 10
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
    // Group by class for processing reuse
    const classIdToMessages = new Map<number, typeof queueMessages>();
    for (const msg of queueMessages) {
      const classId = msg.message.class_id;
      const arr = classIdToMessages.get(classId) ?? [];
      arr.push(msg);
      classIdToMessages.set(classId, arr);
    }

    let processedAny = false;
    for (const [classId, messages] of classIdToMessages.entries()) {
      console.log(`${workerId} Processing ${messages.length} messages for class ${classId}`);
      const didWork = await processRowsForClass(adminSupabase, scope, messages, classId);
      processedAny = processedAny || didWork;
    }

    return processedAny;
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

  Sentry.captureMessage("Gradebook batch handler started, but is disabled!");

  // EdgeRuntime.waitUntil(runBatchHandler());

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
