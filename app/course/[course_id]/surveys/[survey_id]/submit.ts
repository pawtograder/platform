import { createClient } from "@/utils/supabase/client";

export type ResponseData = Record<string, any>;

export async function saveResponse(
  surveyId: string, 
  studentId: string, 
  responseData: ResponseData, 
  isSubmitted: boolean = false
) {
  const supabase = createClient();
  
  console.log("💾 Saving survey response:", {
    surveyId,
    studentId,
    isSubmitted,
    responseDataKeys: Object.keys(responseData),
    responseDataSample: JSON.stringify(responseData).slice(0, 200)
  });
  
  try {
    // Upsert to survey_responses table
    const { data, error } = await supabase
      .from("survey_responses" as any)
      .upsert({
        survey_id: surveyId,
        student_id: studentId,
        response: responseData,
        is_submitted: isSubmitted
      }, {
        onConflict: "survey_id,student_id"
      })
      .select()
      .single();

    if (error) {
      console.error("❌ Database error saving response:", {
        error,
        errorCode: error.code,
        errorMessage: error.message,
        errorDetails: error.details,
        errorHint: error.hint,
        surveyId,
        studentId
      });
      throw error;
    }

    console.log("✅ Response saved successfully:", {
      responseId: data?.id,
      isSubmitted
    });

    return data;
  } catch (error) {
    console.error("❌ Exception saving response:", {
      error,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      surveyId,
      studentId
    });
    throw error;
  }
}

export async function getResponse(surveyId: string, studentId: string) {
  const supabase = createClient();
  
  try {
    const { data, error } = await supabase
      .from("survey_responses" as any)
      .select("*")
      .eq("survey_id", surveyId)
      .eq("student_id", studentId)
      .single();

    if (error && error.code !== "PGRST116") { // PGRST116 = no rows returned
      throw error;
    }

    return data;
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

    // Get the student IDs (which are user UUIDs)
    const studentIds = responses.map((r: any) => r.student_id);

    // Get user_roles to map user_id to private_profile_id
    const { data: userRoles, error: userRolesError } = await supabase
      .from("user_roles" as any)
      .select(`
        user_id,
        private_profile_id,
        profiles:private_profile_id (
          id,
          name,
          sis_user_id
        )
      `)
      .eq("class_id", classId)
      .in("user_id", studentIds);

    if (userRolesError) {
      console.error("Error getting user roles:", userRolesError);
      throw userRolesError;
    }

    // Create a map of user_id to profile data
    const userProfileMap = new Map();
    userRoles?.forEach((role: any) => {
      userProfileMap.set(role.user_id, role.profiles);
    });

    // Combine responses with profile data
    const responsesWithProfiles = responses.map((response: any) => ({
      ...response,
      profiles: userProfileMap.get(response.student_id) || {
        id: response.student_id,
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
