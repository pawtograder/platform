import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { AutograderRerunGraderRequest } from "../_shared/FunctionTypes.d.ts";
import { triggerWorkflow } from "../_shared/GitHubWrapper.ts";
import { assertUserIsInstructorOrGrader, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { submission_ids, class_id } = (await req.json()) as AutograderRerunGraderRequest;
  scope?.setTag("function", "autograder-rerun-grader");
  scope?.setTag("class_id", class_id.toString());
  scope?.setTag("submission_ids", submission_ids.join(","));
  const { supabase, enrollment } = await assertUserIsInstructorOrGrader(
    class_id,
    req.headers.get("Authorization") || ""
  );
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  const { data: submissionData, error: submissionError } = await supabase
    .from("submissions")
    .select("*")
    .in("id", submission_ids);
  if (submissionError) {
    throw new Error(submissionError.message);
  }
  for (const submission of submissionData) {
    const { error: updateError } = await adminSupabase
      .from("repository_check_runs")
      .update({
        triggered_by: enrollment.private_profile_id
      })
      .eq("id", submission.repository_check_run_id!)
      .single();
    if (updateError) {
      throw new UserVisibleError(`Failed to update repository check run: ${updateError.message}`);
    }

    await triggerWorkflow(submission.repository, submission.sha, "grade.yml");
  }
  return {};
}
Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
