/** Mirrors Edge `repos.*.context` payloads (keep in sync with supabase/functions/cli/types.ts). */

export interface ReposListRepositoryRow {
  id: number;
  repository: string;
  profile_id: string | null;
  assignment_group_id: number | null;
}

export interface SyncGradeWorkflowContext {
  assignment_id: number;
  class_id: number;
  assignment_title: string;
  template_repo: string;
  grade_yml_base64: string;
  grade_yml_blob_sha: string | null;
  repositories: ReposListRepositoryRow[];
}

export interface CrossAssignmentCopyPair {
  source_repository: string;
  target_repository: string;
  profile_id: string;
  assignment_group_id: number | null;
  eligible_for_copy: boolean;
  final_due_iso: string;
}

export interface CrossAssignmentCopyContext {
  source_assignment_id: number;
  target_assignment_id: number;
  class_id: number;
  source_assignment_title: string;
  target_assignment_title: string;
  pairs: CrossAssignmentCopyPair[];
  errors: { source_repository: string; reason: string }[];
}
