import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { processGradebookCellCalculation } from "./GradebookProcessor.ts";

export type QueueMessage<T> = {
  msg_id: number;
  read_ct: number;
  vt: string;
  enqueued_at: string;
  message: T;
};

export async function runHandler() {
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const result = await adminSupabase.schema("pgmq_public").rpc("read", {
    queue_name: "gradebook_column_recalculate",
    sleep_seconds: 20,
    n: 100
  });
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
      onComplete: async () => {
        await adminSupabase
          .schema("pgmq_public")
          .rpc("archive", { queue_name: "gradebook_column_recalculate", message_id: s.msg_id });
      }
    }));
    try {
      await processGradebookCellCalculation(studentColumns, adminSupabase);
    } catch (e) {
      console.error(e);
    }
  }
}

Deno.serve(async (req) => {
  const headers = req.headers;
  const secret = headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";
  if (secret !== expectedSecret) {
    return new Response(JSON.stringify({ error: "Invalid secret" }), {
      headers: { "Content-Type": "application/json" }
    });
  }
  await runHandler();
  return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
});
