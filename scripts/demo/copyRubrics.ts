/* eslint-disable no-console */
/**
 * Node port of the deno copyRubricStructure / copyRubricCheckReferencesForAssignment
 * helpers from supabase/functions/cli/utils/rubric.ts. We keep this separate so the
 * Node-side demo seeder doesn't have to import deno modules. Keep the two in sync
 * when the rubric schema changes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type Sb = SupabaseClient<Database>;

interface RubricCheckRow {
  id: number;
  name: string;
  description: string | null;
  ordinal: number;
  points: number;
  is_annotation: boolean;
  is_comment_required: boolean;
  is_required: boolean;
  annotation_target: string | null;
  artifact: string | null;
  file: string | null;
  group: string | null;
  max_annotations: number | null;
  student_visibility: Database["public"]["Enums"]["rubric_check_student_visibility"];
  data: unknown;
}

interface RubricCriteriaRow {
  id: number;
  name: string;
  description: string | null;
  ordinal: number;
  total_points: number;
  is_additive: boolean;
  is_deduction_only: boolean;
  min_checks_per_submission: number | null;
  max_checks_per_submission: number | null;
  data: unknown;
  rubric_checks: RubricCheckRow[];
}

interface RubricPartRow {
  id: number;
  name: string;
  description: string | null;
  ordinal: number;
  data: unknown;
  // Grading-mode flags must be carried over or "assign to student" /
  // "individual grading" parts silently downgrade to regular grading in the copy.
  is_individual_grading: boolean;
  is_assign_to_student: boolean;
  rubric_criteria: RubricCriteriaRow[];
}

interface RubricHierarchy {
  id: number;
  name: string;
  description: string | null;
  cap_score_to_assignment_points: boolean;
  is_private: boolean;
  review_round: Database["public"]["Enums"]["review_round"] | null;
  rubric_parts: RubricPartRow[];
}

async function fetchHierarchy(supabase: Sb, rubricId: number): Promise<RubricHierarchy | null> {
  const { data, error } = await supabase
    .from("rubrics")
    .select(`*, rubric_parts (*, rubric_criteria (*, rubric_checks (*)))`)
    .eq("id", rubricId)
    .single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw new Error(`Failed to fetch rubric ${rubricId}: ${error.message}`);
  }
  return data as unknown as RubricHierarchy;
}

async function copyOneRubric(
  supabase: Sb,
  sourceRubricId: number,
  newAssignmentId: number,
  targetClassId: number,
  sharedCheckIdMap: Map<number, number>,
  existingRubricId?: number
): Promise<number> {
  const src = await fetchHierarchy(supabase, sourceRubricId);
  if (!src) throw new Error(`Source rubric ${sourceRubricId} not found`);

  let targetRubricId: number;

  if (existingRubricId) {
    // Wipe the empty rubric the assignment-insert trigger created so we can repopulate it.
    for (const tbl of ["rubric_check_references", "rubric_checks", "rubric_criteria", "rubric_parts"] as const) {
      const { error } = await supabase.from(tbl).delete().eq("rubric_id", existingRubricId);
      if (error) throw new Error(`Failed to wipe ${tbl} for rubric ${existingRubricId}: ${error.message}`);
    }
    const { error: upErr } = await supabase
      .from("rubrics")
      .update({
        name: src.name,
        description: src.description,
        cap_score_to_assignment_points: src.cap_score_to_assignment_points,
        is_private: src.is_private,
        review_round: src.review_round
      })
      .eq("id", existingRubricId);
    if (upErr) throw new Error(`Failed to update rubric ${existingRubricId}: ${upErr.message}`);
    targetRubricId = existingRubricId;
  } else {
    const { data: newRubric, error } = await supabase
      .from("rubrics")
      .insert({
        assignment_id: newAssignmentId,
        class_id: targetClassId,
        name: src.name,
        description: src.description,
        cap_score_to_assignment_points: src.cap_score_to_assignment_points,
        is_private: src.is_private,
        review_round: src.review_round
      })
      .select("id")
      .single();
    if (error || !newRubric) throw new Error(`Failed to create rubric: ${error?.message ?? "unknown"}`);
    targetRubricId = newRubric.id;
  }

  for (const part of src.rubric_parts ?? []) {
    const { data: newPart, error: partErr } = await supabase
      .from("rubric_parts")
      .insert({
        assignment_id: newAssignmentId,
        class_id: targetClassId,
        rubric_id: targetRubricId,
        name: part.name,
        description: part.description,
        ordinal: part.ordinal,
        data: part.data as never,
        is_individual_grading: part.is_individual_grading,
        is_assign_to_student: part.is_assign_to_student
      })
      .select("id")
      .single();
    if (partErr || !newPart) throw new Error(`Failed to copy rubric part "${part.name}": ${partErr?.message}`);

    for (const criteria of part.rubric_criteria ?? []) {
      const { data: newCrit, error: critErr } = await supabase
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
          data: criteria.data as never
        })
        .select("id")
        .single();
      if (critErr || !newCrit) throw new Error(`Failed to copy criteria "${criteria.name}": ${critErr?.message}`);

      for (const check of criteria.rubric_checks ?? []) {
        const { data: newCheck, error: checkErr } = await supabase
          .from("rubric_checks")
          .insert({
            assignment_id: newAssignmentId,
            class_id: targetClassId,
            rubric_id: targetRubricId,
            rubric_criteria_id: newCrit.id,
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
            data: check.data as never
          })
          .select("id")
          .single();
        if (checkErr || !newCheck) throw new Error(`Failed to copy check "${check.name}": ${checkErr?.message}`);
        sharedCheckIdMap.set(check.id, newCheck.id);
      }
    }
  }

  return targetRubricId;
}

async function copyCheckReferences(
  supabase: Sb,
  rubricIdPairs: Array<{ sourceRubricId: number; targetRubricId: number }>,
  newAssignmentId: number,
  targetClassId: number,
  sharedCheckIdMap: Map<number, number>
): Promise<void> {
  if (rubricIdPairs.length === 0) return;
  const sourceRubricIds = rubricIdPairs.map((p) => p.sourceRubricId);
  const sourceToTarget = new Map<number, number>();
  for (const p of rubricIdPairs) sourceToTarget.set(p.sourceRubricId, p.targetRubricId);

  const { data: refs, error } = await supabase
    .from("rubric_check_references")
    .select("*")
    .in("rubric_id", sourceRubricIds);
  if (error) throw new Error(`Failed to load rubric_check_references: ${error.message}`);

  for (const ref of refs ?? []) {
    const targetRubricId = sourceToTarget.get(ref.rubric_id);
    const newReferenced = sharedCheckIdMap.get(ref.referenced_rubric_check_id);
    const newReferencing = sharedCheckIdMap.get(ref.referencing_rubric_check_id);
    if (!targetRubricId || !newReferenced || !newReferencing) {
      // Skip references that can't be resolved (e.g. cross-rubric ref to a rubric we
      // didn't copy). The deno version errors; for demo provisioning a skip is fine.
      console.warn(`[copyRubrics] Skipping unresolved rubric_check_reference (rubric_id=${ref.rubric_id})`);
      continue;
    }
    const { error: insErr } = await supabase.from("rubric_check_references").insert({
      assignment_id: newAssignmentId,
      class_id: targetClassId,
      rubric_id: targetRubricId,
      referenced_rubric_check_id: newReferenced,
      referencing_rubric_check_id: newReferencing
    });
    if (insErr) throw new Error(`Failed to insert rubric_check_reference: ${insErr.message}`);
  }
}

export interface TargetAssignmentRubricRefs {
  id: number;
  class_id: number;
  grading_rubric_id: number | null;
  self_review_rubric_id: number | null;
  meta_grading_rubric_id: number | null;
}

/**
 * Copy every rubric (grading + self_review + meta_grading) from a source assignment
 * onto a freshly-created target assignment. When the target has an empty rubric of
 * the matching kind (the usual case — assignment-insert triggers create empty rubrics
 * and stamp their ids onto the assignment row), we reuse that rubric id and replace
 * its children. When the target has no matching rubric id, we insert a new rubric
 * row but do not stitch it back onto the assignment — that's a current limitation; in
 * practice the trigger creates all three kinds, so this branch rarely fires.
 */
export async function copyAllRubricsForAssignment(
  supabase: Sb,
  sourceClassId: number,
  sourceAssignmentId: number,
  target: TargetAssignmentRubricRefs
): Promise<void> {
  const { data: src, error } = await supabase
    .from("assignments")
    .select("grading_rubric_id, self_review_rubric_id, meta_grading_rubric_id")
    .eq("id", sourceAssignmentId)
    .eq("class_id", sourceClassId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load source assignment ${sourceAssignmentId}: ${error.message}`);
  if (!src) throw new Error(`Source assignment ${sourceAssignmentId} not found in class ${sourceClassId}`);

  const sharedCheckIdMap = new Map<number, number>();
  const rubricIdPairs: Array<{ sourceRubricId: number; targetRubricId: number }> = [];

  const kinds: Array<{ source: number | null; target: number | null; label: string }> = [
    { source: src.grading_rubric_id, target: target.grading_rubric_id, label: "grading" },
    { source: src.self_review_rubric_id, target: target.self_review_rubric_id, label: "self_review" },
    { source: src.meta_grading_rubric_id, target: target.meta_grading_rubric_id, label: "meta_grading" }
  ];

  for (const k of kinds) {
    if (!k.source) continue;
    const targetRubricId = await copyOneRubric(
      supabase,
      k.source,
      target.id,
      target.class_id,
      sharedCheckIdMap,
      k.target ?? undefined
    );
    rubricIdPairs.push({ sourceRubricId: k.source, targetRubricId });
  }

  await copyCheckReferences(supabase, rubricIdPairs, target.id, target.class_id, sharedCheckIdMap);
}
