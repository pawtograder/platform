import { createClient } from "@/utils/supabase/client";
import { ResponseData, SurveyResponse } from "@/types/survey";

export async function saveResponse(
  surveyId: string,
  profileID: string,
  responseData: ResponseData,
  isSubmitted: boolean = false
) {
  const supabase = createClient();

  try {
    // Upsert to survey_responses table
    const { data, error } = await supabase
      .from("survey_responses" as any)
      .upsert(
        {
          survey_id: surveyId,
          profile_id: profileID,
          response: responseData,
          is_submitted: isSubmitted
        },
        {
          onConflict: "survey_id,profile_id"
        }
      )
      .select()
      .single();

    if (error) {
      console.error("Database error saving response:", error);
      throw error;
    }

    return data;
  } catch (error) {
    console.error("Exception saving response:", error);
    throw error;
  }
}

export async function getResponse(surveyId: string, profileID: string): Promise<SurveyResponse | null> {
  const supabase = createClient();

  try {
    const { data, error } = await supabase
      .from("survey_responses" as any)
      .select("*")
      .eq("survey_id", surveyId)
      .eq("profile_id", profileID)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("getResponse error:", error);
      throw error;
    }

    return (data ?? null) as SurveyResponse | null;
  } catch (error) {
    console.error("Error getting response:", error);
    throw error;
  }
}

export async function getAllResponses(surveyId: string, classId: string) {
  const supabase = createClient();

  try {
    // First, get the survey responses
    const { data: responses, error: responsesError } = await supabase
      .from("survey_responses" as any)
      .select("*")
      .eq("survey_id", surveyId)
      .order("submitted_at", { ascending: false });

    if (responsesError) {
      console.error("Error getting survey responses:", responsesError);
      throw responsesError;
    }

    if (!responses || responses.length === 0) {
      return [];
    }

    // Get the profile_ids from responses
    const profileIds = responses.map((r: any) => r.profile_id);

    // Get user_roles to map profile -> profile data (and optionally user_id)
    // We assume survey_responses.profile_id corresponds to user_roles.private_profile_id
    const { data: userRoles, error: userRolesError } = await supabase
      .from("user_roles" as any)
      .select(
        `
        user_id,
        private_profile_id,
        profiles:private_profile_id (
          id,
          name,
          sis_user_id
        )
      `
      )
      .eq("class_id", classId)
      .in("private_profile_id", profileIds); // ✅ was in("user_id", ...)

    if (userRolesError) {
      console.error("Error getting user roles:", userRolesError);
      throw userRolesError;
    }

    // Create a map of profile_id -> profile data
    const profileMap = new Map();
    userRoles?.forEach((role: any) => {
      profileMap.set(role.private_profile_id, role.profiles);
    });

    // Combine responses with profile data
    const responsesWithProfiles = responses.map((response: any) => ({
      ...response,
      profiles: profileMap.get(response.profile_id) || {
        id: response.profile_id,
        name: "Unknown Student",
        sis_user_id: null
      }
    }));

    return responsesWithProfiles;
  } catch (error) {
    console.error("Error getting all responses:", error);
    throw error;
  }
}

export async function deleteResponse(responseId: string) {
  const supabase = createClient();

  try {
    const { error } = await supabase
      .from("survey_responses" as any)
      .delete()
      .eq("id", responseId);

    if (error) {
      throw error;
    }

    return true;
  } catch (error) {
    console.error("Error deleting response:", error);
    throw error;
  }
}
