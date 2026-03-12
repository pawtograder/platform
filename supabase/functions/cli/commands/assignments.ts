/**
 * Assignments commands - list, show, copy, delete.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { Database } from "../../_shared/SupabaseTypes.d.ts";
import type { MCPAuthContext } from "../../_shared/MCPAuth.ts";
import { registerCommand } from "../router.ts";
import { getAdminClient } from "../utils/supabase.ts";
import { resolveClass, resolveAssignment } from "../utils/resolvers.ts";
import { copyRubricTree } from "../utils/rubric.ts";
import { repoExistsOnGitHub, copyRepoContentsViaGitHub, targetRepoHasContentFromSource } from "../utils/github.ts";
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
  ClassRow,
  AssignmentRow
} from "../types.ts";

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

async function handleAssignmentsCopy(ctx: MCPAuthContext, params: Record<string, unknown>): Promise<CLIResponse> {
  const p = params as unknown as AssignmentsCopyParams;
  const sourceClassId = p.source_class;
  const targetClassId = p.target_class;
  const assignmentIdentifier = p.assignment;
  const copyAll = p.all === true;
  const dryRun = p.dry_run === true;
  const skipRepos = p.skip_repos === true;
  const skipRubrics = p.skip_rubrics === true;
  const schedule = p.schedule;

  if (!sourceClassId) throw new CLICommandError("source_class is required");
  if (!targetClassId) throw new CLICommandError("target_class is required");

  const specifiedCount = [assignmentIdentifier, schedule, copyAll].filter(Boolean).length;
  if (specifiedCount !== 1) {
    throw new CLICommandError("Must specify exactly one of: assignment, schedule, or all");
  }

  const supabase = getAdminClient();
  const sourceClass = await resolveClass(supabase, sourceClassId);
  const targetClass = await resolveClass(supabase, targetClassId);

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
      assignmentsToCopy.push({
        assignment,
        releaseDateOverride: row.release_date,
        dueDateOverride: row.due_date
      });
    }
  }

  if (assignmentsToCopy.length === 0) {
    throw new CLICommandError("No assignments to copy");
  }

  if (dryRun) {
    return {
      success: true,
      data: {
        dry_run: true,
        source_class: { id: sourceClass.id, slug: sourceClass.slug, name: sourceClass.name },
        target_class: { id: targetClass.id, slug: targetClass.slug, name: targetClass.name },
        assignments_to_copy: assignmentsToCopy.map((s) => ({
          slug: s.assignment.slug,
          title: s.assignment.title,
          release_date: s.releaseDateOverride ?? s.assignment.release_date,
          due_date: s.dueDateOverride ?? s.assignment.due_date
        }))
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
    error?: string;
  }> = [];

  for (const spec of assignmentsToCopy) {
    try {
      const result = await copySingleAssignment(supabase, spec.assignment, sourceClass, targetClass, {
        skipRepos,
        skipRubrics,
        releaseDateOverride: spec.releaseDateOverride,
        dueDateOverride: spec.dueDateOverride
      });
      const hasErrors = result.status.errors.length > 0;
      results.push({
        source_slug: spec.assignment.slug,
        source_title: spec.assignment.title,
        success: !hasErrors,
        new_assignment_id: result.assignmentId,
        was_existing: result.wasExisting,
        status: result.status,
        error: hasErrors ? result.status.errors.map((e) => `${e.step}: ${e.error}`).join("; ") : undefined
      });
    } catch (err) {
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
    releaseDateOverride?: string;
    dueDateOverride?: string;
  }
): Promise<CopyResult> {
  const status: CopyStatus = {
    assignmentCreated: false,
    selfReviewSettingsCopied: false,
    rubricsCopied: false,
    autograderConfigCopied: false,
    handoutRepoCreated: false,
    handoutRepoContentsCopied: false,
    solutionRepoCreated: false,
    solutionRepoContentsCopied: false,
    errors: []
  };

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

  if (!options.skipRubrics) {
    try {
      if (sourceAssignment.grading_rubric_id) {
        await copyRubricTree(
          supabase,
          sourceAssignment.grading_rubric_id,
          newAssignment.id,
          targetClass.id,
          newAssignment.grading_rubric_id ?? undefined
        );
      }
      if (sourceAssignment.self_review_rubric_id) {
        await copyRubricTree(
          supabase,
          sourceAssignment.self_review_rubric_id,
          newAssignment.id,
          targetClass.id,
          newAssignment.self_review_rubric_id ?? undefined
        );
      }
      if (sourceAssignment.meta_grading_rubric_id) {
        const newMetaRubricId = await copyRubricTree(
          supabase,
          sourceAssignment.meta_grading_rubric_id,
          newAssignment.id,
          targetClass.id,
          newAssignment.meta_grading_rubric_id ?? undefined
        );
        if (!newAssignment.meta_grading_rubric_id && newMetaRubricId) {
          await supabase
            .from("assignments")
            .update({ meta_grading_rubric_id: newMetaRubricId })
            .eq("id", newAssignment.id);
        }
      }
      status.rubricsCopied = true;
    } catch (err) {
      addError("rubrics", err);
    }
  }

  if (sourceAssignment.has_autograder) {
    try {
      const { data: sourceConfig } = await supabase
        .from("autograder")
        .select("*")
        .eq("id", sourceAssignment.id)
        .single();

      if (sourceConfig) {
        const { data: existing } = await supabase
          .from("autograder")
          .select("id, grader_repo")
          .eq("id", newAssignment.id)
          .single();

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
  }

  if (!options.skipRepos && targetClass.github_org) {
    if (sourceAssignment.template_repo) {
      const handoutRepoExists = !!newAssignment.template_repo;
      const handoutContentsCopied =
        handoutRepoExists && newAssignment.template_repo
          ? await targetRepoHasContentFromSource(sourceAssignment.template_repo, newAssignment.template_repo)
          : false;

      if (!handoutRepoExists) {
        try {
          const { data: handoutData } = await supabase.functions.invoke("assignment-create-handout-repo", {
            body: { assignment_id: newAssignment.id, class_id: targetClass.id }
          });

          const hd = handoutData as { error?: unknown; org_name?: string; repo_name?: string } | null;
          if (hd?.error) {
            addError("handout_repo_create", hd.error);
          } else if (hd?.org_name && hd?.repo_name) {
            status.handoutRepoCreated = true;
            const targetRepoFullName = `${hd.org_name}/${hd.repo_name}`;
            try {
              await copyRepoContentsViaGitHub(sourceAssignment.template_repo, targetRepoFullName);
              status.handoutRepoContentsCopied = true;
            } catch (err) {
              addError("handout_repo_contents", err);
            }
          }
        } catch (err) {
          addError("handout_repo_create", err);
        }
      } else if (!handoutContentsCopied && newAssignment.template_repo) {
        status.handoutRepoCreated = true;
        try {
          await copyRepoContentsViaGitHub(sourceAssignment.template_repo, newAssignment.template_repo);
          status.handoutRepoContentsCopied = true;
        } catch (err) {
          addError("handout_repo_contents", err);
        }
      } else {
        status.handoutRepoCreated = true;
        status.handoutRepoContentsCopied = true;
      }
    }

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
      let solutionContentsCopied = false;
      if (targetRepoSet && targetAutograder?.grader_repo) {
        targetRepoExists = await repoExistsOnGitHub(targetAutograder.grader_repo);
        solutionContentsCopied = await targetRepoHasContentFromSource(
          sourceAutograder.grader_repo,
          targetAutograder.grader_repo
        );
      }

      const needsSolution = !targetRepoSet || !targetRepoExists;
      if (needsSolution) {
        try {
          const { data: solutionData } = await supabase.functions.invoke("assignment-create-solution-repo", {
            body: { assignment_id: newAssignment.id, class_id: targetClass.id }
          });

          const sd = solutionData as { error?: unknown; org_name?: string; repo_name?: string } | null;
          if (sd?.error) {
            addError("solution_repo_create", sd.error);
          } else if (sd?.org_name && sd?.repo_name) {
            const targetRepoFullName = `${sd.org_name}/${sd.repo_name}`;

            const { data: afterCreate } = await supabase
              .from("autograder")
              .select("grader_repo")
              .eq("id", newAssignment.id)
              .single();

            if (!afterCreate?.grader_repo) {
              await supabase.from("autograder").update({ grader_repo: targetRepoFullName }).eq("id", newAssignment.id);
            }
            status.solutionRepoCreated = true;

            try {
              await copyRepoContentsViaGitHub(sourceAutograder.grader_repo, targetRepoFullName);
              status.solutionRepoContentsCopied = true;
            } catch (err) {
              addError("solution_repo_contents", err);
            }
          }
        } catch (err) {
          addError("solution_repo_create", err);
        }
      } else if (!solutionContentsCopied && targetAutograder?.grader_repo) {
        status.solutionRepoCreated = true;
        try {
          await copyRepoContentsViaGitHub(sourceAutograder.grader_repo, targetAutograder.grader_repo);
          status.solutionRepoContentsCopied = true;
        } catch (err) {
          addError("solution_repo_contents", err);
        }
      } else {
        status.solutionRepoCreated = true;
        status.solutionRepoContentsCopied = true;
      }
    }
  }

  return { assignmentId: newAssignment.id, status, wasExisting };
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
