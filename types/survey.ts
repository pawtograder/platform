import type { Tables } from "@/utils/supabase/SupabaseTypes";

type DbSurvey = Tables<"surveys">;
type DbSurveyResponse = Tables<"survey_responses">;

export type ResponseData = DbSurveyResponse["response"];

export type SurveyResponse = DbSurveyResponse;

export type SurveyResponseWithProfile = SurveyResponse & {
  profiles: {
    id: string;
    name: string | null;
  };
};

export type Survey = DbSurvey;

export type SurveyWithResponse = Survey & {
  response_status: "not_started" | "in_progress" | "completed";
  submitted_at?: string;
  is_submitted?: boolean;
};

export type SurveyWithCounts = Survey & {
  response_count: number;
  submitted_count: number;
};
