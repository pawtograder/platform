export type SurveyResponseWithContext = {
  /** Null when the row is a roster placeholder with no survey_responses row yet */
  response_id: string | null;
  profile_id: string;
  profile_name: string | null;
  is_submitted: boolean;
  submitted_at: string | null;
  response: Record<string, unknown>;
  group_id: number | null;
  group_name: string | null;
  /** Actual group membership count (from assignment_groups_members). Used for correct response rate. */
  group_member_count?: number | null;
  mentor_profile_id: string | null;
  mentor_name: string | null;
  profile_email?: string | null;
  mentor_email?: string | null;
  lab_section_id: number | null;
  lab_section_name: string | null;
  class_section_id: number | null;
  class_section_name: string | null;
};

export type QuestionStats = {
  mean: number;
  median: number;
  min: number;
  max: number;
  stdDev: number;
  count: number;
  distribution: Record<number, number>;
  deltaFromBaseline: number;
};

export type GroupAnalytics = {
  groupId: number;
  groupName: string;
  mentorId: string | null;
  mentorName: string | null;
  labSectionId: number | null;
  labSectionName: string | null;
  memberCount: number;
  responseCount: number;
  responseRate: number;
  questionStats: Record<string, QuestionStats>;
  alerts: Alert[];
  overallHealthScore: number;
};

export type SectionAnalytics = {
  sectionId: number;
  sectionName: string;
  sectionType: "lab" | "class";
  groupCount: number;
  studentCount: number;
  responseCount: number;
  questionStats: Record<string, QuestionStats>;
};

export type Alert = {
  type: "low_score" | "high_variance" | "non_response" | "impediment" | "declining_trend";
  severity: "info" | "warning" | "critical";
  message: string;
  questionName?: string;
  value?: number;
  threshold?: number;
};

export type TrendDataPoint = {
  surveyId: string;
  surveyTitle: string;
  ordinal: number;
  dueDate: string;
  groupId: number | null;
  groupName: string | null;
  questionName: string;
  mean: number;
  count: number;
};

export type AnalyticsViewMode = "course" | "section" | "group" | "mentor";

export type QuestionAnalyticsConfig = {
  includeInAnalytics: boolean;
  alertThreshold?: number;
  alertDirection?: "above" | "below" | "any_above" | "any_below";
  alertMessage?: string;
  isReversedScale?: boolean;
  flagValues?: number[];
  displayLabel?: string;
};

export type SurveyAnalyticsConfig = {
  questions: Record<string, QuestionAnalyticsConfig>;
  globalSettings: {
    varianceThreshold?: number;
    nonResponseThreshold?: number;
    trendDeclineCount?: number;
  };
};

export type SurveySeriesRow = {
  id: string;
  class_id: number;
  name: string;
  description: string | null;
  created_at: string;
  created_by: string | null;
};
