/**
 * Debug script to process gradebook rows for a specific student.
 *
 * Usage:
 *   deno run --allow-net --allow-env DebugOneRow.ts <student_private_profile_id>
 *
 * Example:
 *   deno run --allow-net --allow-env DebugOneRow.ts 123e4567-e89b-12d3-a456-426614174000
 *
 * This script will:
 * 1. Find all gradebook rows for the specified student
 * 2. Process each gradebook row using the same logic as BatchProcessor
 * 3. Apply any calculated updates to the database
 * 4. Mark the rows as clean when processing is complete
 */
/* eslint-disable no-console */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookRowsCalculation } from "./GradebookProcessor.ts";

console.log(Deno.env.get("SUPABASE_URL"));

export async function debugOneRow(studentPrivateProfileId: string) {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const scope = new Sentry.Scope();

  console.log(`Processing gradebook rows for student: ${studentPrivateProfileId}`);

  // Find all gradebook rows for this student
  const { data: gradebookRows, error: rowsError } = await adminSupabase
    .from("gradebook_row_recalc_state")
    .select("class_id, gradebook_id, student_id, is_private")
    .eq("student_id", studentPrivateProfileId);

  if (rowsError) {
    console.error("Error fetching gradebook rows:", rowsError);
    Sentry.captureException(rowsError, scope);
    return;
  }

  if (!gradebookRows || gradebookRows.length === 0) {
    console.log("No gradebook rows found for this student");
    return;
  }

  console.log(`Found ${gradebookRows.length} gradebook rows to process`);

  // Group by (class_id, gradebook_id, is_private)
  const groupedRows = new Map<string, (typeof gradebookRows)[0]>();
  for (const row of gradebookRows) {
    const key = `${row.class_id}:${row.gradebook_id}:${row.is_private}`;
    groupedRows.set(key, row);
  }

  // Process each gradebook separately
  for (const [, row] of groupedRows.entries()) {
    const { class_id, gradebook_id, student_id, is_private } = row;
    if (!is_private) continue;
    console.log(`Processing gradebook ${gradebook_id} for student ${student_id} (private: ${is_private})`);

    const gbScope = scope.clone();
    gbScope.setTag("class_id", class_id);
    gbScope.setTag("gradebook_id", gradebook_id);
    gbScope.setTag("student_id", student_id);
    gbScope.setTag("is_private", is_private);

    // Fetch gradebook column students data for this student in this gradebook
    const { data: gcsData, error: gcsError } = await adminSupabase
      .from("gradebook_column_students")
      .select(
        "id, gradebook_column_id, is_missing, is_excused, is_droppable, score_override, score, released, score_override_note, incomplete_values"
      )
      .eq("class_id", class_id)
      .eq("gradebook_id", gradebook_id)
      .eq("student_id", student_id)
      .eq("is_private", is_private);

    if (gcsError) {
      console.error("Error fetching gradebook column students:", gcsError);
      Sentry.captureException(gcsError, gbScope);
      continue;
    }

    if (!gcsData || gcsData.length === 0) {
      console.log(`No gradebook column students found for gradebook ${gradebook_id}`);
      continue;
    }

    console.log(`Found ${gcsData.length} gradebook column students to process`);

    // Mark as recalculating
    await adminSupabase.from("gradebook_row_recalc_state").upsert({
      class_id,
      gradebook_id,
      student_id,
      is_private,
      dirty: true,
      is_recalculating: true,
      updated_at: new Date().toISOString()
    });

    // Get current version for optimistic locking
    const { data: versionData } = await adminSupabase
      .from("gradebook_row_recalc_state")
      .select("version")
      .eq("class_id", class_id)
      .eq("gradebook_id", gradebook_id)
      .eq("student_id", student_id)
      .eq("is_private", is_private)
      .single();

    const expectedVersion = (versionData as unknown as { version?: number } | null)?.version ?? 0;

    // Process the gradebook row calculation
    const updatesByStudent = await processGradebookRowsCalculation(adminSupabase, gbScope, {
      class_id,
      gradebook_id,
      rows: [{ student_id, gcsRows: gcsData, is_private }]
    });

    const updates = updatesByStudent.get(student_id) ?? [];
    console.log(`Generated ${updates.length} updates for student ${student_id}`);
    for (const update of updates) {
      console.log(`Update: ${JSON.stringify(update)}`);
    }

    if (updates.length > 0) {
      // Apply updates using the update_gradebook_row function
      const payload: Database["public"]["Functions"]["update_gradebook_row"]["Args"] = {
        p_class_id: class_id,
        p_gradebook_id: gradebook_id,
        p_student_id: student_id,
        p_is_private: is_private,
        p_updates: updates as unknown as Database["public"]["Functions"]["update_gradebook_row"]["Args"]["p_updates"],
        p_expected_version: expectedVersion
      };

      const { error: rpcError } = await adminSupabase.rpc("update_gradebook_row", payload);
      if (rpcError) {
        console.error("Error updating gradebook row:", rpcError);
        Sentry.captureException(rpcError, gbScope);
      } else {
        console.log(`Successfully applied ${updates.length} updates`);
      }
    }

    // Check if version changed (indicating successful update)
    const { data: verAfter } = await adminSupabase
      .from("gradebook_row_recalc_state")
      .select("version")
      .eq("class_id", class_id)
      .eq("gradebook_id", gradebook_id)
      .eq("student_id", student_id)
      .eq("is_private", is_private)
      .single();

    const versionAfter = (verAfter as unknown as { version?: number } | null)?.version ?? null;
    if (versionAfter === expectedVersion) {
      // Mark as clean and not recalculating
      await adminSupabase
        .from("gradebook_row_recalc_state")
        .update({ dirty: false, is_recalculating: false, updated_at: new Date().toISOString() })
        .eq("class_id", class_id)
        .eq("gradebook_id", gradebook_id)
        .eq("student_id", student_id)
        .eq("is_private", is_private);
      console.log(`Marked gradebook row as clean`);
    } else {
      console.log(`Version changed during update (expected: ${expectedVersion}, got: ${versionAfter})`);
    }
  }

  console.log("Finished processing all gradebook rows for student");
}

// Parse command line arguments
const args = Deno.args;
if (args.length < 1) {
  console.error("Usage: deno run DebugOneRow.ts <student_private_profile_id>");
  Deno.exit(1);
}

const studentPrivateProfileId = args[0];

// Initialize Sentry if configured
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

// Run the debug function
debugOneRow(studentPrivateProfileId).catch((error) => {
  console.error("Error running debug script:", error);
  Deno.exit(1);
});
