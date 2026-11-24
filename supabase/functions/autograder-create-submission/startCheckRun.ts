import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import type { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";

/** Merge into fresh status, preserving completion metadata from concurrent webhooks. */
export async function startCheckRun(client: SupabaseClient<Database>, id: number, consumeTrigger: boolean) {
  const startedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: current, error } = await client
      .from("repository_check_runs")
      .select("status")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!current) throw new Error(`check run ${id} not found`);
    const update = {
      status: { ...((current.status ?? {}) as CheckRunStatus), started_at: startedAt },
      ...(consumeTrigger ? { triggered_by: null } : {})
    };
    let query = client.from("repository_check_runs").update(update).eq("id", id);
    query = current.status === null ? query.is("status", null) : query.eq("status", JSON.stringify(current.status));
    const { data: written, error: writeError } = await query.select("id");
    if (writeError) throw writeError;
    if (written?.length) return;
  }
  throw new Error(`check run ${id} status kept changing; started_at not written`);
}
