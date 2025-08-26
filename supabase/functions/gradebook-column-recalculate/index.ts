import * as EdgeRuntime from "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookCellCalculation } from "./GradebookProcessor.ts";
import * as Sentry from "npm:@sentry/deno";

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

/**
 * Batch check which cells have dependencies that are currently being recalculated
 */
async function filterCellsByDependencyStatus(
  cells: { gradebook_column_id: number; student_id: string; is_private: boolean }[],
  adminSupabase: ReturnType<typeof createClient<Database>>,
  scope: Sentry.Scope
): Promise<{
  readyToProcess: typeof cells;
  waitingForDependencies: typeof cells;
}> {
  if (cells.length === 0) {
    return { readyToProcess: [], waitingForDependencies: [] };
  }

  // Get all unique column IDs
  const columnIds = Array.from(new Set(cells.map((cell) => cell.gradebook_column_id)));

  // Batch fetch all column dependencies
  const { data: columns, error: columnsError } = await adminSupabase
    .from("gradebook_columns")
    .select("id, dependencies")
    .in("id", columnIds);

  if (columnsError) {
    const newScope = scope.clone();
    newScope.setContext("column_ids", { ids: columnIds });
    Sentry.captureException(columnsError, newScope);
    console.error("Error fetching gradebook columns for dependency check:", columnsError);
    // On error, assume all cells are ready to avoid blocking processing
    return { readyToProcess: cells, waitingForDependencies: [] };
  }

  if (!columns) {
    return { readyToProcess: cells, waitingForDependencies: [] };
  }

  // Create a map of column dependencies
  const columnDepsMap = new Map<number, number[]>();
  for (const column of columns) {
    const deps = column.dependencies as { gradebook_columns?: number[] };
    if (deps?.gradebook_columns && deps.gradebook_columns.length > 0) {
      columnDepsMap.set(column.id, deps.gradebook_columns);
    }
  }

  // Get all unique student-privacy combinations that have dependencies
  const studentsWithDeps = cells.filter((cell) => columnDepsMap.has(cell.gradebook_column_id));

  if (studentsWithDeps.length === 0) {
    return { readyToProcess: cells, waitingForDependencies: [] };
  }

  // Get all dependency column IDs
  const allDepColumnIds = Array.from(new Set(Array.from(columnDepsMap.values()).flat()));

  // Batch check for recalculating dependencies
  const { data: recalculatingCells, error: recalculatingError } = await adminSupabase
    .from("gradebook_column_students")
    .select("gradebook_column_id, student_id, is_private")
    .in("gradebook_column_id", allDepColumnIds)
    .in("student_id", Array.from(new Set(studentsWithDeps.map((c) => c.student_id))))
    .eq("is_recalculating", true);

  if (recalculatingError) {
    const newScope = scope.clone();
    newScope.setContext("dependency_column_ids", { ids: allDepColumnIds });
    newScope.setContext("student_ids", { ids: Array.from(new Set(studentsWithDeps.map((c) => c.student_id))) });
    Sentry.captureException(recalculatingError, newScope);
    console.error("Error checking for recalculating dependencies:", recalculatingError);
    // On error, assume no dependencies are recalculating to avoid blocking
    return { readyToProcess: cells, waitingForDependencies: [] };
  }

  // Create a set of blocked student-column-privacy combinations
  const blockedCombinations = new Set<string>();
  if (recalculatingCells) {
    for (const recalc of recalculatingCells) {
      blockedCombinations.add(`${recalc.gradebook_column_id}:${recalc.student_id}:${recalc.is_private}`);
    }
  }

  // Separate cells into ready vs waiting
  const readyToProcess: typeof cells = [];
  const waitingForDependencies: typeof cells = [];

  for (const cell of cells) {
    const depColumnIds = columnDepsMap.get(cell.gradebook_column_id);

    if (!depColumnIds) {
      // No dependencies, ready to process
      readyToProcess.push(cell);
      continue;
    }

    // Check if any dependencies are being recalculated
    const hasBlockingDeps = depColumnIds.some((depColId) =>
      blockedCombinations.has(`${depColId}:${cell.student_id}:${cell.is_private}`)
    );

    if (hasBlockingDeps) {
      waitingForDependencies.push(cell);
    } else {
      readyToProcess.push(cell);
    }
  }

  return { readyToProcess, waitingForDependencies };
}

/**
 * Process a batch of gradebook cell calculations with dependency coordination.
 *
 * This function implements coordination between multiple workers to prevent race conditions:
 * 1. Reads messages from the queue
 * 2. Filters out cells whose dependencies are currently being recalculated by other workers
 * 3. Re-queues cells that must wait for dependencies to complete
 * 4. Processes only cells that are ready (no dependencies being recalculated)
 * 5. Uses the is_recalculating flag to coordinate between workers
 */
export async function processBatch(adminSupabase: ReturnType<typeof createClient<Database>>, scope: Sentry.Scope) {
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "gradebook_column_recalculate",
    sleep_seconds: 60, // Short sleep since we're polling frequently
    n: 500
  });
  if (result.error) {
    Sentry.captureException(result.error, scope);
    console.error("Queue read error:", result.error);
    return false;
  }

  scope.setTag("queue_length", result.data?.length || 0);
  if (result.data && result.data.length > 0) {
    const queueMessages = result.data as QueueMessage<{
      gradebook_column_id: number;
      student_id: string;
      gradebook_column_student_id: number;
      is_private: boolean;
    }>[];

    // Filter cells to separate those that can be processed now vs those that need to wait
    const cellMessages = queueMessages.map((msg) => msg.message);
    const { readyToProcess: readyCells, waitingForDependencies: waitingCells } = await filterCellsByDependencyStatus(
      cellMessages,
      adminSupabase,
      scope
    );

    // Map back to queue messages
    const readyToProcess = queueMessages.filter((msg) =>
      readyCells.some(
        (cell) =>
          cell.gradebook_column_id === msg.message.gradebook_column_id &&
          cell.student_id === msg.message.student_id &&
          cell.is_private === msg.message.is_private
      )
    );

    const waitingForDependencies = queueMessages.filter((msg) =>
      waitingCells.some(
        (cell) =>
          cell.gradebook_column_id === msg.message.gradebook_column_id &&
          cell.student_id === msg.message.student_id &&
          cell.is_private === msg.message.is_private
      )
    );

    scope.setTag("ready_to_process", readyToProcess.length);
    scope.setTag("waiting_for_dependencies", waitingForDependencies.length);

    // Re-queue cells that are waiting for dependencies
    if (waitingForDependencies.length > 0) {
      console.log(`Re-queuing ${waitingForDependencies.length} cells waiting for dependencies`);

      // Archive the original messages and send new ones with a delay
      const requeuePromises = waitingForDependencies.map(async (msg) => {
        // Archive the original message
        const { error: archiveError } = await adminSupabase
          .schema("pgmq_public")
          .rpc("archive", { queue_name: "gradebook_column_recalculate", message_id: msg.msg_id });

        if (archiveError) {
          const newScope = scope.clone();
          newScope.setContext("message_id", { id: msg.msg_id });
          newScope.setContext("message", msg.message);
          Sentry.captureException(archiveError, newScope);
          console.error("Error archiving message during requeue:", archiveError);
          return;
        }

        // Re-queue with a 5-second delay to avoid immediate re-processing
        // Note: pgmq doesn't support delay_seconds in send, so we'll just re-queue immediately
        // The worker polling interval should prevent immediate re-processing
        const { error: sendError } = await adminSupabase.schema("pgmq_public").rpc("send", {
          queue_name: "gradebook_column_recalculate",
          message: msg.message
        });

        if (sendError) {
          const newScope = scope.clone();
          newScope.setContext("message", msg.message);
          Sentry.captureException(sendError, newScope);
          console.error("Error re-queuing message:", sendError);
        }
      });

      await Promise.all(requeuePromises);
    }

    // Process only the cells that are ready
    if (readyToProcess.length > 0) {
      const studentColumns = readyToProcess.map((s) => ({
        gradebook_column_id: s.message.gradebook_column_id,
        student_id: s.message.student_id,
        gradebook_column_student_id: s.message.gradebook_column_student_id,
        is_private: s.message.is_private,
        onComplete: async () => {
          const { error: archiveError } = await adminSupabase
            .schema("pgmq_public")
            .rpc("archive", { queue_name: "gradebook_column_recalculate", message_id: s.msg_id });

          if (archiveError) {
            const newScope = scope.clone();
            newScope.setContext("message_id", { id: s.msg_id });
            newScope.setContext("message", s.message);
            Sentry.captureException(archiveError, newScope);
            console.error("Error archiving completed message:", archiveError);
          }
        }
      }));

      try {
        await processGradebookCellCalculation(studentColumns, adminSupabase, scope);
        return true;
      } catch (e) {
        Sentry.captureException(e, scope);
        return false;
      }
    } else {
      console.log("No cells ready to process - all are waiting for dependencies");
      return false;
    }
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
