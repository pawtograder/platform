import type { RubricChecks, RubricCriteria, RubricPart } from "@/utils/supabase/DatabaseTypes";

/** Comment shape needed for completion heuristics (matches file / submission / artifact comments). */
export type RubricGradingComment = {
  rubric_check_id: number | null | undefined;
  target_student_profile_id?: string | null;
};

function partAssignToStudentSkipped(
  partId: number,
  assignments: Record<string, string | null> | null | undefined
): boolean {
  const v = assignments?.[String(partId)];
  return v == null || v === "";
}

function partForCriteria(criteria: RubricCriteria, parts: RubricPart[]): RubricPart | undefined {
  return parts.find((p) => p.id === criteria.rubric_part_id);
}

/** Profile IDs that receive per-student rubric checks (mirrors _grade_targets_for_submission). */
export function gradeTargetsForSubmission(input: {
  assignmentGroupId: number | null | undefined;
  profileId: string | null | undefined;
  groupMemberProfileIds: string[];
}): string[] {
  if (input.assignmentGroupId != null) {
    if (input.groupMemberProfileIds.length > 0) {
      return [...new Set(input.groupMemberProfileIds)];
    }
    return [];
  }
  if (input.profileId) {
    return [input.profileId];
  }
  return [];
}

function checkHasCommentForMode(
  checkId: number,
  comments: RubricGradingComment[],
  part: RubricPart | undefined,
  targets: string[],
  assignments: Record<string, string | null> | null | undefined
): boolean {
  if (!part) {
    return comments.some((c) => c.rubric_check_id === checkId);
  }
  if (part.is_assign_to_student) {
    if (partAssignToStudentSkipped(part.id, assignments)) {
      return true;
    }
    return comments.some((c) => c.rubric_check_id === checkId);
  }
  if (part.is_individual_grading && targets.length > 0) {
    return targets.every((tid) =>
      comments.some((c) => c.rubric_check_id === checkId && c.target_student_profile_id === tid)
    );
  }
  if (part.is_individual_grading) {
    return comments.some((c) => c.rubric_check_id === checkId);
  }
  return comments.some((c) => c.rubric_check_id === checkId);
}

function countDistinctChecksAppliedForCriteria(
  checksForCriteria: RubricChecks[],
  comments: RubricGradingComment[],
  part: RubricPart | undefined,
  targets: string[],
  assignments: Record<string, string | null> | null | undefined
): number {
  if (!part) {
    return checksForCriteria.filter((check) => comments.some((c) => c.rubric_check_id === check.id)).length;
  }
  if (part.is_assign_to_student && partAssignToStudentSkipped(part.id, assignments)) {
    return 0;
  }
  if (part.is_individual_grading && targets.length > 0) {
    return Math.min(
      ...targets.map(
        (tid) =>
          checksForCriteria.filter((check) =>
            comments.some((c) => c.rubric_check_id === check.id && c.target_student_profile_id === tid)
          ).length
      )
    );
  }
  return checksForCriteria.filter((check) => comments.some((c) => c.rubric_check_id === check.id)).length;
}

export type CriteriaEvaluationItem = {
  criteria: RubricCriteria;
  check_count_applied: number;
};

export function computeRubricGradingCompletion(input: {
  rubricChecks: RubricChecks[];
  allCriteria: RubricCriteria[];
  rubricParts: RubricPart[];
  comments: RubricGradingComment[];
  rubricPartStudentAssignments: Record<string, string | null> | null | undefined;
  gradeTargets: string[];
  /**
   * null = entire rubric (e.g. complete submission review).
   * array (possibly empty) = only these rubric part ids (e.g. review assignment); empty means nothing in scope.
   */
  rubricPartIdsInScope: number[] | null;
}): {
  missing_required_checks: RubricChecks[];
  missing_optional_checks: RubricChecks[];
  missing_required_criteria: CriteriaEvaluationItem[];
  missing_optional_criteria: CriteriaEvaluationItem[];
  criteriaEvaluation: CriteriaEvaluationItem[];
} {
  const {
    rubricChecks,
    allCriteria,
    rubricParts,
    comments,
    rubricPartStudentAssignments,
    gradeTargets,
    rubricPartIdsInScope
  } = input;

  const scope: Set<number> | null = rubricPartIdsInScope === null ? null : new Set(rubricPartIdsInScope);

  const checksInScope =
    scope === null
      ? rubricChecks
      : rubricChecks.filter((ch) => {
          const crit = allCriteria.find((c) => c.id === ch.rubric_criteria_id);
          return crit !== undefined && scope.has(crit.rubric_part_id);
        });

  const criteriaInScope = scope === null ? allCriteria : allCriteria.filter((c) => scope.has(c.rubric_part_id));

  const criteriaEvaluation: CriteriaEvaluationItem[] = criteriaInScope.map((criteria) => {
    const checksForCriteria = rubricChecks.filter((check) => check.rubric_criteria_id === criteria.id);
    const part = partForCriteria(criteria, rubricParts);
    const check_count_applied = countDistinctChecksAppliedForCriteria(
      checksForCriteria,
      comments,
      part,
      gradeTargets,
      rubricPartStudentAssignments
    );
    return { criteria, check_count_applied };
  });

  const criteriaSkipped = (criteria: RubricCriteria) => {
    const p = partForCriteria(criteria, rubricParts);
    return !!(p?.is_assign_to_student && partAssignToStudentSkipped(p.id, rubricPartStudentAssignments));
  };

  const saturatedCriteria = criteriaEvaluation.filter((item) => {
    if (criteriaSkipped(item.criteria)) return false;
    const max = item.criteria.max_checks_per_submission;
    if (max == null) return false;
    return item.check_count_applied === max;
  });

  const missing_required_checks = checksInScope.filter((check) => {
    if (!check.is_required) return false;
    const criteria = allCriteria.find((c) => c.id === check.rubric_criteria_id);
    const part = criteria ? partForCriteria(criteria, rubricParts) : undefined;
    return !checkHasCommentForMode(check.id, comments, part, gradeTargets, rubricPartStudentAssignments);
  });

  const missing_optional_checks = checksInScope.filter((check) => {
    if (check.is_required) return false;
    const criteria = allCriteria.find((c) => c.id === check.rubric_criteria_id);
    if (!criteria) return false;
    const part = partForCriteria(criteria, rubricParts);
    if (part?.is_assign_to_student && partAssignToStudentSkipped(part.id, rubricPartStudentAssignments)) {
      return false;
    }
    const applied = checkHasCommentForMode(check.id, comments, part, gradeTargets, rubricPartStudentAssignments);
    if (applied) return false;
    return !saturatedCriteria.some((item) => item.criteria.id === check.rubric_criteria_id);
  });

  const missing_required_criteria = criteriaEvaluation.filter(
    (item) =>
      !criteriaSkipped(item.criteria) &&
      item.criteria.min_checks_per_submission !== null &&
      item.check_count_applied < item.criteria.min_checks_per_submission
  );

  const missing_optional_criteria = criteriaEvaluation.filter(
    (item) =>
      !criteriaSkipped(item.criteria) &&
      item.criteria.min_checks_per_submission === null &&
      item.check_count_applied === 0
  );

  return {
    missing_required_checks,
    missing_optional_checks,
    missing_required_criteria,
    missing_optional_criteria,
    criteriaEvaluation
  };
}
