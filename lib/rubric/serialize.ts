import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
  Json,
  YmlRubricChecksType,
  YmlRubricCriteriaType,
  YmlRubricPartType,
  YmlRubricType
} from "@/utils/supabase/DatabaseTypes";
import { valOrUndefined } from "@/lib/rubric/nullish";

export function hydratedRubricChecksToYamlRubric(checks: HydratedRubricCheck[]): YmlRubricChecksType[] {
  return checks
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((check) => {
      const yamlCheck: Omit<YmlRubricChecksType, "data"> & { data?: Json | null } = {
        id: check.id,
        name: check.name,
        kpi_category: valOrUndefined(check.kpi_category) || null,
        description: valOrUndefined(check.description),
        file: valOrUndefined(check.file),
        is_annotation: check.is_annotation,
        is_required: check.is_required,
        is_comment_required: check.is_comment_required,
        artifact: valOrUndefined(check.artifact),
        max_annotations: valOrUndefined(check.max_annotations),
        points: check.points,
        annotation_target: valOrUndefined(check.annotation_target) as "file" | "artifact" | undefined,
        student_visibility: valOrUndefined(check.student_visibility)
      };
      if (check.data !== null && check.data !== undefined) {
        yamlCheck.data = check.data;
      }
      return yamlCheck as YmlRubricChecksType;
    });
}

export function hydratedRubricCriteriaToYamlRubric(criteria: HydratedRubricCriteria[]): YmlRubricCriteriaType[] {
  criteria.sort((a, b) => a.ordinal - b.ordinal);
  return criteria.map((criteria) => ({
    id: criteria.id,
    data: criteria.data,
    description: valOrUndefined(criteria.description),
    is_additive: criteria.is_additive,
    is_deduction_only: criteria.is_deduction_only,
    name: criteria.name,
    total_points: criteria.total_points,
    max_checks_per_submission: valOrUndefined(criteria.max_checks_per_submission),
    min_checks_per_submission: valOrUndefined(criteria.min_checks_per_submission),
    checks: hydratedRubricChecksToYamlRubric(criteria.rubric_checks)
  }));
}

export function hydratedRubricPartToYamlRubric(parts: HydratedRubricPart[]): YmlRubricPartType[] {
  parts.sort((a, b) => a.ordinal - b.ordinal);
  return parts.map((part) => ({
    id: part.id,
    data: valOrUndefined(part.data),
    description: valOrUndefined(part.description),
    name: part.name,
    is_individual_grading: part.is_individual_grading || undefined,
    is_assign_to_student: part.is_assign_to_student || undefined,
    criteria: hydratedRubricCriteriaToYamlRubric(part.rubric_criteria)
  }));
}

export function HydratedRubricToYamlRubric(rubric: HydratedRubric): YmlRubricType {
  return {
    name: rubric.name,
    description: valOrUndefined(rubric.description),
    parts: hydratedRubricPartToYamlRubric(rubric.rubric_parts),
    cap_score_to_assignment_points: rubric.cap_score_to_assignment_points ?? undefined
  };
}
