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
    sortable_name?: string | null;
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

/** Seed-stable tiebreak when profile name and submitted_at match (email, then sortable_name). */
export function getSurveyResponseStableTiebreakKey(response: {
  profile_email?: string | null;
  profiles?: { sortable_name?: string | null } | null;
}): string {
  const email = (response.profile_email ?? "").trim();
  if (email) return email;
  return (response.profiles?.sortable_name ?? "").trim();
}

/** Stable comparator for survey response lists (table, analytics, CSV). */
export function compareSurveyResponsesByProfile<
  T extends {
    profiles?: { name: string | null; sortable_name?: string | null } | null;
    profile_name?: string | null;
    profile_email?: string | null;
    submitted_at?: string | null;
  }
>(a: T, b: T): number {
  const byName = getSurveyResponseProfileName(a).localeCompare(getSurveyResponseProfileName(b), undefined, {
    sensitivity: "base"
  });
  if (byName !== 0) return byName;
  const bySubmitted = (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "");
  if (bySubmitted !== 0) return bySubmitted;
  return getSurveyResponseStableTiebreakKey(a).localeCompare(getSurveyResponseStableTiebreakKey(b), undefined, {
    sensitivity: "base"
  });
}

export function sortSurveyResponsesByProfile<
  T extends {
    profiles?: { name: string | null; sortable_name?: string | null } | null;
    profile_name?: string | null;
    profile_email?: string | null;
    submitted_at?: string | null;
  }
>(responses: T[]): T[] {
  return [...responses].sort(compareSurveyResponsesByProfile);
}
