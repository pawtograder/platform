/**
 * Rubrics commands - list, export, import.
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass, resolveAssignment } from "../utils/resolvers.ts";
import { fetchRubricWithHierarchy } from "../utils/rubric.ts";
import { CLICommandError } from "../errors.ts";
import type {
  CLIResponse,
  RubricsListParams,
  RubricsExportParams,
  RubricsImportParams,
  RubricWithHierarchy,
  RubricExportPart
} from "../types.ts";

async function handleRubricsList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { class: classIdentifier, assignment: assignmentIdentifier } = params as unknown as RubricsListParams;
  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("assignment is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  const rubricTypes = [
    { type: "grading", id: assignment.grading_rubric_id },
    { type: "self_review", id: assignment.self_review_rubric_id },
    { type: "meta", id: assignment.meta_grading_rubric_id }
  ];

  const rubrics: Array<{ type: string; id: number | null; name: string | null; description: string | null }> = [];
  for (const rubric of rubricTypes) {
    if (rubric.id) {
      const { data } = await supabase.from("rubrics").select("id, name, description").eq("id", rubric.id).single();

      rubrics.push({
        type: rubric.type,
        id: rubric.id,
        name: data?.name ?? null,
        description: data?.description ?? null
      });
    } else {
      rubrics.push({ type: rubric.type, id: null, name: null, description: null });
    }
  }

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      assignment: { id: assignment.id, slug: assignment.slug, title: assignment.title },
      rubrics
    }
  };
}

function buildExportData(rubric: RubricWithHierarchy): {
  name: string;
  description: string | null;
  cap_score_to_assignment_points: boolean;
  is_private: boolean;
  review_round: string | null;
  parts: RubricExportPart[];
} {
  return {
    name: rubric.name,
    description: rubric.description,
    cap_score_to_assignment_points: rubric.cap_score_to_assignment_points,
    is_private: rubric.is_private,
    review_round: rubric.review_round,
    parts: (rubric.rubric_parts ?? []).map((part) => ({
      name: part.name,
      description: part.description,
      ordinal: part.ordinal,
      criteria: (part.rubric_criteria ?? []).map((criteria) => ({
        name: criteria.name,
        description: criteria.description,
        ordinal: criteria.ordinal,
        total_points: criteria.total_points,
        is_additive: criteria.is_additive,
        is_deduction_only: criteria.is_deduction_only,
        min_checks_per_submission: criteria.min_checks_per_submission,
        max_checks_per_submission: criteria.max_checks_per_submission,
        checks: (criteria.rubric_checks ?? []).map((check) => ({
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
          student_visibility: check.student_visibility
        }))
      }))
    }))
  };
}

async function handleRubricsExport(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as RubricsExportParams;
  const classIdentifier = p.class;
  const assignmentIdentifier = p.assignment;
  const rubricType = p.type ?? "grading";

  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("assignment is required");

  const validTypes = ["grading", "self_review", "meta"];
  if (!validTypes.includes(rubricType)) {
    throw new CLICommandError(`Invalid rubric type: ${rubricType}. Must be grading, self_review, or meta`);
  }

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  let rubricId: number | null = null;
  if (rubricType === "grading") rubricId = assignment.grading_rubric_id;
  else if (rubricType === "self_review") rubricId = assignment.self_review_rubric_id;
  else if (rubricType === "meta") rubricId = assignment.meta_grading_rubric_id;

  if (!rubricId) {
    throw new CLICommandError(`No ${rubricType} rubric found for this assignment`);
  }

  const rubric = await fetchRubricWithHierarchy(supabase, rubricId);
  if (!rubric) throw new CLICommandError(`Rubric not found: ${rubricId}`);

  const exportData = buildExportData(rubric);

  return {
    success: true,
    data: {
      rubric_type: rubricType,
      rubric_id: rubricId,
      rubric: exportData
    }
  };
}

async function handleRubricsImport(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as RubricsImportParams;
  const classIdentifier = p.class;
  const assignmentIdentifier = p.assignment;
  const rubricType = p.type ?? "grading";
  const rubricData = p.rubric;
  const dryRun = p.dry_run === true;

  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("assignment is required");
  if (!rubricData) throw new CLICommandError("rubric data is required");
  if (!rubricData.name) throw new CLICommandError("rubric.name is required");
  if (!Array.isArray(rubricData.parts)) throw new CLICommandError("rubric.parts must be an array");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  let targetRubricId: number | null = null;
  if (rubricType === "grading") targetRubricId = assignment.grading_rubric_id;
  else if (rubricType === "self_review") targetRubricId = assignment.self_review_rubric_id;
  else if (rubricType === "meta") targetRubricId = assignment.meta_grading_rubric_id;
  else throw new CLICommandError(`Invalid rubric type: ${rubricType}`);

  if (!targetRubricId) {
    throw new CLICommandError(`No ${rubricType} rubric exists for this assignment. Create the rubric first.`);
  }

  let partCount = rubricData.parts.length;
  let criteriaCount = 0;
  let checkCount = 0;
  for (const part of rubricData.parts) {
    if (!Array.isArray(part.criteria)) {
      throw new CLICommandError(`Part '${part.name}' must have 'criteria' array`);
    }
    criteriaCount += part.criteria.length;
    for (const criteria of part.criteria) {
      if (!Array.isArray(criteria.checks)) {
        throw new CLICommandError(`Criteria '${criteria.name}' must have 'checks' array`);
      }
      checkCount += criteria.checks.length;
    }
  }

  if (dryRun) {
    return {
      success: true,
      data: {
        dry_run: true,
        rubric_type: rubricType,
        target_rubric_id: targetRubricId,
        summary: { parts: partCount, criteria: criteriaCount, checks: checkCount },
        rubric: rubricData
      }
    };
  }

  await supabase.from("rubric_check_references").delete().eq("rubric_id", targetRubricId);
  await supabase.from("rubric_checks").delete().eq("rubric_id", targetRubricId);
  await supabase.from("rubric_criteria").delete().eq("rubric_id", targetRubricId);
  await supabase.from("rubric_parts").delete().eq("rubric_id", targetRubricId);

  const { error: updateError } = await supabase
    .from("rubrics")
    .update({
      name: rubricData.name,
      description: rubricData.description ?? null,
      cap_score_to_assignment_points: rubricData.cap_score_to_assignment_points ?? true,
      is_private: rubricData.is_private ?? false,
      review_round:
        (rubricData.review_round as "self-review" | "grading-review" | "meta-grading-review" | "code-walk" | null) ??
        null
    })
    .eq("id", targetRubricId);

  if (updateError) throw new CLICommandError(`Failed to update rubric: ${updateError.message}`);

  for (const part of rubricData.parts) {
    const { data: newPart, error: partError } = await supabase
      .from("rubric_parts")
      .insert({
        assignment_id: assignment.id,
        class_id: classData.id,
        rubric_id: targetRubricId,
        name: part.name,
        description: part.description ?? null,
        ordinal: part.ordinal ?? 0
      })
      .select("id")
      .single();

    if (partError || !newPart) {
      throw new CLICommandError(`Failed to create part '${part.name}': ${partError?.message ?? "Unknown"}`);
    }

    for (const criteria of part.criteria) {
      const { data: newCriteria, error: criteriaError } = await supabase
        .from("rubric_criteria")
        .insert({
          assignment_id: assignment.id,
          class_id: classData.id,
          rubric_id: targetRubricId,
          rubric_part_id: newPart.id,
          name: criteria.name,
          description: criteria.description ?? null,
          ordinal: criteria.ordinal ?? 0,
          total_points: criteria.total_points ?? 0,
          is_additive: criteria.is_additive ?? true,
          is_deduction_only: criteria.is_deduction_only ?? false,
          min_checks_per_submission: criteria.min_checks_per_submission ?? null,
          max_checks_per_submission: criteria.max_checks_per_submission ?? null
        })
        .select("id")
        .single();

      if (criteriaError || !newCriteria) {
        throw new CLICommandError(
          `Failed to create criteria '${criteria.name}': ${criteriaError?.message ?? "Unknown"}`
        );
      }

      for (const check of criteria.checks) {
        const { error: checkError } = await supabase.from("rubric_checks").insert({
          assignment_id: assignment.id,
          class_id: classData.id,
          rubric_id: targetRubricId,
          rubric_criteria_id: newCriteria.id,
          name: check.name,
          description: check.description ?? null,
          ordinal: check.ordinal ?? 0,
          points: check.points ?? 0,
          is_annotation: check.is_annotation ?? false,
          is_comment_required: check.is_comment_required ?? false,
          is_required: check.is_required ?? false,
          annotation_target: check.annotation_target ?? null,
          artifact: check.artifact ?? null,
          file: check.file ?? null,
          group: check.group ?? null,
          max_annotations: check.max_annotations ?? null,
          student_visibility:
            (check.student_visibility as "always" | "if_released" | "if_applied" | "never") ?? "always"
        });

        if (checkError) {
          throw new CLICommandError(`Failed to create check '${check.name}': ${checkError.message}`);
        }
      }
    }
  }

  return {
    success: true,
    data: {
      rubric_type: rubricType,
      rubric_id: targetRubricId,
      summary: { parts: partCount, criteria: criteriaCount, checks: checkCount },
      message: "Rubric imported successfully"
    }
  };
}

registerCommand({
  name: "rubrics.list",
  requiredScope: "cli:read",
  handler: handleRubricsList
});

registerCommand({
  name: "rubrics.export",
  requiredScope: "cli:read",
  handler: handleRubricsExport
});

registerCommand({
  name: "rubrics.import",
  requiredScope: "cli:write",
  handler: handleRubricsImport
});
