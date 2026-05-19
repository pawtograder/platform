import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
  YmlRubricChecksType,
  YmlRubricCriteriaType,
  YmlRubricPartType,
  YmlRubricType
} from "@/utils/supabase/DatabaseTypes";
import { valOrNull } from "@/lib/rubric/nullish";
import { rubricCheckDataOrThrow } from "@/lib/rubric/validate";

export function YamlChecksToHydratedChecks(checks: YmlRubricChecksType[]): HydratedRubricCheck[] {
  if (!checks || checks.length === 0) {
    throw new Error("Criteria must have at least one check");
  }
  return checks.map((check, index) => ({
    id: check.id || -1,
    name: check.name,
    kpi_category: valOrNull(check.kpi_category),
    description: valOrNull(check.description),
    ordinal: index,
    rubric_id: 0,
    assignment_id: 0,
    class_id: 0,
    created_at: "",
    data: rubricCheckDataOrThrow(check) ?? null,
    rubric_criteria_id: 0,
    file: valOrNull(check.file),
    artifact: valOrNull(check.artifact),
    group: valOrNull(null),
    is_annotation: check.is_annotation,
    is_comment_required: check.is_comment_required,
    max_annotations: valOrNull(check.max_annotations),
    points: check.points,
    is_required: check.is_required,
    annotation_target: valOrNull(check.annotation_target),
    student_visibility: check.student_visibility || "always",
    // Carry parsed YAML references through. Resolution (target-check-id lookup) is
    // out of band and happens at save time when other rubrics are available.
    yaml_references: check.references && check.references.length > 0 ? check.references : undefined
  }));
}

export function YamlCriteriaToHydratedCriteria(
  part_id: number,
  criteria: YmlRubricCriteriaType[]
): HydratedRubricCriteria[] {
  return criteria.map((criteria, index) => ({
    id: criteria.id || -1,
    name: criteria.name,
    description: valOrNull(criteria.description),
    is_deduction_only: criteria.is_deduction_only || false,
    ordinal: index,
    rubric_id: 0,
    assignment_id: 0,
    class_id: 0,
    created_at: "",
    data: criteria.data,
    rubric_part_id: part_id,
    is_additive: criteria.is_additive || false,
    total_points: criteria.total_points || 0,
    max_checks_per_submission: valOrNull(criteria.max_checks_per_submission),
    min_checks_per_submission: valOrNull(criteria.min_checks_per_submission),
    rubric_checks: YamlChecksToHydratedChecks(criteria.checks)
  }));
}

export function YamlPartsToHydratedParts(parts: YmlRubricPartType[]): HydratedRubricPart[] {
  const partsWithIds = parts.filter((part) => part.id);
  const partIds = new Set(partsWithIds.map((part) => part.id));
  if (partIds.size !== partsWithIds.length) {
    throw new Error(
      "Duplicate part ids in YAML. If you intend to copy a part, simply remove the ID on the copy, and a new ID will be generated for the new part upon saving."
    );
  }
  const criteriaWithIds = parts.flatMap((part) => part.criteria.filter((criteria) => criteria.id));
  const criteriaIds = new Set(criteriaWithIds.map((criteria) => criteria.id));
  if (criteriaIds.size !== criteriaWithIds.length) {
    throw new Error(
      "Duplicate criteria ids in YAML. If you intend to copy a criteria, simply remove the ID on the copy, and a new ID will be generated for the new criteria upon saving."
    );
  }
  const checksWithIds = parts.flatMap((part) =>
    part.criteria.flatMap((criteria) => criteria.checks.filter((check) => check.id))
  );
  const checkIds = new Set(checksWithIds.map((check) => check.id));
  if (checkIds.size !== checksWithIds.length) {
    throw new Error(
      "Duplicate check ids in YAML. If you intend to copy a check, simply remove the ID on the copy, and a new ID will be generated for the new check upon saving."
    );
  }
  for (const part of parts) {
    if (part.is_individual_grading && part.is_assign_to_student) {
      throw new Error(
        `Part "${part.name}" cannot have both is_individual_grading and is_assign_to_student enabled. Choose one mode.`
      );
    }
  }
  return parts.map((part, index) => ({
    id: part.id || -1,
    name: part.name,
    description: valOrNull(part.description),
    ordinal: index,
    rubric_id: 0,
    class_id: 0,
    created_at: "",
    data: part.data,
    assignment_id: 0,
    is_individual_grading: part.is_individual_grading ?? false,
    is_assign_to_student: part.is_assign_to_student ?? false,
    rubric_criteria: YamlCriteriaToHydratedCriteria(part.id || -1, part.criteria)
  }));
}

export function YamlRubricToHydratedRubric(
  yaml: YmlRubricType,
  {
    assignment_id,
    is_private,
    review_round
  }: {
    assignment_id: number;
    is_private: boolean;
    review_round: NonNullable<HydratedRubric["review_round"]>;
  }
): HydratedRubric {
  return {
    id: 0,
    class_id: 0,
    created_at: "",
    name: yaml.name,
    assignment_id,
    description: valOrNull(yaml.description),
    rubric_parts: YamlPartsToHydratedParts(yaml.parts),
    is_private,
    review_round,
    cap_score_to_assignment_points: yaml.cap_score_to_assignment_points ?? false
  };
}
