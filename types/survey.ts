import type { Tables } from "@/utils/supabase/SupabaseTypes";

type DbSurvey = Tables<"surveys">;
type DbSurveyResponse = Tables<"survey_responses">;
type DbSurveyAssignee = Tables<"survey_assignments">;

export type ResponseData = DbSurveyResponse["response"];

export type SurveyResponse = DbSurveyResponse;

export type SurveyResponseWithProfile = SurveyResponse & {
  profiles: {
    id: string;
    name: string | null;
    sis_user_id?: string | null;
  };
};

export type Survey = DbSurvey;

export type SurveyWithResponse = Survey & {
  response_status: "not_started" | "in_progress" | "completed";
  submitted_at?: string | null;
  is_submitted?: boolean;
};

export type SurveyWithCounts = Survey & {
  response_count: number;
  assigned_student_count: number;
};

export type SurveyAssignee = DbSurveyAssignee;

export type SurveyWithAssignees = Survey & {
  assignees: SurveyAssignee[];
};

/** Profile display name for a survey response row (SSR join or analytics RPC). */
export function getSurveyResponseProfileName(response: {
  profiles?: { name: string | null } | null;
  profile_name?: string | null;
}): string {
  return (response.profiles?.name ?? response.profile_name ?? "").trim();
}

/** Stable comparator for survey response lists (table, analytics, CSV). */
export function compareSurveyResponsesByProfile<
  T extends {
    profile_id: string;
    profiles?: { name: string | null } | null;
    profile_name?: string | null;
    submitted_at?: string | null;
  }
>(a: T, b: T): number {
  const byName = getSurveyResponseProfileName(a).localeCompare(getSurveyResponseProfileName(b), undefined, {
    sensitivity: "base"
  });
  if (byName !== 0) return byName;
  const bySubmitted = (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "");
  if (bySubmitted !== 0) return bySubmitted;
  return a.profile_id.localeCompare(b.profile_id);
}

export function sortSurveyResponsesByProfile<
  T extends {
    profile_id: string;
    profiles?: { name: string | null } | null;
    profile_name?: string | null;
    submitted_at?: string | null;
  }
>(responses: T[]): T[] {
  return [...responses].sort(compareSurveyResponsesByProfile);
}
