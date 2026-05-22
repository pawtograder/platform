/**
 * Rubrics commands - list, export, import.
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass, resolveAssignment } from "../utils/resolvers.ts";
import { fetchRubricWithHierarchy, requireRubricTableDeleteOk } from "../utils/rubric.ts";
import {
  indexAssignmentRubrics,
  resolveYamlReference,
  serializeReferencesForExport,
  type IndexedCheck,
  type YamlReference
} from "../utils/rubricReferences.ts";
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

/**
 * Build the YAML-shaped export payload for a single rubric.
 *
 * `referencesByCheckId` maps a referencing check id → the YAML `references`
 * array already resolved+serialized against the full assignment rubric index.
 * Caller is responsible for loading rows from `rubric_check_references` and
 * passing them through {@link serializeReferencesForExport}. Checks with no
 * outgoing references omit the field entirely.
 */
function buildExportData(
  rubric: RubricWithHierarchy,
  referencesByCheckId: Map<number, YamlReference[]>
): {
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
        checks: (criteria.rubric_checks ?? []).map((check) => {
          const refs = referencesByCheckId.get(check.id);
          const out: RubricExportPart["criteria"][number]["checks"][number] = {
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
          };
          if (refs && refs.length > 0) out.references = refs;
          return out;
        })
      }))
    }))
  };
}

/**
 * Load every rubric on `assignmentId` and return both the hierarchy list and a
 * flat index of every (rubric, part, criterion, check) tuple — used by both
 * export (to serialize name-keyed references) and import (to resolve them).
 */
async function loadAssignmentRubricIndex(
  supabase: ReturnType<typeof getAdminClient>,
  assignmentId: number
): Promise<{ rubrics: RubricWithHierarchy[]; indexed: IndexedCheck[] }> {
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
    .eq("assignment_id", assignmentId);

  if (error) {
    throw new CLICommandError(`Failed to load rubrics for assignment ${assignmentId}: ${error.message}`);
  }
  const rubrics = (data ?? []) as RubricWithHierarchy[];
  return { rubrics, indexed: indexAssignmentRubrics(rubrics) };
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

  // Build the full-assignment index so we can emit name-keyed references that
  // can target checks in *other* rubrics on this assignment.
  const { indexed } = await loadAssignmentRubricIndex(supabase, assignment.id);

  const referencingCheckIds: number[] = [];
  for (const part of rubric.rubric_parts ?? []) {
    for (const crit of part.rubric_criteria ?? []) {
      for (const check of crit.rubric_checks ?? []) {
        referencingCheckIds.push(check.id);
      }
    }
  }

  const referencesByCheckId = new Map<number, YamlReference[]>();
  if (referencingCheckIds.length > 0) {
    const { data: refRows, error: refErr } = await supabase
      .from("rubric_check_references")
      .select("referencing_rubric_check_id, referenced_rubric_check_id")
      .eq("assignment_id", assignment.id)
      .in("referencing_rubric_check_id", referencingCheckIds);
    if (refErr) {
      throw new CLICommandError(
        `Failed to load rubric_check_references for assignment ${assignment.id}: ${refErr.message}`
      );
    }
    const grouped = new Map<number, Array<{ referenced_rubric_check_id: number }>>();
    for (const row of refRows ?? []) {
      const arr = grouped.get(row.referencing_rubric_check_id) ?? [];
      arr.push({ referenced_rubric_check_id: row.referenced_rubric_check_id });
      grouped.set(row.referencing_rubric_check_id, arr);
    }
    for (const [checkId, refs] of grouped) {
      referencesByCheckId.set(checkId, serializeReferencesForExport(refs, indexed));
    }
  }

  const exportData = buildExportData(rubric, referencesByCheckId);

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

  requireRubricTableDeleteOk(
    "rubric_check_references",
    targetRubricId,
    await supabase.from("rubric_check_references").delete().eq("rubric_id", targetRubricId)
  );
  requireRubricTableDeleteOk(
    "rubric_checks",
    targetRubricId,
    await supabase.from("rubric_checks").delete().eq("rubric_id", targetRubricId)
  );
  requireRubricTableDeleteOk(
    "rubric_criteria",
    targetRubricId,
    await supabase.from("rubric_criteria").delete().eq("rubric_id", targetRubricId)
  );
  requireRubricTableDeleteOk(
    "rubric_parts",
    targetRubricId,
    await supabase.from("rubric_parts").delete().eq("rubric_id", targetRubricId)
  );

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

  // Track every newly-inserted check so we can resolve its YAML `references`
  // after all checks (across every part/criterion) have been written.
  const pendingChecks: Array<{
    newCheckId: number;
    partName: string;
    criterionName: string;
    checkName: string;
    yamlReferences?: YamlReference[];
  }> = [];

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
        const { data: newCheck, error: checkError } = await supabase
          .from("rubric_checks")
          .insert({
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
          })
          .select("id")
          .single();

        if (checkError || !newCheck) {
          throw new CLICommandError(`Failed to create check '${check.name}': ${checkError?.message ?? "Unknown"}`);
        }

        pendingChecks.push({
          newCheckId: newCheck.id,
          partName: part.name,
          criterionName: criteria.name,
          checkName: check.name,
          yamlReferences: Array.isArray(check.references) ? check.references : undefined
        });
      }
    }
  }

  // ─── Resolve references after all checks are inserted ────────────────────
  // Reload the full assignment rubric index so we can resolve cross-rubric
  // name-keyed references (the export may include multiple rubrics, and the
  // import may run them sequentially — either way, querying the DB now gives
  // us the freshest snapshot).
  const { rubrics: allRubrics, indexed: assignmentIndex } = await loadAssignmentRubricIndex(supabase, assignment.id);
  const currentRubric = allRubrics.find((r) => r.id === targetRubricId);
  const currentReviewRound = currentRubric?.review_round ?? null;

  const warnings: Array<{ check_path: string; reason: string }> = [];
  let referenceRowsInserted = 0;

  for (const pending of pendingChecks) {
    const refs = pending.yamlReferences;
    if (!refs || refs.length === 0) continue;
    const checkPath = `${pending.partName} > ${pending.criterionName} > ${pending.checkName}`;
    for (const ref of refs) {
      const outcome = resolveYamlReference(ref, assignmentIndex, currentReviewRound);
      if (!outcome.ok) {
        warnings.push({ check_path: checkPath, reason: outcome.reason });
        // deno-lint-ignore no-console
        console.warn(`[rubrics.import] Skipping reference on "${checkPath}": ${outcome.reason}`);
        continue;
      }
      const { error: refInsertErr } = await supabase.from("rubric_check_references").insert({
        assignment_id: assignment.id,
        class_id: classData.id,
        rubric_id: targetRubricId,
        referencing_rubric_check_id: pending.newCheckId,
        referenced_rubric_check_id: outcome.target.checkId
      });
      if (refInsertErr) {
        throw new CLICommandError(
          `Failed to insert rubric_check_reference for check "${checkPath}" → check id ${outcome.target.checkId}: ${refInsertErr.message}`
        );
      }
      referenceRowsInserted++;
    }
  }

  return {
    success: true,
    data: {
      rubric_type: rubricType,
      rubric_id: targetRubricId,
      summary: {
        parts: partCount,
        criteria: criteriaCount,
        checks: checkCount,
        references: referenceRowsInserted
      },
      reference_warnings: warnings,
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
