import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database, Json } from "../_shared/SupabaseTypes.d.ts";

//Submit a response to a survey


export type SurveySubmitResponseRequest = {
  survey_response_id: string; //id of the survey response to submit a response to 
  response: Json; //reponse to the survey 
}

export type SurveySubmitResponseResponse = {
  success: boolean; //true if the response was submitted successfully, false otherwise
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

  //Check if the survey response is already submitted
  const { data: existingResponse, error: fetchError } = await supabase
    .from("survey_responses")
    .select("is_submitted")
    .eq("id", survey_response_id)
    .single();

  if (fetchError) {
    throw new Error(`Failed to fetch survey response: ${fetchError.message}`);
  }

  //if the survey response has already been submitted, throw an error
  if (existingResponse.is_submitted) {
    throw new Error("Survey response has already been submitted");

    return {
      success: false,
    };
  }

  //Update the response
  const { error: survey_responseError } = await supabase
    .from("survey_responses")
    .update({
      response: response,
      is_submitted: true,
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
