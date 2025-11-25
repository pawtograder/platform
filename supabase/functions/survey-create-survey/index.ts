import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { assertUserIsInstructorOrGrader, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as Sentry from "npm:@sentry/deno";
import { Json } from "../_shared/SupabaseTypes.d.ts";

//Functions for publishing, archiving, and drafting surveys.

export type Request = {
  operation: "publish" | "archive" | "draft"; //The operation to perform for a survey
  survey_id?: string; //To publish, archive, draft, an existing survey
  class_id: number; //To publish a survey for a class
  class_section_id?: number; //To publish a survey for a specific section
  title?: string; //Title of survey to publish or draft
  description?: string; //Description of survey to publish or draft
  questions?: Json; //Question of survey to publish or draft
};

export type Response = {
  success: boolean;
  survey_ids: string[]; //The ids of the surveys that were created
};

async function handleRequest(req: Request, scope: Sentry.Scope): Promise<Response> {
  const { operation, survey_id, class_id, class_section_id, title, description, questions } =
    (await req.json()) as Request;

  scope?.setTag("function", "survey-create-survey");
  scope?.setTag("operation", operation);
  scope?.setTag("class_id", class_id?.toString() || "");
  scope?.setTag("class_section_id", class_section_id?.toString() || "");
  scope?.setTag("title", title || "");
  scope?.setTag("description", description || "");
  scope?.setTag("questions", JSON.stringify(questions || []));

  // Verify user is an instructor or grader and get their profile
  const { supabase, enrollment } = await assertUserIsInstructorOrGrader(class_id, req.headers.get("Authorization")!);
  if (!enrollment) {
    throw new Error("User is not an instructor or grader for this course");
  }
  const publisher_profile_id = enrollment?.public_profile_id;

  //handle the different operations
  switch (operation) {
    case "publish":
      return await publishSurvey(
        supabase,
        survey_id,
        publisher_profile_id,
        class_id,
        class_section_id,
        title,
        description,
        questions
      );
    case "archive":
      return await archiveSurvey(supabase, survey_id);
    case "draft":
      return await draftSurvey(
        supabase,
        publisher_profile_id,
        class_id,
        class_section_id,
        title,
        description,
        questions
      );
  }

  throw new Error(`Invalid operation: ${operation}`);
}

//Publish an existing survey or create a new survey and publish it
const publishSurvey = async (
  supabase: any,
  survey_id?: string,
  publisher_profile_id: string,
  class_id: number,
  class_section_id?: number,
  title?: string,
  description?: string,
  questions?: Json
) => {
  // If survey_id is provided, publish an existing draft survey
  if (survey_id) {
    const { data: survey, error: surveyError } = await supabase
      .from("surveys")
      .update({
        status: "published"
      })
      .eq("id", survey_id)
      .select("id, class_section_id")
      .single();

    if (surveyError) {
      throw new Error(`Failed to publish survey: ${surveyError.message}`);
    }

    // Create survey responses for students in the section
    await create_survey_responses(supabase, survey.id, survey.class_section_id);

    return {
      success: true,
      survey_ids: [survey.id]
    };
  }

  //if class_section_id is provided, publish a survey for the single section
  if (class_section_id) {
    const survey = await createSurvey(
      supabase,
      class_id,
      class_section_id,
      publisher_profile_id,
      title,
      description,
      questions,
      "published"
    );
    await create_survey_responses(supabase, survey.id, class_section_id);
    return {
      success: true,
      survey_ids: [survey.id]
    };
  }
  // Get all sections in the class
  const { data: class_sections, error: class_sectionsError } = await supabase
    .from("class_sections")
    .select("id")
    .eq("class_id", class_id);

  if (class_sectionsError) {
    throw new Error(`Failed to fetch class sections: ${class_sectionsError.message}`);
  }

  const class_sections_ids = class_sections.map((section: any) => section.id);

  //store ids of surveys created
  const new_survey_ids: string[] = [];

  //create a survey for each section
  for (const section_id of class_sections_ids) {
    const survey = await createSurvey(
      supabase,
      class_id,
      section_id,
      publisher_profile_id,
      title,
      description,
      questions,
      "published"
    );
    await create_survey_responses(supabase, survey.id, section_id);
    new_survey_ids.push(survey.id);
  }
  return {
    success: true,
    survey_ids: new_survey_ids
  };
};

//Create a single survey
const createSurvey = async (
  supabase: any,
  class_id: number,
  section_id: number,
  publisher_profile_id: string,
  title: string,
  description?: string,
  questions: Json,
  status: "draft" | "published" = "published"
) => {
  const { data: survey, error: surveyError } = await supabase
    .from("surveys")
    .insert({
      class_id: class_id,
      class_section_id: section_id,
      assigned_by: publisher_profile_id,
      title: title,
      description: description,
      questions: questions,
      status: status
    })
    .select("id")
    .single();

  if (surveyError) {
    throw new Error(`Failed to create survey: ${surveyError.message}`);
  }

  return survey;
};

// Create empty survey responses for all students in a class section
const create_survey_responses = async (supabase: any, survey_id: string, section_id: number) => {
  const { data: students, error: studentsError } = await supabase
    .from("user_roles")
    .select("public_profile_id")
    .eq("class_section_id", section_id)
    .eq("role", "student");

  if (studentsError) {
    throw new Error(`Failed to fetch students: ${studentsError.message}`);
  }

  if (students && students.length > 0) {
    for (const student of students) {
      const { error: survey_responseError } = await supabase.from("survey_responses").insert({
        survey_id: survey_id,
        profile_id: student.public_profile_id
      });

      if (survey_responseError) {
        throw new Error(`Failed to create survey response: ${survey_responseError.message}`);
      }
    }
  }
};

//Archive an existing survey
const archiveSurvey = async (supabase: any, survey_id?: string) => {
  if (!survey_id) {
    throw new Error("survey_id is required for archive operation");
  }

  const { data: survey, error: surveyError } = await supabase
    .from("surveys")
    .update({ status: "archived" })
    .eq("id", survey_id)
    .select("id")
    .single();

  if (surveyError) {
    throw new Error(`Failed to archive survey: ${surveyError.message}`);
  }

  return {
    success: true,
    survey_ids: [survey.id]
  };
};

//Save a survey as a draft
const draftSurvey = async (
  supabase: any,
  publisher_profile_id: string,
  class_id: number,
  class_section_id: number,
  title: string,
  description?: string,
  questions: Json
) => {
  //check for valid titld, and questions
  if (!title) {
    throw new Error("Title is required for draft operation");
  }
  if (!questions) {
    throw new Error("Questions are required for draft operation");
  }

  const survey = await createSurvey(
    supabase,
    class_id,
    class_section_id,
    publisher_profile_id,
    title,
    description,
    questions,
    "draft"
  );

  return {
    success: true,
    survey_ids: [survey.id]
  };
};

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
