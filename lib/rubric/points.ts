import { HydratedRubric, HydratedRubricCheck, HydratedRubricCriteria } from "@/utils/supabase/DatabaseTypes";

type CriterionScoreShape = Pick<HydratedRubricCriteria, "is_additive" | "is_deduction_only" | "total_points"> & {
  rubric_checks: Pick<HydratedRubricCheck, "points">[];
};

/**
 * Max points a single criterion can contribute to a student's grade. Mirrors the
 * scoring branches in `_submission_review_recompute_scores` (see
 * `20260322130000_submission_review_recompute_shared_and_bulk.sql`):
 *
 * - deduction-only: best case is 0 (no deductions applied; floor is -total_points)
 * - additive: best case is `min(sum of check points, total_points)`
 * - non-additive: best case is `total_points`
 */
export function maxPointsForCriterion(criteria: CriterionScoreShape): number {
  const totalPoints = criteria.total_points ?? 0;
  if (criteria.is_deduction_only) return 0;
  if (criteria.is_additive) {
    const sumCheckPoints = (criteria.rubric_checks ?? []).reduce((acc, check) => acc + (check.points ?? 0), 0);
    return Math.min(sumCheckPoints, totalPoints);
  }
  return totalPoints;
}

export type AssignToStudentPartSummary = {
  partId: number;
  name: string;
  /** Sum of criteria maxes within this part. */
  max: number;
};

export type RubricPointsBreakdown = {
  /**
   * Per-student best-case max:
   *   standard parts + is_individual_grading parts + max(is_assign_to_student parts).
   *
   * `is_assign_to_student` parts collapse to the largest part total because we
   * assume each student is assigned at most one of them. `is_individual_grading`
   * parts are summed once: each student earns the part max independently.
   */
  total: number;
  /** Sum of parts with neither `is_individual_grading` nor `is_assign_to_student`. */
  standard: number;
  /** Sum of `is_individual_grading` parts. Each student earns this independently. */
  individual: number;
  /** Per-student contribution from `is_assign_to_student` parts: the max of all such parts. */
  assignToStudentPerStudent: number;
  /** Sum across every `is_assign_to_student` part — the pool of points distributed across the group. */
  assignToStudentTotal: number;
  /** Per-part totals for `is_assign_to_student` parts, in rubric order. */
  assignToStudentParts: AssignToStudentPartSummary[];
  /**
   * True when there are 2+ `is_assign_to_student` parts whose per-part totals
   * differ — students will end up with different maxes depending on which they
   * receive. Authors should rebalance.
   */
  assignToStudentUnbalanced: boolean;
};

/** Detailed breakdown so the UI can call out split-grading pools, unbalanced parts, etc. */
export function computeRubricPointsBreakdown(rubric: Pick<HydratedRubric, "rubric_parts">): RubricPointsBreakdown {
  let standard = 0;
  let individual = 0;
  const assignParts: AssignToStudentPartSummary[] = [];

  for (const part of rubric.rubric_parts ?? []) {
    let partMax = 0;
    for (const criteria of part.rubric_criteria ?? []) {
      partMax += maxPointsForCriterion(criteria);
    }
    if (part.is_assign_to_student) {
      assignParts.push({ partId: part.id, name: part.name ?? "(unnamed part)", max: partMax });
    } else if (part.is_individual_grading) {
      individual += partMax;
    } else {
      standard += partMax;
    }
  }

  const assignToStudentPerStudent = assignParts.length === 0 ? 0 : Math.max(...assignParts.map((p) => p.max));
  const assignToStudentTotal = assignParts.reduce((acc, p) => acc + p.max, 0);
  const assignToStudentUnbalanced = assignParts.length > 1 && new Set(assignParts.map((p) => p.max)).size > 1;

  return {
    total: standard + individual + assignToStudentPerStudent,
    standard,
    individual,
    assignToStudentPerStudent,
    assignToStudentTotal,
    assignToStudentParts: assignParts,
    assignToStudentUnbalanced
  };
}

/** Convenience: just the per-student best-case total. */
export function computeRubricMaxPoints(rubric: Pick<HydratedRubric, "rubric_parts">): number {
  return computeRubricPointsBreakdown(rubric).total;
}

/** True when any part uses a per-student grading mode. */
export function hasSplitGradingParts(rubric: Pick<HydratedRubric, "rubric_parts">): boolean {
  return (rubric.rubric_parts ?? []).some((p) => p.is_individual_grading || p.is_assign_to_student);
}
