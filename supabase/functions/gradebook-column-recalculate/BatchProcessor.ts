import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookCellCalculation } from "./GradebookProcessor.ts";
import { QueueMessage } from "./index.ts";

export async function runHandler() {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "gradebook_column_recalculate",
    sleep_seconds: 5,
    n: 10000
  });
  const startTime = Date.now();
  console.log(`Reading ${result.data?.length} messages from gradebook_column_recalculate queue`);
  if (result.error) {
    console.error(result.error);
  }
  if (result.data) {
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
      onComplete: () => {
        adminSupabase
          .schema("pgmq_public")
          .rpc("archive", { queue_name: "gradebook_column_recalculate", message_id: s.msg_id });
      }
    }));
    for (const studentColumn of studentColumns) {
      if (studentColumn.gradebook_column_id === 17) {
        console.error(studentColumn);
        throw new Error("Test error");
      }
    }
    await processGradebookCellCalculation(studentColumns, adminSupabase);
  }
}

runHandler();
