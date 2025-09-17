import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookCellCalculation } from "./GradebookProcessor.ts";
import { QueueMessage } from "./index.ts";
import * as Sentry from "npm:@sentry/deno";
console.log(Deno.env.get("SUPABASE_URL"));
export async function runHandler() {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "gradebook_column_recalculate",
    sleep_seconds: 20,
    n: 500
  });
  let nDone = 0;
  console.log(`Reading ${result.data?.length} messages from gradebook_column_recalculate queue`);
  if (result.error) {
    console.error(result.error);
  }
  if (result.data) {
    const scope = new Sentry.Scope();
    scope.setTag("batch_processor", "gradebook_row_recalculate");
    const studentColumns = (
      result.data as QueueMessage<{
        gradebook_column_id: number;
        student_id: string;
        gradebook_column_student_id: number;
        is_private: boolean;
      }>[]
    ).map((s) => ({
      gradebook_column_id: s.message.gradebook_column_id,
      student_id: s.message.student_id,
      gradebook_column_student_id: s.message.gradebook_column_student_id,
      is_private: s.message.is_private,
      debug: s,
      onComplete: async () => {
        nDone++;
        if (nDone % 10 === 0) {
          console.log(`Done ${nDone} of ${studentColumns.length}`);
        }
        await adminSupabase
          .schema("pgmq_public")
          .rpc("archive", { queue_name: "gradebook_row_recalculate", message_id: s.msg_id });
      }
    }));
    await processGradebookCellCalculation(studentColumns, adminSupabase, scope);
    console.log(`Done ${nDone} of ${studentColumns.length}`);
    await runHandler();
  }
}

runHandler();
