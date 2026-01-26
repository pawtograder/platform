/**
 * Shared types for the Pawtograder CLI
 */

import { Database } from "@/utils/supabase/SupabaseTypes";

// Database row types
export type Class = Database["public"]["Tables"]["classes"]["Row"];
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];
export type Autograder = Database["public"]["Tables"]["autograder"]["Row"];
export type Rubric = Database["public"]["Tables"]["rubrics"]["Row"];
export type RubricPart = Database["public"]["Tables"]["rubric_parts"]["Row"];
export type RubricCriteria = Database["public"]["Tables"]["rubric_criteria"]["Row"];
export type RubricCheck = Database["public"]["Tables"]["rubric_checks"]["Row"];
export type SelfReviewSettings = Database["public"]["Tables"]["assignment_self_review_settings"]["Row"];

// Extended types with relations
export interface ClassWithOrg extends Class {
  github_org: string | null;
}

export interface AssignmentWithAutograder extends Assignment {
  autograder: Autograder | null;
}

export interface RubricWithHierarchy extends Rubric {
  rubric_parts: RubricPartWithCriteria[];
}

export interface RubricPartWithCriteria extends RubricPart {
  rubric_criteria: RubricCriteriaWithChecks[];
}

export interface RubricCriteriaWithChecks extends RubricCriteria {
  rubric_checks: RubricCheck[];
}

// Copy operation types
export interface AssignmentCopySpec {
  sourceAssignment: Assignment;
  releaseDateOverride?: string;
  dueDateOverride?: string;
  latestDueDateOverride?: string;
}

export interface CopyResult {
  success: boolean;
  sourceAssignmentId: number;
  newAssignmentId?: number;
  error?: string;
}

// CSV row type for copy operations
export interface AssignmentScheduleRow {
  assignment_slug?: string;
  assignment_title?: string;
  release_date?: string;
  due_date?: string;
  latest_due_date?: string;
}
