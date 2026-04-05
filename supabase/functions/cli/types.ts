/**
 * CLI types - all interfaces and type aliases for the CLI edge function.
 * No `any` types - all derived from Database or explicitly defined.
 */

import type { Database } from "../_shared/SupabaseTypes.d.ts";

// ─── Database row types ─────────────────────────────────────────────────────

export type ClassRow = Database["public"]["Tables"]["classes"]["Row"];
export type AssignmentRow = Database["public"]["Tables"]["assignments"]["Row"];
export type RubricRow = Database["public"]["Tables"]["rubrics"]["Row"];
export type RubricPartRow = Database["public"]["Tables"]["rubric_parts"]["Row"];
export type RubricCriteriaRow = Database["public"]["Tables"]["rubric_criteria"]["Row"];
export type RubricCheckRow = Database["public"]["Tables"]["rubric_checks"]["Row"];
export type FlashcardDeckRow = Database["public"]["Tables"]["flashcard_decks"]["Row"];
export type FlashcardRow = Database["public"]["Tables"]["flashcards"]["Row"];
export type AutograderRow = Database["public"]["Tables"]["autograder"]["Row"];
export type SurveyRow = Database["public"]["Tables"]["surveys"]["Row"];

// ─── Nested rubric hierarchy (from select with relations) ─────────────────────

export interface RubricPartWithCriteria extends RubricPartRow {
  rubric_criteria: (RubricCriteriaRow & {
    rubric_checks: RubricCheckRow[];
  })[];
}

export interface RubricWithHierarchy extends RubricRow {
  rubric_parts: RubricPartWithCriteria[];
}

// ─── Rubric import/export structures ───────────────────────────────────────

export interface RubricExportCheck {
  name: string;
  description: string | null;
  ordinal: number;
  points: number;
  is_annotation: boolean;
  is_comment_required: boolean;
  is_required: boolean;
  annotation_target: string | null;
  artifact: string | null;
  file: string | null;
  group: string | null;
  max_annotations: number | null;
  student_visibility: string;
}

export interface RubricExportCriteria {
  name: string;
  description: string | null;
  ordinal: number;
  total_points: number;
  is_additive: boolean;
  is_deduction_only: boolean;
  min_checks_per_submission: number | null;
  max_checks_per_submission: number | null;
  checks: RubricExportCheck[];
}

export interface RubricExportPart {
  name: string;
  description: string | null;
  ordinal: number;
  criteria: RubricExportCriteria[];
}

export interface RubricImportData {
  name: string;
  description?: string | null;
  cap_score_to_assignment_points?: boolean;
  is_private?: boolean;
  review_round?: string | null;
  parts: RubricImportPart[];
}

export interface RubricImportCheck {
  name: string;
  description?: string | null;
  ordinal?: number;
  points?: number;
  is_annotation?: boolean;
  is_comment_required?: boolean;
  is_required?: boolean;
  annotation_target?: string | null;
  artifact?: string | null;
  file?: string | null;
  group?: string | null;
  max_annotations?: number | null;
  student_visibility?: string;
}

export interface RubricImportCriteria {
  name: string;
  description?: string | null;
  ordinal?: number;
  total_points?: number;
  is_additive?: boolean;
  is_deduction_only?: boolean;
  min_checks_per_submission?: number | null;
  max_checks_per_submission?: number | null;
  checks: RubricImportCheck[];
}

export interface RubricImportPart {
  name: string;
  description?: string | null;
  ordinal?: number;
  criteria: RubricImportCriteria[];
}

// ─── Assignment copy types ──────────────────────────────────────────────────

export interface ScheduleItem {
  assignment_slug?: string;
  assignment_title?: string;
  release_date?: string;
  due_date?: string;
}

export interface CopyStatus {
  assignmentCreated: boolean;
  selfReviewSettingsCopied: boolean;
  rubricsCopied: boolean;
  autograderConfigCopied: boolean;
  handoutRepoCreated: boolean;
  handoutRepoContentsCopied: boolean;
  solutionRepoCreated: boolean;
  solutionRepoContentsCopied: boolean;
  surveysCopied: boolean;
  errors: { step: string; error: string }[];
}

export interface CopyResult {
  assignmentId: number;
  status: CopyStatus;
  wasExisting: boolean;
}

export interface CopySpec {
  assignment: AssignmentRow;
  releaseDateOverride?: string;
  dueDateOverride?: string;
}

// ─── GitHub API types ────────────────────────────────────────────────────────

export interface GitTreeEntry {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
}

// ─── CLI request/response ────────────────────────────────────────────────────

export interface CLIRequest {
  command: string;
  params: Record<string, unknown>;
}

export interface CLIResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Command parameter types ────────────────────────────────────────────────

export interface ClassesShowParams {
  identifier: string;
}

export interface AssignmentsListParams {
  class: string;
}

export interface AssignmentsShowParams {
  class: string;
  identifier: string;
}

export interface AssignmentsDeleteParams {
  class: string;
  identifier: string;
}

export interface AssignmentsCopyParams {
  source_class: string;
  target_class: string;
  assignment?: string;
  all?: boolean;
  schedule?: ScheduleItem[];
  dry_run?: boolean;
  skip_repos?: boolean;
  skip_rubrics?: boolean;
  skip_surveys?: boolean;
  /** When true, log detailed timing to edge function logs (or set CLI_ASSIGNMENTS_COPY_DEBUG) */
  debug?: boolean;
}

export interface SurveysCopyParams {
  source_class: string;
  target_class: string;
  survey?: string;
  all?: boolean;
  /** Target assignment (slug or id) — sets linkage; shifting uses offsets when source is linked */
  target_assignment?: string;
  dry_run?: boolean;
}

export interface RubricsListParams {
  class: string;
  assignment: string;
}

export interface RubricsExportParams {
  class: string;
  assignment: string;
  type?: "grading" | "self_review" | "meta";
}

export interface RubricsImportParams {
  class: string;
  assignment: string;
  type?: "grading" | "self_review" | "meta";
  rubric: RubricImportData;
  dry_run?: boolean;
}

export interface FlashcardsListParams {
  class: string;
}

export interface FlashcardsCopyParams {
  source_class: string;
  target_class: string;
  deck?: string;
  all?: boolean;
  dry_run?: boolean;
}

/** One file-level comment row sent to cli_import_submission_comments_batch */
export interface CliFileCommentRow {
  submission_id: number;
  file_name: string;
  line: number;
  comment: string;
  rubric_check_id?: number | null;
  points?: number | null;
  author: string;
}

export interface CliArtifactCommentRow {
  submission_id: number;
  artifact_name: string;
  comment: string;
  rubric_check_id?: number | null;
  points?: number | null;
  author: string;
}

export interface CliSubmissionCommentRow {
  submission_id: number;
  comment: string;
  rubric_check_id?: number | null;
  points?: number | null;
  author: string;
}

export interface ImportCommentsPayload {
  file_comments: CliFileCommentRow[];
  artifact_comments: CliArtifactCommentRow[];
  submission_comments: CliSubmissionCommentRow[];
  /** Submissions to include in sync delete scope (e.g. all students in batch file). */
  sync_submission_ids: number[];
}

export interface SubmissionsCommentsImportParams {
  class: string;
  assignment: string;
  payload: ImportCommentsPayload;
  mode: "import" | "sync";
  dry_run?: boolean;
}

export interface CliArtifactBlobRow {
  submission_id: number;
  name: string;
  data: { format: string; display: string };
  /** Base64-encoded file bytes */
  content_base64: string;
}

export interface SubmissionsArtifactsImportParams {
  class: string;
  assignment: string;
  artifacts: CliArtifactBlobRow[];
  overwrite?: boolean;
  dry_run?: boolean;
}
