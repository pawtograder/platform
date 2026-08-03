/**
 * Rubrics commands - list, export, import.
 */

import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass, resolveAssignment, resolveRubricIdForType } from "../utils/resolvers.ts";
import { assertUserCanAccessClass, assertUserIsClassInstructor } from "../utils/auth.ts";
import { fetchRubricWithHierarchy } from "../utils/rubric.ts";
import {
  indexAssignmentRubrics,
  resolveYamlReference,
  serializeReferencesForExport,
  type IndexedCheck,
  type YamlReference
} from "../utils/rubricReferences.ts";
import {
  buildUpdateRubricFullPayload,
  planRubricImport,
  rubricPathKey,
  rubricTreeToYaml,
  validateRubricYaml,
  type RubricTreeLike,
  type RubricYaml
} from "../../_shared/rubricYaml.ts";
import { createAuthenticatedSupabaseClient } from "../../_shared/MCPAuth.ts";
import { CLICommandError } from "../errors.ts";
import type {
  CLIResponse,
  RubricsListParams,
  RubricsExportParams,
  RubricsImportParams,
  RubricWithHierarchy
} from "../types.ts";

async function handleRubricsList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { class: classIdentifier, assignment: assignmentIdentifier } = params as unknown as RubricsListParams;
  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("assignment is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);
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

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  await assertUserCanAccessClass(supabase, ctx.userId, classData.id);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  const rubricId = resolveRubricIdForType(assignment, rubricType);

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

  const exportData = rubricTreeToYaml(rubric as unknown as RubricTreeLike, referencesByCheckId, {
    class_id: classData.id,
    assignment_id: assignment.id,
    rubric_id: rubricId,
    review_round: rubric.review_round,
    exported_at: new Date().toISOString()
  });

  if (p.strip_ids === true) {
    // A template rather than a round-trip artifact: without ids every row is created
    // new on import, which is what you want when seeding a different assignment.
    delete exportData._source;
    for (const part of exportData.parts) {
      delete part.id;
      for (const criteria of part.criteria) {
        delete criteria.id;
        for (const check of criteria.checks) delete check.id;
      }
    }
  }

  return {
    success: true,
    data: {
      rubric_type: rubricType,
      rubric_id: rubricId,
      rubric: exportData
    }
  };
}

/**
 * HTTP status for an `update_rubric_full` failure.
 *
 * The RPC has no exception handler of its own, so failures arrive as PostgREST
 * errors carrying the SQLSTATE. Every one of them means **nothing was changed** —
 * the function is a single transaction — and the messages say so, because that is
 * the whole point of routing through it instead of the old four-request
 * delete-then-insert.
 */
function classifyRubricRpcError(code: string | undefined, message: string, rubricId: number): CLICommandError {
  const nothingChanged = "Nothing was changed.";

  if (code === "23503") {
    return new CLICommandError(
      `${message}\n   A rubric check you removed is still referenced by existing grading comments. ` +
        `${nothingChanged} Re-add the check to the YAML, or delete those comments first.`,
      409
    );
  }
  if (code === "57014") {
    return new CLICommandError(
      `The rubric write exceeded the database statement timeout and was rolled back. ${nothingChanged}`,
      504
    );
  }
  if (code === "40001" || code === "40P01" || code === "55P03") {
    return new CLICommandError(
      `Another rubric save is in progress for rubric ${rubricId}. ${nothingChanged} Retry.`,
      409
    );
  }
  if (code === "22P02" || code === "22003") {
    return new CLICommandError(`A value in the YAML is not storable: ${message}. ${nothingChanged}`, 400);
  }
  if (code === "42501") {
    return new CLICommandError(
      `The rubric RPC is not executable by your role, which usually means the deployment is behind on migrations: ${message}`,
      403
    );
  }
  if (code === "PGRST202") {
    return new CLICommandError(`update_rubric_full is missing from this deployment: ${message}`, 500);
  }
  if (code === "P0001") {
    if (/Not authorized to edit rubrics/i.test(message)) {
      return new CLICommandError(
        `${message}. If you were recently granted instructor access, wait for the role sync and retry.`,
        403
      );
    }
    if (/not found in class/i.test(message)) {
      return new CLICommandError(`${message}. Re-run \`rubrics list\` — the rubric moved.`, 409);
    }
    return new CLICommandError(`update_rubric_full rejected the rubric: ${message}. ${nothingChanged}`, 400);
  }
  return new CLICommandError(`update_rubric_full failed: ${message}`, 500);
}

/**
 * rubrics.import — applies a YAML rubric through `update_rubric_full`, the same RPC
 * the web editor uses.
 *
 * This replaces a four-request delete-then-insert that had no transaction and
 * type-cast enums instead of validating them, so a typo'd value landed *after* the
 * live rubric had been deleted. On a rubric that had been graded it could not even
 * succeed: `rubric_check_references` was deleted, the `rubric_checks` delete then
 * failed on the comment foreign key, and the references were gone for good.
 *
 * The RPC is one transaction that diffs rather than wipes, cascades points changes to
 * existing comments, and recomputes affected submission_reviews — none of which the
 * raw inserts did. It gates on `authorizeforclassinstructor`, so it must be called on
 * a per-user client, and `rubrics.import` is therefore instructor-only.
 */
async function handleRubricsImport(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as RubricsImportParams;
  const classIdentifier = p.class;
  const assignmentIdentifier = p.assignment;
  const rubricType = p.type ?? "grading";
  const dryRun = p.dry_run === true;

  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("assignment is required");
  if (!p.rubric) throw new CLICommandError("rubric data is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  // Instructor-level: the RPC enforces the same thing, but checking here means a
  // grader gets a clear 403 instead of a raw Postgres exception after the read work.
  await assertUserIsClassInstructor(supabase, ctx.userId, classData.id);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  const targetRubricId = resolveRubricIdForType(assignment, rubricType);
  if (!targetRubricId) {
    throw new CLICommandError(`No ${rubricType} rubric exists for this assignment. Create the rubric first.`);
  }

  const validated = validateRubricYaml(p.rubric);
  if (!validated.ok) {
    throw new CLICommandError(
      `The rubric YAML has ${validated.errors.length} problem(s):\n` +
        validated.errors.map((e) => `   ${e.path || "(root)"}: ${e.message}`).join("\n"),
      400
    );
  }
  const yaml: RubricYaml = validated.value;

  const current = await fetchRubricWithHierarchy(supabase, targetRubricId);
  if (!current) throw new CLICommandError(`Rubric not found: ${targetRubricId}`, 404);
  const currentTree = current as unknown as RubricTreeLike;

  // The YAML's review_round is never written. The RPC only sets it on insert, and
  // the old code *did* write it on update — so `export --type self_review` followed
  // by `import --type grading` rewrote the grading rubric's round, desynchronising it
  // from assignments.grading_rubric_id. Disagreement is a caller error.
  if (yaml.review_round && currentTree.review_round && yaml.review_round !== currentTree.review_round) {
    throw new CLICommandError(
      `This YAML was exported from the '${yaml.review_round}' rubric but --type ${rubricType} targets the ` +
        `'${currentTree.review_round}' rubric. Re-run with the matching --type, or remove review_round from the YAML.`,
      400
    );
  }

  // References are resolved before the write, against the whole-assignment index.
  // Only cross-round references are legal, so every target lives in a rubric this
  // call is not touching and its id is stable across the transaction.
  const { indexed } = await loadAssignmentRubricIndex(supabase, assignment.id);
  const resolvedRefsByPath = new Map<string, number[]>();
  const referenceWarnings: string[] = [];

  const persistedRefsByCheckId = new Map<number, number[]>();
  const existingCheckIds: number[] = [];
  for (const part of currentTree.rubric_parts ?? []) {
    for (const crit of part.rubric_criteria ?? []) {
      for (const check of crit.rubric_checks ?? []) existingCheckIds.push(check.id);
    }
  }
  if (existingCheckIds.length > 0) {
    for (let i = 0; i < existingCheckIds.length; i += 500) {
      const { data: refRows, error: refErr } = await supabase
        .from("rubric_check_references")
        .select("referencing_rubric_check_id, referenced_rubric_check_id")
        .in("referencing_rubric_check_id", existingCheckIds.slice(i, i + 500))
        .order("id", { ascending: true });
      if (refErr) throw new CLICommandError(`Failed to load existing references: ${refErr.message}`, 500);
      for (const row of refRows ?? []) {
        const list = persistedRefsByCheckId.get(row.referencing_rubric_check_id) ?? [];
        list.push(row.referenced_rubric_check_id);
        persistedRefsByCheckId.set(row.referencing_rubric_check_id, list);
      }
    }
  }

  yaml.parts.forEach((part, partIdx) => {
    part.criteria.forEach((criteria, critIdx) => {
      criteria.checks.forEach((check, checkIdx) => {
        const key = rubricPathKey(partIdx, critIdx, checkIdx);
        const refs = check.references ?? [];
        if (refs.length === 0) return;

        const resolved: number[] = [];
        const failures: string[] = [];
        for (const ref of refs) {
          const outcome = resolveYamlReference(ref, indexed, currentTree.review_round ?? null);
          if (!outcome.ok) {
            failures.push(outcome.reason);
            continue;
          }
          if (!resolved.includes(outcome.target.checkId)) resolved.push(outcome.target.checkId);
        }

        if (failures.length > 0) {
          const persisted = typeof check.id === "number" ? persistedRefsByCheckId.get(check.id) : undefined;
          if (persisted && persisted.length > 0) {
            // Keeping the persisted set: the RPC removes any reference row absent
            // from the payload, so dropping an unresolvable one would actively
            // delete a working reference rather than merely skip it.
            referenceWarnings.push(
              `check '${check.name}': ${failures.join("; ")} — kept the ${persisted.length} reference(s) already stored`
            );
            resolvedRefsByPath.set(key, persisted);
            return;
          }
          referenceWarnings.push(`check '${check.name}': ${failures.join("; ")} — dropped`);
        }
        resolvedRefsByPath.set(key, resolved);
      });
    });
  });

  const payload = buildUpdateRubricFullPayload({
    yaml,
    rubricId: targetRubricId,
    classId: classData.id,
    assignmentId: assignment.id,
    reviewRound: currentTree.review_round,
    existing: currentTree,
    resolvedRefsByPath
  });

  const plan = planRubricImport(currentTree, payload);
  const source = yaml._source ?? null;
  const rebuildingFromForeignYaml = plan.foreign_ids.length > 0;

  if (dryRun) {
    return {
      success: true,
      data: {
        dry_run: true,
        rubric_type: rubricType,
        target_rubric_id: targetRubricId,
        plan,
        source,
        rebuilding_from_foreign_yaml: rebuildingFromForeignYaml,
        warnings: [...validated.warnings.map((w) => `${w.path}: ${w.message}`), ...referenceWarnings],
        message: "Nothing was changed."
      }
    };
  }

  // A per-user client, minted immediately before the call: the RPC gates on
  // authorizeforclassinstructor, which needs auth.uid(), and the JWT lives 60
  // seconds without auto-refresh, so the reads above can outlast one minted earlier.
  const writeClient = await createAuthenticatedSupabaseClient(ctx.userId);
  const { data: rpcSummary, error: rpcError } = await writeClient.rpc("update_rubric_full", {
    p_rubric: payload as unknown as never
  });

  if (rpcError) {
    throw classifyRubricRpcError(rpcError.code, rpcError.message, targetRubricId);
  }

  // Counts read back from the database rather than from the input, so what is
  // reported is what exists.
  const after = await fetchRubricWithHierarchy(supabase, targetRubricId);
  const afterTree = (after ?? currentTree) as unknown as RubricTreeLike;
  let criteriaCount = 0;
  let checkCount = 0;
  for (const part of afterTree.rubric_parts ?? []) {
    for (const crit of part.rubric_criteria ?? []) {
      criteriaCount += 1;
      checkCount += (crit.rubric_checks ?? []).length;
    }
  }

  return {
    success: true,
    data: {
      dry_run: false,
      rubric_type: rubricType,
      target_rubric_id: targetRubricId,
      message: typeof rpcSummary === "string" ? rpcSummary : "Rubric applied.",
      summary: { parts: (afterTree.rubric_parts ?? []).length, criteria: criteriaCount, checks: checkCount },
      plan,
      source,
      rebuilding_from_foreign_yaml: rebuildingFromForeignYaml,
      warnings: [...validated.warnings.map((w) => `${w.path}: ${w.message}`), ...referenceWarnings]
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
