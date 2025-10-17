import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { assertUserIsInCourse, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as Sentry from "npm:@sentry/deno";
import { Json } from "../_shared/SupabaseTypes.d.ts";

export type GetSurveysRequest = {
  class_id: number;
  class_section_id: number;
};

export type SurveyWithResponseId = {
  survey_id: string; //Frontend will use this to submit answer to the survey
  survey_response_id: string; //Frontend will submit answer to this survey response id 
  title: string; //Frontend will display this in the survey list
  description: string; //Frontend will display this in the survey list
  questions: Json; // For SurveyJS to render the form
};

export type GetSurveysResponse = {
  success: boolean;
  surveys: SurveyWithResponseId[];
};

async function handleRequest(
  req: Request,
  scope: Sentry.Scope
): Promise<GetSurveysResponse> {
  const { class_id, class_section_id } = (await req.json()) as GetSurveysRequest;

  scope?.setTag("function", "survey-get-surveys");
  scope?.setTag("class_id", class_id.toString());
  scope?.setTag("class_section_id", class_section_id.toString());

  // Verify user is in the course and get their profile
  const { supabase, enrollment } = await assertUserIsInCourse(class_id, req.headers.get("Authorization")!);

  // Get all surveys for this class section with the user's response data
  // Joins survey_responses with surveys table
  const { data: surveysData, error: surveysError } = await supabase
    .from("survey_responses")
    .select(`
      id,
      surveys!inner (
        id,
        title,
        description,
        questions,
        class_section_id
      )
    `)
    .eq("profile_id", enrollment.public_profile_id)
    .eq("surveys.class_section_id", class_section_id)

  if (surveysError) {
    throw new Error(`Failed to fetch surveys: ${surveysError.message}`);
  }

  // Format the response for frontend
  const surveys: SurveyWithResponseId[] = surveysData?.map((item) => ({
    survey_id: item.surveys.id,
    survey_response_id: item.id,
    title: item.surveys.title,
    description: item.surveys.description,
    questions: item.surveys.questions,
  })) || [];

  return {
    success: true,
    surveys,
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});

/*
When called, this will return all surveys for a given student in class. 
frontend will pass class_section_id. supabse.getUser() to get user id. 
Get public_profile_id from user_roles where user_id = user id.
Then return all survey_id from survey_responses where profile_id = public_profile_id and is_summitted is false and class_section_id = class_section_id.
Then from surveys, return all surveys that have survey_id in the list of survey_ids. 
This will return all surveys that have not been submitted yet.

TODO: Add logic for grader/instructor views. DO NOT IMPLEMENT THIS YET.
 */

