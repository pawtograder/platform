import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { assertUserIsInstructorOrGrader, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as Sentry from "npm:@sentry/deno";
import { Json } from "../_shared/SupabaseTypes.d.ts";

export type Request = {
  operation: "publish" | "archive" | "draft";
  survey_id?: string;
  class_id?: number;
  class_section_id?: number;
  title?: string;
  description?: string;
  questions?: Json;
};

export type Response = {
  success: boolean;
  survey_ids: string[];
};

async function handleRequest(
  req: Request,
  scope: Sentry.Scope
): Promise<Response> {
  const { operation, survey_id, class_id, class_section_id, title, description, questions } = (await req.json()) as Request;

  scope?.setTag("function", "survey-create-survey");
  scope?.setTag("operation", operation);
  scope?.setTag("class_id", class_id?.toString() || "");
  scope?.setTag("class_section_id", class_section_id?.toString() || "");
  scope?.setTag("title", title || "");
  scope?.setTag("description", description || "");
  scope?.setTag("questions", JSON.stringify(questions || []));

  // Determine which class_id to use for authentication
  let auth_class_id: number;
  if (class_id) {
    auth_class_id = class_id;
  } else if (class_section_id) {
    // Get class_id from class_section_id for authentication
    const supabase_temp = await import("https://esm.sh/@supabase/supabase-js@2").then(m => m.createClient);
    const temp_client = supabase_temp(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization")! }
        }
      }
    );
    const { data: section } = await temp_client
      .from("class_sections")
      .select("class_id")
      .eq("id", class_section_id)
      .single();

    if (!section) {
      throw new Error("Invalid class_section_id");
    }
    auth_class_id = section.class_id;
  } else {
    throw new Error("Must provide either class_id or class_section_id");
  }

  const { supabase, enrollment } = await assertUserIsInstructorOrGrader(auth_class_id, req.headers.get("Authorization")!);
  const publisher_profile_id = enrollment.public_profile_id;

  switch (operation) {
    case "publish":
      return await publishSurvey(supabase, survey_id, publisher_profile_id, class_id, class_section_id, title, description, questions);
    case "archive":
      return await archiveSurvey(supabase, survey_id);
    case "draft":
      return await draftSurvey(supabase, publisher_profile_id, class_section_id, title, description, questions);
  }

  throw new Error(`Invalid operation: ${operation}`);
}

const publishSurvey = async (
  supabase: any,
  survey_id?: string,
  publisher_profile_id: string,
  class_id?: number,
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
        status: "published",
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
      survey_ids: [survey.id],
    };
  }
  let class_sections_ids: number[] = [];

  if (class_id) {
    // Get all sections in the class
    const { data: class_sections, error: class_sectionsError } = await supabase
      .from("class_sections")
      .select("id")
      .eq("class_id", class_id);

    if (class_sectionsError) {
      throw new Error(`Failed to fetch class sections: ${class_sectionsError.message}`);
    }

    class_sections_ids = class_sections.map((section: any) => section.id);
  } else if (class_section_id) {
    // Just use the single section
    class_sections_ids = [class_section_id];
  } else {
    throw new Error("Must provide either class_id or class_section_id");
  }

  const new_survey_ids: string[] = [];

  // Use for...of to properly await each survey creation
  for (const section_id of class_sections_ids) {
    const { data: survey, error: surveyError } = await supabase
      .from("surveys")
      .insert({
        class_section_id: section_id,
        assigned_by: publisher_profile_id,
        title: title,
        description: description,
        questions: questions,
        status: "published",
      })
      .select("id")
      .single();

    if (surveyError) {
      throw new Error(`Failed to create survey: ${surveyError.message}`);
    }

    new_survey_ids.push(survey.id);
    
    // Create survey responses for students in this section
    await create_survey_responses(supabase, survey.id, section_id);
  }
  
  return {
    success: true,
    survey_ids: new_survey_ids,
  };
}

// Create empty survey responses for all students in a class section
const create_survey_responses = async (
  supabase: any,
  survey_id: string,
  section_id: number
) => {
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
      const { error: survey_responseError } = await supabase
        .from("survey_responses")
        .insert({
          survey_id: survey_id,
          profile_id: student.public_profile_id,
        });

      if (survey_responseError) {
        throw new Error(`Failed to create survey response: ${survey_responseError.message}`);
      }
    }
  }
}

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
    survey_ids: [survey.id],
  };
}

const draftSurvey = async (
  supabase: any,
  publisher_profile_id: string,
  class_section_id?: number,
  title?: string,
  description?: string,
  questions?: Json
) => {
  if (!class_section_id) {
    throw new Error("class_section_id is required for draft operation");
  }

  const { data: survey, error: surveyError } = await supabase
    .from("surveys")
    .insert({
      class_section_id: class_section_id,
      assigned_by: publisher_profile_id,
      title: title,
      description: description,
      questions: questions,
      status: "draft",
    })
    .select("id")
    .single();

  if (surveyError) {
    throw new Error(`Failed to create survey: ${surveyError.message}`);
  }

  return {
    success: true,
    survey_ids: [survey.id],
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
