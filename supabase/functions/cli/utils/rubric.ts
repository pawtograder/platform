/**
 * Rubric utilities: fetch with hierarchy, copy rubric tree.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import type { RubricWithHierarchy } from "../types.ts";
import { CLICommandError } from "../errors.ts";

type RubricChildTable = "rubric_check_references" | "rubric_checks" | "rubric_criteria" | "rubric_parts";

/**
 * Ensures a `delete().eq("rubric_id", rubricId)` on rubric child tables succeeded.
 * Use before recreating parts/criteria/checks when replacing an existing rubric tree.
 */
export function requireRubricTableDeleteOk(
  table: RubricChildTable,
  rubricId: number,
  result: { error: { message: string; code?: string; details?: string; hint?: string } | null; status: number }
): void {
  const { error, status } = result;
  if (error) {
    const e = error;
    const detail =
      [e.code && `code=${e.code}`, e.details && `details=${e.details}`, e.hint && `hint=${e.hint}`]
        .filter(Boolean)
        .join("; ") || undefined;
    throw new CLICommandError(
      `Failed to delete from ${table} (rubric_id=${rubricId}): ${e.message}${detail ? ` (${detail})` : ""}`
    );
  }
  if (status < 200 || status >= 300) {
    throw new CLICommandError(
      `Failed to delete from ${table} (rubric_id=${rubricId}): unexpected HTTP status ${status}`
    );
  }
}

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
    requireRubricTableDeleteOk(
      "rubric_check_references",
      existingRubricId,
      await supabase.from("rubric_check_references").delete().eq("rubric_id", existingRubricId)
    );
    requireRubricTableDeleteOk(
      "rubric_checks",
      existingRubricId,
      await supabase.from("rubric_checks").delete().eq("rubric_id", existingRubricId)
    );
    requireRubricTableDeleteOk(
      "rubric_criteria",
      existingRubricId,
      await supabase.from("rubric_criteria").delete().eq("rubric_id", existingRubricId)
    );
    requireRubricTableDeleteOk(
      "rubric_parts",
      existingRubricId,
      await supabase.from("rubric_parts").delete().eq("rubric_id", existingRubricId)
    );

    const {
      data: updatedRubricRows,
      error: existingRubricUpdateError,
      status: existingRubricUpdateStatus
    } = await supabase
      .from("rubrics")
      .update({
        name: sourceRubric.name,
        description: sourceRubric.description,
        cap_score_to_assignment_points: sourceRubric.cap_score_to_assignment_points,
        is_private: sourceRubric.is_private,
        review_round: sourceRubric.review_round
      })
      .eq("id", existingRubricId)
      .select("id");

    if (existingRubricUpdateError) {
      const e = existingRubricUpdateError;
      const detail =
        [e.code && `code=${e.code}`, e.details && `details=${e.details}`, e.hint && `hint=${e.hint}`]
          .filter(Boolean)
          .join("; ") || undefined;
      throw new CLICommandError(
        `Failed to update existing rubric when copying tree (source_rubric_id=${sourceRubricId}, existing_rubric_id=${existingRubricId}): ${e.message}${detail ? ` (${detail})` : ""}`
      );
    }
    if (existingRubricUpdateStatus < 200 || existingRubricUpdateStatus >= 300) {
      throw new CLICommandError(
        `Failed to update existing rubric when copying tree (source_rubric_id=${sourceRubricId}, existing_rubric_id=${existingRubricId}): unexpected HTTP status ${existingRubricUpdateStatus}`
      );
    }
    if (!updatedRubricRows?.length) {
      throw new CLICommandError(
        `Failed to update existing rubric when copying tree (source_rubric_id=${sourceRubricId}, existing_rubric_id=${existingRubricId}): update matched no rows`
      );
    }

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
    const { data: newPart, error: partInsertError } = await supabase
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

    if (partInsertError || !newPart) {
      const e = partInsertError;
      const detail =
        e &&
        [e.code && `code=${e.code}`, e.details && `details=${e.details}`, e.hint && `hint=${e.hint}`]
          .filter(Boolean)
          .join("; ");
      throw new CLICommandError(
        `Failed to copy rubric part "${part.name}" (source_part_id=${part.id}, source_rubric_id=${sourceRubricId}, target_rubric_id=${targetRubricId}, assignment_id=${newAssignmentId}, class_id=${targetClassId}): ${e?.message ?? "no row returned"}${detail ? ` (${detail})` : ""}`
      );
    }

    for (const criteria of part.rubric_criteria ?? []) {
      const { data: newCriteria, error: criteriaInsertError } = await supabase
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

      if (criteriaInsertError || !newCriteria) {
        const e = criteriaInsertError;
        const detail =
          e &&
          [e.code && `code=${e.code}`, e.details && `details=${e.details}`, e.hint && `hint=${e.hint}`]
            .filter(Boolean)
            .join("; ");
        throw new CLICommandError(
          `Failed to copy rubric criteria "${criteria.name}" (source_criteria_id=${criteria.id}, source_part_id=${part.id}, target_part_id=${newPart.id}, source_rubric_id=${sourceRubricId}, target_rubric_id=${targetRubricId}, assignment_id=${newAssignmentId}, class_id=${targetClassId}): ${e?.message ?? "no row returned"}${detail ? ` (${detail})` : ""}`
        );
      }

      for (const check of criteria.rubric_checks ?? []) {
        const { data: newCheck, error: checkInsertError } = await supabase
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

        if (checkInsertError || !newCheck) {
          const e = checkInsertError;
          const detail =
            e &&
            [e.code && `code=${e.code}`, e.details && `details=${e.details}`, e.hint && `hint=${e.hint}`]
              .filter(Boolean)
              .join("; ");
          throw new CLICommandError(
            `Failed to copy rubric check "${check.name}" (source_check_id=${check.id}, source_criteria_id=${criteria.id}, target_criteria_id=${newCriteria.id}, source_rubric_id=${sourceRubricId}, target_rubric_id=${targetRubricId}, assignment_id=${newAssignmentId}, class_id=${targetClassId}): ${e?.message ?? "no row returned"}${detail ? ` (${detail})` : ""}`
          );
        }
        checkIdMap.set(check.id, newCheck.id);
      }
    }
  }

  const { data: checkReferences, error: checkReferencesError } = await supabase
    .from("rubric_check_references")
    .select("*")
    .eq("rubric_id", sourceRubricId);

  if (checkReferencesError) {
    const e = checkReferencesError;
    const detail =
      [e.code && `code=${e.code}`, e.details && `details=${e.details}`, e.hint && `hint=${e.hint}`]
        .filter(Boolean)
        .join("; ") || undefined;
    throw new CLICommandError(
      `Failed to load rubric_check_references for source rubric ${sourceRubricId}: ${e.message}${detail ? ` (${detail})` : ""}`
    );
  }

  const refRows = checkReferences ?? [];
  for (const ref of refRows) {
    const newReferencedId = checkIdMap.get(ref.referenced_rubric_check_id);
    const newReferencingId = checkIdMap.get(ref.referencing_rubric_check_id);

    if (!newReferencedId || !newReferencingId) {
      throw new CLICommandError(
        `Failed to copy rubric_check_references: could not map source check ids ` +
          `(referenced=${ref.referenced_rubric_check_id}, referencing=${ref.referencing_rubric_check_id}) ` +
          `for source_rubric_id=${sourceRubricId}, target_rubric_id=${targetRubricId}, assignment_id=${newAssignmentId}`
      );
    }

    const { error: refInsertError, status: refInsertStatus } = await supabase.from("rubric_check_references").insert({
      assignment_id: newAssignmentId,
      class_id: targetClassId,
      rubric_id: targetRubricId,
      referenced_rubric_check_id: newReferencedId,
      referencing_rubric_check_id: newReferencingId
    });

    if (refInsertError) {
      const e = refInsertError;
      const detail =
        [e.code && `code=${e.code}`, e.details && `details=${e.details}`, e.hint && `hint=${e.hint}`]
          .filter(Boolean)
          .join("; ") || undefined;
      throw new CLICommandError(
        `Failed to insert rubric_check_references row (source_rubric_id=${sourceRubricId}, target_rubric_id=${targetRubricId}, ` +
          `referenced_check_id=${newReferencedId}, referencing_check_id=${newReferencingId}): ${e.message}${detail ? ` (${detail})` : ""}`
      );
    }
    if (refInsertStatus < 200 || refInsertStatus >= 300) {
      throw new CLICommandError(
        `Failed to insert rubric_check_references row (source_rubric_id=${sourceRubricId}, target_rubric_id=${targetRubricId}): ` +
          `unexpected HTTP status ${refInsertStatus}`
      );
    }
  }

  return targetRubricId;
}
