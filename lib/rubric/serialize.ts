import {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart,
  Json,
  YamlReference,
  YmlRubricChecksType,
  YmlRubricCriteriaType,
  YmlRubricPartType,
  YmlRubricType
} from "@/utils/supabase/DatabaseTypes";
import { valOrUndefined } from "@/lib/rubric/nullish";
import { serializeReferences } from "@/lib/rubric/references";

/**
 * Optional context passed through the serialize chain so reference emission can
 * resolve target check ids back to the name-keyed YAML form.
 */
export type SerializeContext = {
  /** All rubrics on the assignment (including the one being serialized). */
  allRubrics: HydratedRubric[];
};

function emitReferencesForCheck(check: HydratedRubricCheck, ctx?: SerializeContext): YamlReference[] | undefined {
  if (!check.references || check.references.length === 0) return undefined;
  // Without context we can't safely emit names; fall back to id-only.
  if (!ctx) {
    return check.references.map((r) => ({ id: r.referenced_rubric_check_id }));
  }
  const refs = serializeReferences(check.references, ctx.allRubrics);
  return refs.length > 0 ? refs : undefined;
}

export function hydratedRubricChecksToYamlRubric(
  checks: HydratedRubricCheck[],
  ctx?: SerializeContext
): YmlRubricChecksType[] {
  return [...checks]
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
      const refs = emitReferencesForCheck(check, ctx);
      if (refs && refs.length > 0) {
        (yamlCheck as YmlRubricChecksType).references = refs;
      }
      return yamlCheck as YmlRubricChecksType;
    });
}

export function hydratedRubricCriteriaToYamlRubric(
  criteria: HydratedRubricCriteria[],
  ctx?: SerializeContext
): YmlRubricCriteriaType[] {
  const sorted = [...criteria].sort((a, b) => a.ordinal - b.ordinal);
  return sorted.map((crit) => ({
    id: crit.id,
    data: crit.data,
    description: valOrUndefined(crit.description),
    is_additive: crit.is_additive,
    is_deduction_only: crit.is_deduction_only,
    name: crit.name,
    total_points: crit.total_points,
    max_checks_per_submission: valOrUndefined(crit.max_checks_per_submission),
    min_checks_per_submission: valOrUndefined(crit.min_checks_per_submission),
    checks: hydratedRubricChecksToYamlRubric(crit.rubric_checks, ctx)
  }));
}

export function hydratedRubricPartToYamlRubric(
  parts: HydratedRubricPart[],
  ctx?: SerializeContext
): YmlRubricPartType[] {
  const sorted = [...parts].sort((a, b) => a.ordinal - b.ordinal);
  return sorted.map((part) => ({
    id: part.id,
    data: valOrUndefined(part.data),
    description: valOrUndefined(part.description),
    name: part.name,
    is_individual_grading: part.is_individual_grading || undefined,
    is_assign_to_student: part.is_assign_to_student || undefined,
    criteria: hydratedRubricCriteriaToYamlRubric(part.rubric_criteria, ctx)
  }));
}

export function HydratedRubricToYamlRubric(rubric: HydratedRubric, ctx?: SerializeContext): YmlRubricType {
  return {
    name: rubric.name,
    description: valOrUndefined(rubric.description),
    parts: hydratedRubricPartToYamlRubric(rubric.rubric_parts, ctx),
    cap_score_to_assignment_points: rubric.cap_score_to_assignment_points ?? undefined,
    hide_unless_assigned: rubric.hide_unless_assigned ?? undefined
  };
}
