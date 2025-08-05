import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import type { AutograderTriggerGradingWorkflowRequest } from "../_shared/FunctionTypes.d.ts";
import { triggerWorkflow } from "../_shared/GitHubWrapper.ts";
import { assertUserIsInCourse, SecurityError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

export async function handleRequest(req: Request) {
  const { repository, sha, class_id } = (await req.json()) as AutograderTriggerGradingWorkflowRequest;
  const { supabase, enrollment } = await assertUserIsInCourse(class_id, req.headers.get("Authorization") || "");
  const { data: repoData } = await supabase
    .from("repositories")
    .select("*, repository_check_runs(*)")
    .eq("repository", repository)
    .eq("repository_check_runs.sha", sha)
    .single();
  if (!repoData) {
    throw new SecurityError(`User does not have access to repository ${repository}`);
  }
  if (!repoData.repository_check_runs.length) {
    throw new SecurityError(`Repository check run not found for ${repository} and sha ${sha}`);
  }
  const checkRun = repoData.repository_check_runs;
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  //Update the check run to be triggered by this user
  const { error: updateError } = await adminSupabase
    .from("repository_check_runs")
    .update({
      triggered_by: enrollment.private_profile_id
    })
    .eq("id", checkRun[0].id)
    .single();
  if (updateError) {
    throw new SecurityError(`Failed to update repository check run: ${updateError.message}`);
  }

  await triggerWorkflow(repository, sha, "grade.yml");
  // await triggerWorkflow(repository, "main", "grade.yml");
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
