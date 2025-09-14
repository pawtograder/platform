import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookRowCalculation, processGradebookRowsCalculation, RowUpdate } from "./GradebookProcessor.ts";
import * as Sentry from "npm:@sentry/deno";

// Declare EdgeRuntime for type safety
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

      // Apply updates and archive per row
      for (const entry of rowEntries) {
        const { student_id } = entry.msg.message;
        const updates = updatesByStudent.get(student_id) ?? [];
        if (updates.length > 0) {
          const { error: rpcError } = await adminSupabase.rpc("update_gradebook_row", {
            p_class_id: classId,
            p_gradebook_id: gradebook_id,
            p_student_id: student_id,
            p_is_private: is_private,
            p_updates:
              updates as unknown as Database["public"]["Functions"]["update_gradebook_row"]["Args"]["p_updates"]
          });
          if (rpcError) {
            Sentry.captureException(rpcError, classScope);
          }
        }
        // Clear row state
        await adminSupabase
          .from("gradebook_row_recalc_state")
          .update({ dirty: false, is_recalculating: false, updated_at: new Date().toISOString() })
          .eq("class_id", classId)
          .eq("gradebook_id", gradebook_id)
          .eq("student_id", student_id)
          .eq("is_private", is_private);
        // Archive the message
        await adminSupabase
          .schema("pgmq_public")
          .rpc("archive", { queue_name: "gradebook_row_recalculate", message_id: entry.msg.msg_id });
        didWork = true;
      }
      continue;
    }

    // Scoped path per row
    for (const { msg } of rowEntries) {
      const { student_id, is_private } = msg.message;
      classScope.setContext("row", { gradebook_id, student_id, is_private });

      // Fetch row cell ids
      const { data: gcsRows, error: gcsError } = await adminSupabase
        .from("gradebook_column_students")
        .select(
          "id, gradebook_column_id, is_missing, is_excused, is_droppable, score_override, score, released, score_override_note, incomplete_values"
        )
        .eq("class_id", classId)
        .eq("gradebook_id", gradebook_id)
        .eq("student_id", student_id)
        .eq("is_private", is_private);

      if (gcsError || !gcsRows || gcsRows.length === 0) {
        if (gcsError) Sentry.captureException(gcsError, classScope);
        continue;
      }

      // Compute row updates in-memory
      let updates: RowUpdate[] = [];
      try {
        updates = await processGradebookRowCalculation(adminSupabase, classScope, {
          class_id: classId,
          gradebook_id,
          student_id,
          is_private,
          gcsRows
        });
      } catch (e) {
        Sentry.captureException(e, classScope);
        continue;
      }

      // Send batched update via RPC
      const { error: rpcError } = await adminSupabase.rpc("update_gradebook_row", {
        p_class_id: classId,
        p_gradebook_id: gradebook_id,
        p_student_id: student_id,
        p_is_private: is_private,
        p_updates: updates as unknown as Database["public"]["Functions"]["update_gradebook_row"]["Args"]["p_updates"]
      });
      if (rpcError) {
        Sentry.captureException(rpcError, classScope);
        console.error("Error updating row via RPC:", rpcError);
      }

      // Clear row state flags
      const { error: clearError } = await adminSupabase
        .from("gradebook_row_recalc_state")
        .update({ dirty: false, is_recalculating: false, updated_at: new Date().toISOString() })
        .eq("class_id", classId)
        .eq("gradebook_id", gradebook_id)
        .eq("student_id", student_id)
        .eq("is_private", is_private);
      if (clearError) {
        Sentry.captureException(clearError, classScope);
        console.error("Error clearing row state:", clearError);
      }

      // Archive messages for this row
      const { error: archiveError } = await adminSupabase
        .schema("pgmq_public")
        .rpc("archive", { queue_name: "gradebook_row_recalculate", message_id: msg.msg_id });
      if (archiveError) {
        Sentry.captureException(archiveError, classScope);
        console.error("Error archiving completed message:", archiveError);
      }

      didWork = true;
    }
  }

  return didWork;
}

/**
 * Process a batch of gradebook cell calculations with dependency coordination.
 *
 */
export async function processBatch(adminSupabase: ReturnType<typeof createClient<Database>>, scope: Sentry.Scope) {
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "gradebook_row_recalculate",
    sleep_seconds: 60, // Short sleep since we're polling frequently
    n: 500
  });
  console.log(`Read ${result.data?.length} messages from gradebook_row_recalculate queue`);
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
    console.log("Received shutdown signal, stopping batch handler...");
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
