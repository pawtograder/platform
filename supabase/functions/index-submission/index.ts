import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";

import { indexSubmission } from "../_shared/CodeSymbolIndexer.ts";
import type { IndexSubmissionRequest, IndexSubmissionResponse } from "../_shared/FunctionTypes.d.ts";
import { assertUserIsInstructorOrServiceRole, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<IndexSubmissionResponse> {
  const { submission_id } = (await req.json()) as IndexSubmissionRequest;
  scope?.setTag("function", "index-submission");
  if (typeof submission_id !== "number") {
    throw new UserVisibleError("submission_id is required", 400);
  }
  scope?.setTag("submission_id", submission_id.toString());

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Authorize: indexing is triggered server-side (ingestion / backfill, both service-role) or by an
  // instructor of the submission's class. Resolve the class from the submission first.
  const { data: submission, error: submissionError } = await adminSupabase
    .from("submissions")
    .select("class_id")
    .eq("id", submission_id)
    .single();
  if (submissionError || !submission) {
    throw new UserVisibleError("Submission not found", 404);
  }
  await assertUserIsInstructorOrServiceRole(submission.class_id, req.headers.get("Authorization"));

  const result = await indexSubmission(adminSupabase, submission_id);
  return result;
}

Deno.serve(async (req) => {
  return wrapRequestHandler(req, handleRequest);
});
