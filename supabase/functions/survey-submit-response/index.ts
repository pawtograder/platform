import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database, Json } from "../_shared/SupabaseTypes.d.ts";

export type SurveySubmitResponseRequest = {
  survey_response_id: string;
  response: Json;
}

export type SurveySubmitResponseResponse = {
  success: boolean;
}

async function handleRequest(
  req: Request,
  scope: Sentry.Scope
): Promise<SurveySubmitResponseResponse> {
  const { survey_response_id, response } = (await req.json()) as SurveySubmitResponseRequest;
  
  scope?.setTag("function", "survey-submit-response");
  scope?.setTag("survey_response_id", survey_response_id);

  const supabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    {
      global: {
        headers: { Authorization: req.headers.get("Authorization")! }
      }
    }
  );

  // First, check if the survey response is already submitted
  const { data: existingResponse, error: fetchError } = await supabase
    .from("survey_responses")
    .select("is_submitted")
    .eq("id", survey_response_id)
    .single();

  if (fetchError) {
    throw new Error(`Failed to fetch survey response: ${fetchError.message}`);
  }

  if (existingResponse.is_submitted) {
    throw new Error("Survey response has already been submitted");
  }

  // Now update the response
  const { error: survey_responseError } = await supabase
    .from("survey_responses")
    .update({
      response: response,
      is_submitted: true,
      // submitted_at is automatically set by database trigger when is_submitted becomes true
    })
    .eq("id", survey_response_id);
  
  if (survey_responseError) {
    throw new Error(`Failed to submit survey response: ${survey_responseError.message}`);
  }
  
  return {
    success: true,
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
