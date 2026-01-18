/**
 * Shared types for test insights and error pin features
 */

// Rule target types matching the database enum
export type ErrorPinRuleTarget =
  | "grader_output_student"
  | "grader_output_hidden"
  | "lint_output"
  | "test_name"
  | "test_part"
  | "test_output"
  | "test_hidden_output"
  | "test_score_range"
  | "grader_score_range"
  | "lint_failed";

export type MatchType = "contains" | "regex" | "equals" | "range";

// Filter rule for error exploration
export interface ErrorFilterRule {
  id: string;
  target: ErrorPinRuleTarget;
  match_type: MatchType;
  match_value: string;
  match_value_max?: string;
  test_name_filter?: string;
}

// Test statistics from the database
export interface TestStatistics {
  name: string;
  part: string | null;
  max_score: number;
  total_attempts: number;
  passing_count: number;
  failing_count: number;
  zero_score_count: number;
  partial_score_count: number;
  pass_rate: number;
  avg_score: number;
  median_score: number;
  score_distribution: Record<string, number>;
}

// Overall assignment statistics
export interface AssignmentTestStatistics {
  assignment_id: number;
  total_active_submissions: number;
  submissions_with_results: number;
  tests: TestStatistics[];
  overall_score_distribution: Record<string, number>;
}

// Common error group from deduplication
export interface CommonErrorGroup {
  normalized_output: string;
  test_name: string;
  test_part: string | null;
  occurrence_count: number;
  affected_submission_ids: number[];
  sample_outputs: string[];
  avg_score: number;
  is_failing: boolean;
  error_signature: string;
}

// Response from get_common_test_errors_for_assignment
export interface CommonErrorsResponse {
  assignment_id: number;
  filter: {
    test_name: string | null;
    test_part: string | null;
    min_occurrences: number;
  };
  common_errors: CommonErrorGroup[];
  total_error_groups: number;
}

// Submissions to full marks statistics
export interface SubmissionsToFullMarksTest {
  test_name: string;
  test_part: string | null;
  students_with_full_marks: number;
  students_without_full_marks: number;
  avg_submissions_to_full_marks: number | null;
  median_submissions_to_full_marks: number | null;
  max_submissions_to_full_marks: number | null;
  distribution: Record<string, number>;
}

export interface SubmissionsToFullMarksResponse {
  assignment_id: number;
  per_test: SubmissionsToFullMarksTest[];
  overall: {
    students_with_full_marks: number;
    students_without_full_marks: number;
    avg_submissions_to_full_marks: number | null;
    median_submissions_to_full_marks: number | null;
  };
}

// Matching error pin for a specific error
export interface MatchingErrorPin {
  error_pin_id: number;
  discussion_thread_id: number;
  enabled: boolean;
  rule_logic: "and" | "or";
  thread_subject: string;
  match_count: number;
}

export interface ErrorPinsForPatternResponse {
  matching_pins: MatchingErrorPin[];
}

// Filter state for the error explorer
export interface ErrorExplorerFilters {
  testName: string | null;
  testPart: string | null;
  minOccurrences: number;
  searchTerm: string;
  sortBy: "occurrence_count" | "avg_score" | "test_name";
  sortDirection: "asc" | "desc";
}

// Score distribution bucket labels
export const SCORE_BUCKETS = [
  "100",
  "90-99",
  "80-89",
  "70-79",
  "60-69",
  "50-59",
  "1-49",
  "0"
] as const;

export type ScoreBucket = (typeof SCORE_BUCKETS)[number];

// Color scheme for score buckets
export const SCORE_BUCKET_COLORS: Record<ScoreBucket | "no_max", string> = {
  "100": "#22c55e", // green
  "90-99": "#84cc16", // lime
  "80-89": "#eab308", // yellow
  "70-79": "#f97316", // orange
  "60-69": "#ef4444", // red
  "50-59": "#dc2626", // dark red
  "1-49": "#991b1b", // darker red
  "0": "#7f1d1d", // darkest red
  no_max: "#6b7280" // gray
};

// Difficulty classification based on pass rate
export type DifficultyLevel = "easy" | "medium" | "hard" | "very_hard";

export function getDifficultyLevel(passRate: number): DifficultyLevel {
  if (passRate >= 80) return "easy";
  if (passRate >= 60) return "medium";
  if (passRate >= 40) return "hard";
  return "very_hard";
}

export const DIFFICULTY_COLORS: Record<DifficultyLevel, string> = {
  easy: "#22c55e", // green
  medium: "#eab308", // yellow
  hard: "#f97316", // orange
  very_hard: "#ef4444" // red
};

export const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
  very_hard: "Very Hard"
};
