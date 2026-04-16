/**
 * Assignments commands - list, show, copy, delete.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass, resolveAssignment } from "../utils/resolvers.ts";
import { copyLinkedSurveysForAssignment, fetchLatestLinkedSurveysForAssignment } from "../utils/surveyCopy.ts";
import { copyRubricStructure, copyRubricCheckReferencesForAssignment } from "../utils/rubric.ts";
import { repoExistsOnGitHub } from "../utils/github.ts";
import { CLICommandError } from "../errors.ts";
import type {
  CLIResponse,
  AssignmentsListParams,
  AssignmentsShowParams,
  AssignmentsDeleteParams,
  AssignmentsCopyParams,
  CopySpec,
  CopyResult,
  CopyStatus,
  RepoCopyPair,
  ClassRow,
  AssignmentRow
} from "../types.ts";

/** Optional verbose logs for troubleshooting timeouts (request `debug: true` or env CLI_ASSIGNMENTS_COPY_DEBUG). */
function assignmentsCopyDebugEnabled(debugParam: boolean | undefined): boolean {
  if (debugParam === true) return true;
  const v = Deno.env.get("CLI_ASSIGNMENTS_COPY_DEBUG");
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === "1" || t === "true" || t === "yes";
}

type AssignmentCopyDebugLog = (phase: string, detail?: Record<string, unknown>) => void;

function createAssignmentCopyDebugLog(context: Record<string, unknown>): {
  log: AssignmentCopyDebugLog;
} {
  const t0 = performance.now();
  let stepStart = t0;
  return {
    log(phase, detail = {}) {
      const now = performance.now();
      const stepMs = Math.round(now - stepStart);
      const totalMs = Math.round(now - t0);
      stepStart = now;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          cli: "assignments.copy",
          phase,
          step_ms: stepMs,
          total_ms: totalMs,
          ...context,
          ...detail
        })
      );
    }
  };
}

/**
 * Poll `repoExistsOnGitHub` a few times to tolerate brief propagation lag after
 * a template-generate repo creation. Returns true if we eventually see it.
 */
async function verifyRepoReachable(repoFullName: string, attempts = 3, delayMs = 1000): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await repoExistsOnGitHub(repoFullName)) return true;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return false;
}

function formatEdgeFunctionBodyForError(data: unknown): string {
  if (data === undefined) return "undefined";
  if (data === null) return "null";
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

async function handleAssignmentsList(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { class: classIdentifier } = params as unknown as AssignmentsListParams;
  if (!classIdentifier) throw new CLICommandError("class is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);

  const { data: assignments, error } = await supabase
    .from("assignments")
    .select("*")
    .eq("class_id", classData.id)
    .order("release_date", { ascending: true });

  if (error) throw new CLICommandError(`Failed to fetch assignments: ${error.message}`);

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      assignments: (assignments ?? []).map((a) => ({
        id: a.id,
        slug: a.slug,
        title: a.title,
        description: a.description,
        release_date: a.release_date,
        due_date: a.due_date,
        total_points: a.total_points,
        has_autograder: a.has_autograder,
        has_handgrader: a.has_handgrader,
        template_repo: a.template_repo,
        grading_rubric_id: a.grading_rubric_id,
        self_review_rubric_id: a.self_review_rubric_id,
        meta_grading_rubric_id: a.meta_grading_rubric_id
      }))
    }
  };
}

async function handleAssignmentsShow(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { class: classIdentifier, identifier: assignmentIdentifier } = params as unknown as AssignmentsShowParams;
  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("identifier is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  return {
    success: true,
    data: {
      class: { id: classData.id, slug: classData.slug, name: classData.name },
      assignment: {
        id: assignment.id,
        slug: assignment.slug,
        title: assignment.title,
        class_id: assignment.class_id,
        description: assignment.description,
        release_date: assignment.release_date,
        due_date: assignment.due_date,
        total_points: assignment.total_points,
        max_late_tokens: assignment.max_late_tokens,
        group_config: assignment.group_config,
        has_autograder: assignment.has_autograder,
        has_handgrader: assignment.has_handgrader,
        template_repo: assignment.template_repo,
        grading_rubric_id: assignment.grading_rubric_id,
        self_review_rubric_id: assignment.self_review_rubric_id,
        meta_grading_rubric_id: assignment.meta_grading_rubric_id
      }
    }
  };
}

async function handleAssignmentsDelete(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const { class: classIdentifier, identifier: assignmentIdentifier } = params as unknown as AssignmentsDeleteParams;
  if (!classIdentifier) throw new CLICommandError("class is required");
  if (!assignmentIdentifier) throw new CLICommandError("identifier is required");

  const supabase = getAdminClient();
  const classData = await resolveClass(supabase, classIdentifier);
  const assignment = await resolveAssignment(supabase, classData.id, assignmentIdentifier);

  const { data, error } = await supabase.functions.invoke("assignment-delete", {
    body: { assignment_id: assignment.id, class_id: classData.id }
  });

  if (error) throw new CLICommandError(`Failed to delete assignment: ${error.message}`);
  const invokeError = data as { error?: { details?: string; message?: string }; message?: string } | null;
  if (invokeError?.error) {
    throw new CLICommandError(
      `Failed to delete assignment: ${invokeError.error.details ?? invokeError.error.message ?? "Unknown error"}`
    );
  }

  return {
    success: true,
    data: {
      message: `Assignment "${assignment.title}" has been deleted`,
      assignment_id: assignment.id,
      details: (data as { message?: string })?.message
    }
  };
}

/**
 * Schedule CSV may include legacy `latest_due_date`. Assignments store a single `due_date` (there is no separate latest_due_date column).
 */
function mergeScheduleDueDateOverrides(
  dueDate: string | undefined,
  latestDueDate: string | undefined,
  rowDescription: string
): string | undefined {
  if (dueDate !== undefined && latestDueDate !== undefined && dueDate !== latestDueDate) {
    throw new CLICommandError(
      `${rowDescription}: due_date (${dueDate}) and latest_due_date (${latestDueDate}) differ, but only one due date is stored per assignment. Use the same value in both columns or supply only one.`
    );
  }
  return dueDate ?? latestDueDate;
}

async function handleAssignmentsCopy(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as AssignmentsCopyParams;
  const sourceClassId = p.source_class;
  const targetClassId = p.target_class;
  const assignmentIdentifier = p.assignment;
  const copyAll = p.all === true;
  const dryRun = p.dry_run === true;
  const skipRepos = p.skip_repos === true;
  const skipRubrics = p.skip_rubrics === true;
  const skipSurveys = p.skip_surveys === true;
  const schedule = p.schedule;
  const copyDebug = assignmentsCopyDebugEnabled(p.debug);

  if (!sourceClassId) throw new CLICommandError("source_class is required");
  if (!targetClassId) throw new CLICommandError("target_class is required");

  const specifiedCount = [assignmentIdentifier, schedule, copyAll].filter(Boolean).length;
  if (specifiedCount !== 1) {
    throw new CLICommandError("Must specify exactly one of: assignment, schedule, or all");
  }

  const supabase = getAdminClient();
  const sourceClass = await resolveClass(supabase, sourceClassId);
  const targetClass = await resolveClass(supabase, targetClassId);

  if (copyDebug) {
    const { log } = createAssignmentCopyDebugLog({
      source_class_id: sourceClass.id,
      target_class_id: targetClass.id
    });
    log("request", {
      dry_run: dryRun,
      skip_repos: skipRepos,
      skip_rubrics: skipRubrics,
      skip_surveys: skipSurveys,
      selection: assignmentIdentifier
        ? { mode: "single", assignment: assignmentIdentifier }
        : copyAll
          ? { mode: "all" }
          : { mode: "schedule", rows: schedule?.length ?? 0 }
    });
  }

  if (sourceClass.id === targetClass.id) {
    throw new CLICommandError("Source and target classes must be different");
  }

  if (!skipRepos && !targetClass.github_org) {
    throw new CLICommandError("Target class must have a GitHub org configured (use skip_repos to skip)");
  }

  const assignmentsToCopy: CopySpec[] = [];

  if (assignmentIdentifier) {
    const assignment = await resolveAssignment(supabase, sourceClass.id, assignmentIdentifier);
    assignmentsToCopy.push({ assignment });
  } else if (copyAll) {
    const { data: allAssignments } = await supabase
      .from("assignments")
      .select("*")
      .eq("class_id", sourceClass.id)
      .order("release_date", { ascending: true });
    for (const a of allAssignments ?? []) {
      assignmentsToCopy.push({ assignment: a as AssignmentRow });
    }
  } else if (schedule) {
    const { data: allAssignments } = await supabase.from("assignments").select("*").eq("class_id", sourceClass.id);

    const bySlug = new Map<string, AssignmentRow>();
    const byTitle = new Map<string, AssignmentRow>();
    for (const a of allAssignments ?? []) {
      const row = a as AssignmentRow;
      if (row.slug) bySlug.set(row.slug, row);
      if (row.title) byTitle.set(row.title, row);
    }

    for (const row of schedule) {
      let assignment: AssignmentRow | undefined;
      if (row.assignment_slug) {
        assignment = bySlug.get(row.assignment_slug);
        if (!assignment) throw new CLICommandError(`No assignment found with slug "${row.assignment_slug}"`);
      } else if (row.assignment_title) {
        assignment = byTitle.get(row.assignment_title);
        if (!assignment) throw new CLICommandError(`No assignment found with title "${row.assignment_title}"`);
      } else {
        throw new CLICommandError("Each schedule item must have assignment_slug or assignment_title");
      }
      const rowDescription = row.assignment_slug
        ? `Schedule row for slug "${row.assignment_slug}"`
        : `Schedule row for title "${row.assignment_title}"`;
      assignmentsToCopy.push({
        assignment,
        releaseDateOverride: row.release_date,
        dueDateOverride: mergeScheduleDueDateOverrides(row.due_date, row.latest_due_date, rowDescription)
      });
    }
  }

  if (assignmentsToCopy.length === 0) {
    throw new CLICommandError("No assignments to copy");
  }

  if (dryRun) {
    if (copyDebug) {
      const { log } = createAssignmentCopyDebugLog({
        source_class_id: sourceClass.id,
        target_class_id: targetClass.id
      });
      log("dry_run_ready", { assignment_count: assignmentsToCopy.length });
    }
    const assignments_to_copy = await Promise.all(
      assignmentsToCopy.map(async (s) => {
        const linked =
          skipSurveys || !s.assignment.id
            ? []
            : await fetchLatestLinkedSurveysForAssignment(supabase, sourceClass.id, s.assignment.id);
        return {
          slug: s.assignment.slug,
          title: s.assignment.title,
          release_date: s.releaseDateOverride ?? s.assignment.release_date,
          due_date: s.dueDateOverride ?? s.assignment.due_date,
          linked_surveys: linked.map((x) => ({ id: x.id, survey_id: x.survey_id, title: x.title }))
        };
      })
    );

    return {
      success: true,
      data: {
        dry_run: true,
        source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
        target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
        assignments_to_copy
      }
    };
  }

  const results: Array<{
    source_slug: string | null;
    source_title: string;
    success: boolean;
    new_assignment_id?: number;
    was_existing?: boolean;
    status?: CopyStatus;
    repo_copy_pairs?: RepoCopyPair[];
    error?: string;
  }> = [];

  const repoCopyPairs: RepoCopyPair[] = [];

  for (let i = 0; i < assignmentsToCopy.length; i++) {
    const spec = assignmentsToCopy[i];
    try {
      const debugLog = copyDebug
        ? createAssignmentCopyDebugLog({
            source_class_id: sourceClass.id,
            target_class_id: targetClass.id,
            index: i + 1,
            of: assignmentsToCopy.length
          }).log
        : undefined;

      const result = await copySingleAssignment(supabase, spec.assignment, sourceClass, targetClass, {
        skipRepos,
        skipRubrics,
        skipSurveys,
        releaseDateOverride: spec.releaseDateOverride,
        dueDateOverride: spec.dueDateOverride,
        debugLog
      });
      const hasErrors = result.status.errors.length > 0;
      results.push({
        source_slug: spec.assignment.slug,
        source_title: spec.assignment.title,
        success: !hasErrors,
        new_assignment_id: result.assignmentId,
        was_existing: result.wasExisting,
        status: result.status,
        repo_copy_pairs: result.repoCopyPairs,
        error: hasErrors ? result.status.errors.map((e) => `${e.step}: ${e.error}`).join("; ") : undefined
      });
      repoCopyPairs.push(...result.repoCopyPairs);
    } catch (err) {
      if (copyDebug) {
        createAssignmentCopyDebugLog({
          source_class_id: sourceClass.id,
          target_class_id: targetClass.id,
          index: i + 1,
          of: assignmentsToCopy.length
        }).log("assignment_failed", {
          source_assignment_id: spec.assignment.id,
          slug: spec.assignment.slug,
          error: err instanceof Error ? err.message : String(err)
        });
      }
      results.push({
        source_slug: spec.assignment.slug,
        source_title: spec.assignment.title,
        success: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    success: true,
    data: {
      source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
      target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
      results,
      repo_copy_pairs: repoCopyPairs,
      summary: {
        total: assignmentsToCopy.length,
        succeeded: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length
      }
    }
  };
}

async function getOrCreateDefaultSelfReviewSetting(
  supabase: SupabaseClient<Database>,
  classId: number
): Promise<number> {
  const { data: existing } = await supabase
    .from("assignment_self_review_settings")
    .select("id")
    .eq("class_id", classId)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const { data: created, error } = await supabase
    .from("assignment_self_review_settings")
    .insert({ class_id: classId, enabled: false })
    .select("id")
    .single();
  if (error || !created?.id) {
    throw new CLICommandError(`Failed to create default self-review setting: ${error?.message ?? "Unknown"}`);
  }
  return created.id;
}

async function copySingleAssignment(
  supabase: SupabaseClient<Database>,
  sourceAssignment: AssignmentRow,
  sourceClass: ClassRow,
  targetClass: ClassRow,
  options: {
    skipRepos: boolean;
    skipRubrics: boolean;
    skipSurveys: boolean;
    releaseDateOverride?: string;
    dueDateOverride?: string;
    debugLog?: AssignmentCopyDebugLog;
  }
): Promise<CopyResult> {
  const mark = (phase: string, detail?: Record<string, unknown>) => options.debugLog?.(phase, detail);

  mark("assignment_start", {
    source_assignment_id: sourceAssignment.id,
    slug: sourceAssignment.slug,
    title: sourceAssignment.title,
    skip_repos: options.skipRepos,
    skip_rubrics: options.skipRubrics,
    skip_surveys: options.skipSurveys,
    has_autograder: sourceAssignment.has_autograder,
    template_repo: sourceAssignment.template_repo ?? null
  });

  const status: CopyStatus = {
    assignmentCreated: false,
    selfReviewSettingsCopied: false,
    rubricsCopied: false,
    autograderConfigCopied: false,
    handoutRepoCreated: false,
    solutionRepoCreated: false,
    surveysCopied: false,
    errors: []
  };

  const repoCopyPairs: RepoCopyPair[] = [];

  const addError = (step: string, err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    status.errors.push({ step, error: msg });
  };

  type AssignmentWithAutograder = AssignmentRow & { autograder?: { grader_repo?: string } | null };

  const { data: existingAssignment } = sourceAssignment.slug
    ? await supabase
        .from("assignments")
        .select("*, autograder(*)")
        .eq("class_id", targetClass.id)
        .eq("slug", sourceAssignment.slug)
        .maybeSingle()
    : { data: null };

  let newAssignment: AssignmentWithAutograder;
  const wasExisting = !!existingAssignment;

  mark("resolved_target_assignment", { was_existing: wasExisting });

  if (existingAssignment) {
    newAssignment = existingAssignment as AssignmentWithAutograder;
    status.assignmentCreated = true;
  } else {
    let newSelfReviewSettingId: number;
    if (sourceAssignment.self_review_setting_id) {
      const { data: sourceSettings } = await supabase
        .from("assignment_self_review_settings")
        .select("*")
        .eq("id", sourceAssignment.self_review_setting_id)
        .single();

      if (sourceSettings) {
        const { data: newSettings } = await supabase
          .from("assignment_self_review_settings")
          .insert({
            class_id: targetClass.id,
            enabled: sourceSettings.enabled,
            allow_early: sourceSettings.allow_early,
            deadline_offset: sourceSettings.deadline_offset
          })
          .select("id")
          .single();

        if (newSettings?.id) {
          newSelfReviewSettingId = newSettings.id;
          status.selfReviewSettingsCopied = true;
        } else {
          newSelfReviewSettingId = await getOrCreateDefaultSelfReviewSetting(supabase, targetClass.id);
        }
      } else {
        newSelfReviewSettingId = await getOrCreateDefaultSelfReviewSetting(supabase, targetClass.id);
      }
    } else {
      newSelfReviewSettingId = await getOrCreateDefaultSelfReviewSetting(supabase, targetClass.id);
    }

    const newAssignmentData = {
      class_id: targetClass.id,
      title: sourceAssignment.title,
      slug: sourceAssignment.slug,
      description: sourceAssignment.description,
      release_date: options.releaseDateOverride ?? sourceAssignment.release_date,
      due_date: options.dueDateOverride ?? sourceAssignment.due_date,
      total_points: sourceAssignment.total_points,
      max_late_tokens: sourceAssignment.max_late_tokens,
      group_config: sourceAssignment.group_config,
      min_group_size: sourceAssignment.min_group_size,
      max_group_size: sourceAssignment.max_group_size,
      allow_student_formed_groups: sourceAssignment.allow_student_formed_groups,
      group_formation_deadline: sourceAssignment.group_formation_deadline,
      has_autograder: sourceAssignment.has_autograder,
      has_handgrader: sourceAssignment.has_handgrader,
      grader_pseudonymous_mode: sourceAssignment.grader_pseudonymous_mode,
      show_leaderboard: sourceAssignment.show_leaderboard,
      allow_not_graded_submissions: sourceAssignment.allow_not_graded_submissions,
      minutes_due_after_lab: sourceAssignment.minutes_due_after_lab,
      self_review_setting_id: newSelfReviewSettingId,
      grading_rubric_id: null,
      self_review_rubric_id: null,
      meta_grading_rubric_id: null,
      template_repo: null,
      student_repo_prefix: null
    };

    const { data: newAssignmentInitial, error: assignmentError } = await supabase
      .from("assignments")
      .insert(newAssignmentData)
      .select("*")
      .single();

    if (assignmentError || !newAssignmentInitial) {
      throw new CLICommandError(`Failed to create assignment: ${assignmentError?.message ?? "Unknown"}`);
    }

    const { data: refetched } = await supabase
      .from("assignments")
      .select("*")
      .eq("id", newAssignmentInitial.id)
      .single();

    if (!refetched) {
      throw new CLICommandError("Failed to re-fetch assignment after creation");
    }
    newAssignment = refetched as AssignmentWithAutograder;
    status.assignmentCreated = true;
  }

  mark("assignment_row_ready", { target_assignment_id: newAssignment.id });

  if (!options.skipRubrics) {
    mark("rubrics_start", {
      grading_rubric_id: sourceAssignment.grading_rubric_id ?? null,
      self_review_rubric_id: sourceAssignment.self_review_rubric_id ?? null,
      meta_grading_rubric_id: sourceAssignment.meta_grading_rubric_id ?? null
    });
    try {
      // Shared structures for the two-phase copy. A single rubric_check_references row can
      // cross rubrics (e.g. a self-review check can reference a grading check), so we build
      // a shared sourceCheckId → targetCheckId map across all rubrics for this assignment,
      // then do the reference insert in a second pass after every rubric is in place.
      const sharedCheckIdMap = new Map<number, number>();
      const rubricIdPairs: Array<{ sourceRubricId: number; targetRubricId: number }> = [];

      const setAssignmentRubricId = async (
        column: "grading_rubric_id" | "self_review_rubric_id" | "meta_grading_rubric_id",
        targetRubricId: number
      ) => {
        const {
          data,
          error,
          status: httpStatus
        } = await supabase
          .from("assignments")
          .update({ [column]: targetRubricId })
          .eq("id", newAssignment.id)
          .select("id");
        if (error) {
          const detail =
            [
              error.code && `code=${error.code}`,
              error.details && `details=${error.details}`,
              error.hint && `hint=${error.hint}`
            ]
              .filter(Boolean)
              .join("; ") || undefined;
          throw new CLICommandError(
            `Failed to set ${column} on assignment (assignment_id=${newAssignment.id}, ${column}=${targetRubricId}): ${error.message}${detail ? ` (${detail})` : ""}`
          );
        }
        if (httpStatus < 200 || httpStatus >= 300) {
          throw new CLICommandError(
            `Failed to set ${column} on assignment (assignment_id=${newAssignment.id}, ${column}=${targetRubricId}): unexpected HTTP status ${httpStatus}`
          );
        }
        if (!data?.length) {
          throw new CLICommandError(
            `Failed to set ${column} on assignment (assignment_id=${newAssignment.id}, ${column}=${targetRubricId}): update matched no rows`
          );
        }
      };

      const copyOne = async (
        sourceRubricId: number,
        existingTargetRubricId: number | null,
        column: "grading_rubric_id" | "self_review_rubric_id" | "meta_grading_rubric_id"
      ) => {
        const targetRubricId = await copyRubricStructure(
          supabase,
          sourceRubricId,
          newAssignment.id,
          targetClass.id,
          sharedCheckIdMap,
          existingTargetRubricId ?? undefined
        );
        rubricIdPairs.push({ sourceRubricId, targetRubricId });
        if (!existingTargetRubricId) {
          await setAssignmentRubricId(column, targetRubricId);
        }
      };

      if (sourceAssignment.grading_rubric_id) {
        await copyOne(sourceAssignment.grading_rubric_id, newAssignment.grading_rubric_id ?? null, "grading_rubric_id");
      }
      if (sourceAssignment.self_review_rubric_id) {
        await copyOne(
          sourceAssignment.self_review_rubric_id,
          newAssignment.self_review_rubric_id ?? null,
          "self_review_rubric_id"
        );
      }
      if (sourceAssignment.meta_grading_rubric_id) {
        await copyOne(
          sourceAssignment.meta_grading_rubric_id,
          newAssignment.meta_grading_rubric_id ?? null,
          "meta_grading_rubric_id"
        );
      }

      // Second phase: copy rubric_check_references using the accumulated map.
      // Any references that cross rubrics (e.g. self-review → grading) are resolved here
      // because every rubric's checks are already present in sharedCheckIdMap.
      await copyRubricCheckReferencesForAssignment(
        supabase,
        rubricIdPairs,
        newAssignment.id,
        targetClass.id,
        sharedCheckIdMap
      );

      status.rubricsCopied = true;
    } catch (err) {
      addError("rubrics", err);
    }
    mark("rubrics_done", {
      rubrics_copied: status.rubricsCopied,
      rubric_errors: status.errors.filter((e) => e.step === "rubrics").length
    });
  }

  if (sourceAssignment.has_autograder) {
    mark("autograder_config_start", {});
    try {
      const { data: sourceConfig, error: sourceConfigError } = await supabase
        .from("autograder")
        .select("*")
        .eq("id", sourceAssignment.id)
        .single();

      if (sourceConfigError && sourceConfigError.code !== "PGRST116") {
        throw new CLICommandError(
          `Failed to fetch source autograder config (assignment_id=${sourceAssignment.id}): ${sourceConfigError.message}`
        );
      }

      if (sourceConfig) {
        const { data: existing, error: existingRowError } = await supabase
          .from("autograder")
          .select("id, grader_repo")
          .eq("id", newAssignment.id)
          .single();

        if (existingRowError && existingRowError.code !== "PGRST116") {
          throw new CLICommandError(
            `Failed to look up target autograder row (assignment_id=${newAssignment.id}): ${existingRowError.message}`
          );
        }

        if (existing) {
          await supabase
            .from("autograder")
            .update({
              config: sourceConfig.config,
              max_submissions_count: sourceConfig.max_submissions_count,
              max_submissions_period_secs: sourceConfig.max_submissions_period_secs
            })
            .eq("id", newAssignment.id);
        } else {
          await supabase.from("autograder").insert({
            id: newAssignment.id,
            class_id: targetClass.id,
            config: sourceConfig.config,
            max_submissions_count: sourceConfig.max_submissions_count,
            max_submissions_period_secs: sourceConfig.max_submissions_period_secs,
            grader_repo: null,
            grader_commit_sha: null,
            workflow_sha: null,
            latest_autograder_sha: null
          });
        }
        status.autograderConfigCopied = true;
      }
    } catch (err) {
      addError("autograder_config", err);
    }
    mark("autograder_config_done", { copied: status.autograderConfigCopied });
  }

  if (!options.skipRepos && targetClass.github_org) {
    mark("repos_start", { github_org: targetClass.github_org });

    // Handout repo: ensure an empty target exists; do not copy contents here — the CLI does it locally via SSH git.
    if (sourceAssignment.template_repo) {
      let handoutTargetRepoFullName: string | null = newAssignment.template_repo ?? null;

      if (!handoutTargetRepoFullName) {
        mark("handout_repo_create_invoke", { source_template_repo: sourceAssignment.template_repo });
        try {
          const { data: handoutData } = await supabase.functions.invoke("assignment-create-handout-repo", {
            body: { assignment_id: newAssignment.id, class_id: targetClass.id }
          });

          const hd = handoutData as { error?: unknown; org_name?: string; repo_name?: string } | null;
          if (hd?.error) {
            addError("handout_repo_create", hd.error);
          } else {
            const org = hd?.org_name;
            const repo = hd?.repo_name;
            if (
              typeof org === "string" &&
              org.trim().length > 0 &&
              typeof repo === "string" &&
              repo.trim().length > 0
            ) {
              handoutTargetRepoFullName = `${org.trim()}/${repo.trim()}`;
              status.handoutRepoCreated = true;
            } else {
              throw new CLICommandError(
                `assignment-create-handout-repo returned an unexpected response (expected org_name and repo_name). Raw: ${formatEdgeFunctionBodyForError(handoutData)}`
              );
            }
          }
        } catch (err) {
          addError("handout_repo_create", err);
        }
      } else {
        status.handoutRepoCreated = true;
      }

      if (handoutTargetRepoFullName) {
        mark("handout_repo_verify_reachable", { repo: handoutTargetRepoFullName });
        const reachable = await verifyRepoReachable(handoutTargetRepoFullName);
        if (reachable) {
          repoCopyPairs.push({
            kind: "handout",
            source_repo: sourceAssignment.template_repo,
            target_repo: handoutTargetRepoFullName,
            assignment_id: newAssignment.id,
            assignment_slug: newAssignment.slug ?? null
          });
        } else {
          addError(
            "handout_repo_verify",
            new Error(
              `Handout repo ${handoutTargetRepoFullName} was not reachable via the GitHub API after creation; will not queue content copy.`
            )
          );
        }
      }

      mark("handout_repo_path_done", {
        handoutRepoCreated: status.handoutRepoCreated,
        queued_for_copy: !!handoutTargetRepoFullName && repoCopyPairs.some((p) => p.kind === "handout")
      });
    }

    // Solution repo: same pattern — ensure empty repo; CLI will populate content.
    const { data: sourceAutograder } = await supabase
      .from("autograder")
      .select("grader_repo")
      .eq("id", sourceAssignment.id)
      .maybeSingle();

    if (sourceAutograder?.grader_repo) {
      const { data: targetAutograder } = await supabase
        .from("autograder")
        .select("grader_repo")
        .eq("id", newAssignment.id)
        .single();

      const targetRepoSet = !!targetAutograder?.grader_repo;
      let targetRepoExists = false;
      if (targetRepoSet && targetAutograder?.grader_repo) {
        targetRepoExists = await repoExistsOnGitHub(targetAutograder.grader_repo);
      }

      let solutionTargetRepoFullName: string | null = targetRepoSet ? (targetAutograder?.grader_repo ?? null) : null;

      const needsSolution = !targetRepoSet || !targetRepoExists;
      if (needsSolution) {
        mark("solution_repo_create_invoke", { source_grader_repo: sourceAutograder.grader_repo });
        try {
          const { data: solutionData } = await supabase.functions.invoke("assignment-create-solution-repo", {
            body: { assignment_id: newAssignment.id, class_id: targetClass.id }
          });

          const sd = solutionData as { error?: unknown; org_name?: string; repo_name?: string } | null;
          if (sd?.error) {
            addError("solution_repo_create", sd.error);
          } else {
            const org = sd?.org_name;
            const repo = sd?.repo_name;
            if (
              typeof org === "string" &&
              org.trim().length > 0 &&
              typeof repo === "string" &&
              repo.trim().length > 0
            ) {
              solutionTargetRepoFullName = `${org.trim()}/${repo.trim()}`;

              const { data: afterCreate } = await supabase
                .from("autograder")
                .select("grader_repo")
                .eq("id", newAssignment.id)
                .single();

              if (!afterCreate?.grader_repo) {
                await supabase
                  .from("autograder")
                  .update({ grader_repo: solutionTargetRepoFullName })
                  .eq("id", newAssignment.id);
              }
              status.solutionRepoCreated = true;
            } else {
              throw new CLICommandError(
                `assignment-create-solution-repo returned an unexpected response (expected org_name and repo_name). Raw: ${formatEdgeFunctionBodyForError(solutionData)}`
              );
            }
          }
        } catch (err) {
          addError("solution_repo_create", err);
        }
      } else {
        status.solutionRepoCreated = true;
      }

      if (solutionTargetRepoFullName) {
        mark("solution_repo_verify_reachable", { repo: solutionTargetRepoFullName });
        const reachable = await verifyRepoReachable(solutionTargetRepoFullName);
        if (reachable) {
          repoCopyPairs.push({
            kind: "solution",
            source_repo: sourceAutograder.grader_repo,
            target_repo: solutionTargetRepoFullName,
            assignment_id: newAssignment.id,
            assignment_slug: newAssignment.slug ?? null
          });
        } else {
          addError(
            "solution_repo_verify",
            new Error(
              `Solution repo ${solutionTargetRepoFullName} was not reachable via the GitHub API after creation; will not queue content copy.`
            )
          );
        }
      }

      mark("solution_repo_path_done", {
        solutionRepoCreated: status.solutionRepoCreated,
        queued_for_copy: !!solutionTargetRepoFullName && repoCopyPairs.some((p) => p.kind === "solution")
      });
    }
    mark("repos_done", { repo_copy_pairs: repoCopyPairs.length });
  }

  if (!options.skipSurveys && !wasExisting) {
    mark("surveys_start", {});
    await copyLinkedSurveysForAssignment(
      supabase,
      sourceClass.id,
      sourceAssignment,
      targetClass.id,
      newAssignment,
      newAssignment.release_date ?? undefined,
      newAssignment.due_date ?? undefined,
      status
    );
    mark("surveys_done", { surveys_copied: status.surveysCopied });
  }

  mark("assignment_complete", {
    target_assignment_id: newAssignment.id,
    error_steps: status.errors.map((e) => e.step)
  });

  return { assignmentId: newAssignment.id, status, wasExisting, repoCopyPairs };
}

registerCommand({
  name: "assignments.list",
  requiredScope: "cli:read",
  handler: handleAssignmentsList
});

registerCommand({
  name: "assignments.show",
  requiredScope: "cli:read",
  handler: handleAssignmentsShow
});

registerCommand({
  name: "assignments.delete",
  requiredScope: "cli:write",
  handler: handleAssignmentsDelete
});

registerCommand({
  name: "assignments.copy",
  requiredScope: "cli:write",
  handler: handleAssignmentsCopy
});
