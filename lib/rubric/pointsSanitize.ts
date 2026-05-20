import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  RubricChecksDataType
} from "@/utils/supabase/DatabaseTypes";

export type PointsValidationWarning = {
  path: string;
  message: string;
};

export const NEGATIVE_POINTS_WARNING_MESSAGE =
  "Points cannot be negative; converted to the absolute value. For deductions, set the criterion scoring mode to deduct-from-total or deduction-only instead of using negative points.";

/** Coerce a single numeric points field to a non-negative value. */
export function normalizePointValue(points: number): { points: number; wasNegative: boolean } {
  if (!Number.isFinite(points) || points >= 0) {
    return { points: Number.isFinite(points) ? points : 0, wasNegative: false };
  }
  return { points: Math.abs(points), wasNegative: true };
}

function hasOptionsData(
  data: HydratedRubricCheck["data"]
): data is HydratedRubricCheck["data"] & { options: RubricChecksDataType["options"] } {
  return (
    typeof data === "object" &&
    data !== null &&
    "options" in data &&
    Array.isArray((data as { options?: unknown }).options)
  );
}

function sanitizeCheckPoints(
  check: HydratedRubricCheck,
  pathPrefix: string
): { check: HydratedRubricCheck; warnings: PointsValidationWarning[] } {
  const warnings: PointsValidationWarning[] = [];
  let next = check;

  if (check.points != null && check.points < 0) {
    const { points } = normalizePointValue(check.points);
    warnings.push({ path: `${pathPrefix}.points`, message: NEGATIVE_POINTS_WARNING_MESSAGE });
    next = { ...next, points };
  }

  if (hasOptionsData(check.data)) {
    let optionsChanged = false;
    const options = check.data.options.map((opt, oIdx) => {
      if (opt.points == null || opt.points >= 0) return opt;
      optionsChanged = true;
      const { points } = normalizePointValue(opt.points);
      warnings.push({
        path: `${pathPrefix}.data.options[${oIdx}].points`,
        message: NEGATIVE_POINTS_WARNING_MESSAGE
      });
      return { ...opt, points };
    });
    if (optionsChanged) {
      // hasOptionsData already narrowed check.data to a non-null object, but the
      // generic Json type still permits primitives, so spread it via Object.assign.
      next = { ...next, data: Object.assign({}, check.data, { options }) };
    }
  }

  return { check: next, warnings };
}

/**
 * Replace negative check, option, and criterion total_points values with their absolute values.
 * Returns warnings describing each correction.
 */
export function sanitizeHydratedRubricPoints(rubric: HydratedRubric): {
  rubric: HydratedRubric;
  warnings: PointsValidationWarning[];
} {
  const warnings: PointsValidationWarning[] = [];

  const rubric_parts = rubric.rubric_parts.map((part, pIdx) => ({
    ...part,
    rubric_criteria: part.rubric_criteria.map((criteria, cIdx) => {
      const critPath = `parts[${pIdx}].criteria[${cIdx}]`;
      let crit: HydratedRubricCriteria = criteria;

      if (criteria.total_points != null && criteria.total_points < 0) {
        const { points } = normalizePointValue(criteria.total_points);
        warnings.push({ path: `${critPath}.total_points`, message: NEGATIVE_POINTS_WARNING_MESSAGE });
        crit = { ...crit, total_points: points };
      }

      const rubric_checks = crit.rubric_checks.map((check, chIdx) => {
        const { check: sanitized, warnings: checkWarnings } = sanitizeCheckPoints(
          check,
          `${critPath}.checks[${chIdx}]`
        );
        warnings.push(...checkWarnings);
        return sanitized;
      });

      return { ...crit, rubric_checks };
    })
  }));

  return {
    rubric: { ...rubric, rubric_parts },
    warnings
  };
}
