import type { Database, Tables } from "@/utils/supabase/SupabaseTypes";

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

type GeneratedSubmissionSurveyResponseRow =
  Database["public"]["Functions"]["get_survey_responses_for_submission"]["Returns"][number];

/**
 * One row of the `get_survey_responses_for_submission(p_submission_id bigint)` RPC:
 * one linked survey paired with one roster member.
 *
 * The six widened columns are genuinely null at runtime. Supabase codegen types every
 * `RETURNS TABLE` column as non-nullable, because it cannot see that the RPC LEFT JOINs
 * `survey_responses` — a roster member who never opened the survey comes back with a null
 * `response`, `submitted_at` and `updated_at`, and that row is the whole point of the
 * feature. `profile_name` follows nullable `profiles.name`; `due_date` and `available_at`
 * follow nullable columns on `surveys`. Do not collapse this back to the generated type:
 * TypeScript would then insist a non-respondent has answers, and the "Not started" card
 * would become unreachable.
 */
export type SubmissionSurveyResponseRow = Omit<
  GeneratedSubmissionSurveyResponseRow,
  "response" | "submitted_at" | "updated_at" | "profile_name" | "due_date" | "available_at"
> & {
  response: DbSurveyResponse["response"] | null;
  submitted_at: string | null;
  updated_at: string | null;
  profile_name: string | null;
  due_date: string | null;
  available_at: string | null;
};
