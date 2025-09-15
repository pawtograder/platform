import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookRowCalculation } from "./GradebookProcessor.ts";
import * as Sentry from "npm:@sentry/deno";

export async function runHandler() {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const scope = new Sentry.Scope();

  const class_id = 7;
  const gradebook_id = 7;
  const student_id = "80fdc05a-2ff2-4548-a175-1729531ce99d";
  const is_private = true;

  const { data: gcsRows, error: gcsError } = await adminSupabase
    .from("gradebook_column_students")
    .select(
      "id, gradebook_column_id, is_missing, is_excused, is_droppable, score_override, score, released, score_override_note, incomplete_values"
    )
    .eq("class_id", class_id)
    .eq("gradebook_id", gradebook_id)
    .eq("student_id", student_id)
    .eq("is_private", is_private);
  if (gcsError || !gcsRows || gcsRows.length === 0) {
    console.log("No cells found or error", gcsError);
    return;
  }

  const updates = await processGradebookRowCalculation(adminSupabase, scope, {
    class_id,
    gradebook_id,
    student_id,
    is_private,
    gcsRows
  });

  const { data: updatedCount, error: rpcError } = await adminSupabase.rpc("update_gradebook_row", {
    p_class_id: class_id,
    p_gradebook_id: gradebook_id,
    p_student_id: student_id,
    p_is_private: is_private,
    p_updates: updates as unknown as Database["public"]["Functions"]["update_gradebook_row"]["Args"]["p_updates"]
  });
  console.log("Updated cells:", updatedCount ?? null, rpcError ?? null);
}

runHandler();
