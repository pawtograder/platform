import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { assertUserIsInstructor, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as Sentry from "npm:@sentry/deno";
import { Json } from "../_shared/SupabaseTypes.d.ts";

export type PublishSurveyToClassRequest = {
  class_id: number;
  class_section_id: number;
  title: string;
  description: string;
  questions: Json;
};

export type PublishSurveyToClassResponse = {
  success: boolean;
  survey_id: string;
};

async function handleRequest(
  req: Request,
  scope: Sentry.Scope
): Promise<PublishSurveyToClassResponse> {
  const { class_id, class_section_id, title, description, questions } = (await req.json()) as PublishSurveyToClassRequest;

  scope?.setTag("function", "survey-publish-to-class");
  scope?.setTag("class_id", class_id.toString());
  scope?.setTag("class_section_id", class_section_id.toString());
  scope?.setTag("title", title);

  // Verify user is an instructor or grader in the course
  const { supabase, enrollment } = await assertUserIsInstructorOrGrader(
    class_id,
    req.headers.get("Authorization")!
  );
  const publisher_profile_id = enrollment.public_profile_id;

  //Create survey
  const { data: survey, error: surveyError } = await supabase.from("surveys").insert({
    class_section_id: class_section_id,
    assigned_by: publisher_profile_id,
    title: title,
    description: description,
    questions: questions,
  }).select("id").single();
  if (surveyError) {
    throw new Error(`Failed to create survey: ${surveyError.message}`);
  }

  // Create empty survey responses for all students in the class section
  const { data: students, error: studentsError } = await supabase
    .from("user_roles")
    .select("public_profile_id")
    .eq("class_section_id", class_section_id)
    .eq("role", "student");

  if (studentsError) {
    throw new Error(`Failed to fetch students: ${studentsError.message}`);
  }

  if (students && students.length > 0) {
    for (const student of students) {
      const { error: survey_responseError } = await supabase
        .from("survey_responses")
        .insert({
          survey_id: survey.id,
          profile_id: student.public_profile_id,
        });
      if (survey_responseError) {
        throw new Error(`Failed to create survey response: ${survey_responseError.message}`);
      }
    }
  }
  return {
    success: true,
    survey_id: survey.id,
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});