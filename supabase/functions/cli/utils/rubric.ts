/**
 * Rubric utilities: fetch with hierarchy, copy rubric tree.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import type { RubricWithHierarchy } from "../types.ts";
import { CLICommandError } from "../errors.ts";

export async function fetchRubricWithHierarchy(
  supabase: SupabaseClient<Database>,
  rubricId: number
): Promise<RubricWithHierarchy | null> {
  const { data, error } = await supabase
    .from("rubrics")
    .select(
      `
      *,
      rubric_parts (
        *,
        rubric_criteria (
          *,
          rubric_checks (*)
        )
      )
    `
    )
    .eq("id", rubricId)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw new CLICommandError(`Failed to fetch rubric: ${error.message}`);
  }
  return data as RubricWithHierarchy;
}

export async function copyRubricTree(
  supabase: SupabaseClient<Database>,
  sourceRubricId: number,
  newAssignmentId: number,
  targetClassId: number,
  existingRubricId?: number
): Promise<number> {
  const sourceRubric = await fetchRubricWithHierarchy(supabase, sourceRubricId);
  if (!sourceRubric) throw new CLICommandError(`Rubric not found: ${sourceRubricId}`);

  const checkIdMap = new Map<number, number>();
  let targetRubricId: number;

  if (existingRubricId) {
    await supabase.from("rubric_check_references").delete().eq("rubric_id", existingRubricId);
    await supabase.from("rubric_checks").delete().eq("rubric_id", existingRubricId);
    await supabase.from("rubric_criteria").delete().eq("rubric_id", existingRubricId);
    await supabase.from("rubric_parts").delete().eq("rubric_id", existingRubricId);

    await supabase
      .from("rubrics")
      .update({
        name: sourceRubric.name,
        description: sourceRubric.description,
        cap_score_to_assignment_points: sourceRubric.cap_score_to_assignment_points,
        is_private: sourceRubric.is_private,
        review_round: sourceRubric.review_round
      })
      .eq("id", existingRubricId);

    targetRubricId = existingRubricId;
  } else {
    const { data: newRubric, error } = await supabase
      .from("rubrics")
      .insert({
        assignment_id: newAssignmentId,
        class_id: targetClassId,
        name: sourceRubric.name,
        description: sourceRubric.description,
        cap_score_to_assignment_points: sourceRubric.cap_score_to_assignment_points,
        is_private: sourceRubric.is_private,
        review_round: sourceRubric.review_round
      })
      .select("id")
      .single();

    if (error || !newRubric) {
      throw new CLICommandError(`Failed to create rubric: ${error?.message ?? "Unknown"}`);
    }
    targetRubricId = newRubric.id;
  }

  for (const part of sourceRubric.rubric_parts ?? []) {
    const { data: newPart } = await supabase
      .from("rubric_parts")
      .insert({
        assignment_id: newAssignmentId,
        class_id: targetClassId,
        rubric_id: targetRubricId,
        name: part.name,
        description: part.description,
        ordinal: part.ordinal,
        data: part.data
      })
      .select("id")
      .single();

    if (!newPart) continue;

    for (const criteria of part.rubric_criteria ?? []) {
      const { data: newCriteria } = await supabase
        .from("rubric_criteria")
        .insert({
          assignment_id: newAssignmentId,
          class_id: targetClassId,
          rubric_id: targetRubricId,
          rubric_part_id: newPart.id,
          name: criteria.name,
          description: criteria.description,
          ordinal: criteria.ordinal,
          total_points: criteria.total_points,
          is_additive: criteria.is_additive,
          is_deduction_only: criteria.is_deduction_only,
          min_checks_per_submission: criteria.min_checks_per_submission,
          max_checks_per_submission: criteria.max_checks_per_submission,
          data: criteria.data
        })
        .select("id")
        .single();

      if (!newCriteria) continue;

      for (const check of criteria.rubric_checks ?? []) {
        const { data: newCheck } = await supabase
          .from("rubric_checks")
          .insert({
            assignment_id: newAssignmentId,
            class_id: targetClassId,
            rubric_id: targetRubricId,
            rubric_criteria_id: newCriteria.id,
            name: check.name,
            description: check.description,
            ordinal: check.ordinal,
            points: check.points,
            is_annotation: check.is_annotation,
            is_comment_required: check.is_comment_required,
            is_required: check.is_required,
            annotation_target: check.annotation_target,
            artifact: check.artifact,
            file: check.file,
            group: check.group,
            max_annotations: check.max_annotations,
            student_visibility: check.student_visibility,
            data: check.data
          })
          .select("id")
          .single();

        if (newCheck) {
          checkIdMap.set(check.id, newCheck.id);
        }
      }
    }
  }

  const { data: checkReferences } = await supabase
    .from("rubric_check_references")
    .select("*")
    .eq("rubric_id", sourceRubricId);

  if (checkReferences && checkReferences.length > 0) {
    for (const ref of checkReferences) {
      const newReferencedId = checkIdMap.get(ref.referenced_rubric_check_id);
      const newReferencingId = checkIdMap.get(ref.referencing_rubric_check_id);

      if (newReferencedId && newReferencingId) {
        await supabase.from("rubric_check_references").insert({
          assignment_id: newAssignmentId,
          class_id: targetClassId,
          rubric_id: targetRubricId,
          referenced_rubric_check_id: newReferencedId,
          referencing_rubric_check_id: newReferencingId
        });
      }
    }
  }

  return targetRubricId;
}
