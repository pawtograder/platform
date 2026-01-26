/**
 * Copy assignments command implementation
 *
 * Copies assignments between classes, including:
 * - Assignment record
 * - Rubrics (deep copy)
 * - Autograder configuration
 * - Self-review settings
 * - Git repositories (handout and solution)
 */

import type { ArgumentsCamelCase } from "yargs";
import {
  resolveClass,
  resolveAssignment,
  fetchAssignmentsForClass,
  fetchRubricWithHierarchy,
  fetchSelfReviewSettings,
  fetchAutograderConfig,
  getSupabaseClient
} from "../../utils/db";
import { logger, handleError, CLIError } from "../../utils/logger";
import { parseAssignmentScheduleCsv, normalizeDate } from "../../utils/schedule";
import { cloneAndPushRepo, createTempDir, cleanupTempDir } from "../../utils/git";
import { Class, Assignment, AssignmentCopySpec, CopyResult, RubricWithHierarchy } from "../../types";

interface CopyOptions {
  sourceClass: string;
  targetClass: string;
  assignment?: string;
  schedule?: string;
  all?: boolean;
  dryRun: boolean;
  skipRepos: boolean;
  skipRubrics: boolean;
}

/**
 * Main handler for the copy command
 */
export async function copyAssignmentsHandler(args: ArgumentsCamelCase<CopyOptions>) {
  try {
    // 1. Resolve classes
    logger.step("Resolving classes...");
    const sourceClass = await resolveClass(args.sourceClass);
    const targetClass = await resolveClass(args.targetClass);

    logger.info(`Source: ${sourceClass.name} (${sourceClass.slug})`);
    logger.info(`Target: ${targetClass.name} (${targetClass.slug})`);

    // Validate different classes
    if (sourceClass.id === targetClass.id) {
      throw new CLIError("Source and target classes must be different");
    }

    // Validate target has GitHub org for repo operations
    if (!args.skipRepos && !targetClass.github_org) {
      throw new CLIError("Target class must have a GitHub organization configured (use --skip-repos to skip repo operations)");
    }

    // 2. Determine assignments to copy
    const assignmentsToCopy = await getAssignmentsToCopy(args, sourceClass);
    logger.info(`Found ${assignmentsToCopy.length} assignment(s) to copy`);

    if (assignmentsToCopy.length === 0) {
      logger.warning("No assignments to copy.");
      return;
    }

    // 3. Dry run - just show what would be copied
    if (args.dryRun) {
      logger.step("DRY RUN - No changes will be made");
      logger.blank();
      printDryRunTable(assignmentsToCopy);
      return;
    }

    // 4. Copy each assignment
    const results: CopyResult[] = [];
    for (let i = 0; i < assignmentsToCopy.length; i++) {
      const spec = assignmentsToCopy[i];
      logger.step(`[${i + 1}/${assignmentsToCopy.length}] Copying: ${spec.sourceAssignment.title}`);

      try {
        const result = await copyAssignment(spec, sourceClass, targetClass, args);
        results.push(result);

        if (result.success) {
          logger.success(`Copied: ${spec.sourceAssignment.title} -> ID ${result.newAssignmentId}`);
        } else {
          logger.error(`Failed: ${spec.sourceAssignment.title} - ${result.error}`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to copy ${spec.sourceAssignment.title}: ${errorMsg}`);
        results.push({
          success: false,
          sourceAssignmentId: spec.sourceAssignment.id,
          error: errorMsg
        });
      }
    }

    // 5. Summary
    printSummary(results);
  } catch (error) {
    handleError(error);
  }
}

/**
 * Get the list of assignments to copy based on CLI args
 */
async function getAssignmentsToCopy(args: CopyOptions, sourceClass: Class): Promise<AssignmentCopySpec[]> {
  if (args.schedule) {
    // Parse schedule CSV for slugs/titles and date overrides
    const rows = parseAssignmentScheduleCsv(args.schedule);

    // Fetch all assignments from source class for matching
    const allAssignments = await fetchAssignmentsForClass(sourceClass.id);

    // Build lookup maps
    const bySlug = new Map<string, Assignment>();
    const byTitle = new Map<string, Assignment>();
    for (const a of allAssignments) {
      bySlug.set(a.slug, a);
      byTitle.set(a.title, a);
    }

    // Match all rows first and collect errors
    const specs: AssignmentCopySpec[] = [];
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // CSV row number (1-indexed + header)

      // Normalize dates (converts MM/DD/YY to ISO format)
      const releaseDate = normalizeDate(row.release_date, `Row ${rowNum} release_date`);
      const dueDate = normalizeDate(row.due_date, `Row ${rowNum} due_date`);
      const latestDueDate = normalizeDate(row.latest_due_date, `Row ${rowNum} latest_due_date`);

      // Try to find assignment by slug first, then by title
      let assignment: Assignment | undefined;
      if (row.assignment_slug) {
        assignment = bySlug.get(row.assignment_slug);
        if (!assignment) {
          errors.push(`Row ${rowNum}: No assignment found with slug "${row.assignment_slug}"`);
          continue;
        }
      } else if (row.assignment_title) {
        assignment = byTitle.get(row.assignment_title);
        if (!assignment) {
          errors.push(`Row ${rowNum}: No assignment found with title "${row.assignment_title}"`);
          continue;
        }
      }

      if (assignment) {
        specs.push({
          sourceAssignment: assignment,
          releaseDateOverride: releaseDate,
          dueDateOverride: dueDate,
          latestDueDateOverride: latestDueDate
        });
      }
    }

    // If any rows didn't match, halt with all errors
    if (errors.length > 0) {
      logger.error("CSV contains rows that don't match any assignment in the source class:");
      for (const err of errors) {
        logger.info(`  ${err}`);
      }
      throw new CLIError(`${errors.length} row(s) in CSV did not match any assignment. Fix the CSV and try again.`);
    }

    return specs;
  }

  if (args.assignment) {
    // Single assignment
    const assignment = await resolveAssignment(sourceClass.id, args.assignment);
    return [{ sourceAssignment: assignment }];
  }

  if (args.all) {
    // All assignments
    const assignments = await fetchAssignmentsForClass(sourceClass.id);
    return assignments.map((a) => ({ sourceAssignment: a }));
  }

  throw new CLIError("Must specify --assignment, --schedule, or --all");
}

/**
 * Copy a single assignment
 */
async function copyAssignment(
  spec: AssignmentCopySpec,
  sourceClass: Class,
  targetClass: Class,
  options: CopyOptions
): Promise<CopyResult> {
  const supabase = getSupabaseClient();
  const { sourceAssignment } = spec;

  // Step 1: Copy self-review settings if they exist
  let newSelfReviewSettingId: number | null = null;
  if (sourceAssignment.self_review_setting_id) {
    logger.info("  Copying self-review settings...");
    newSelfReviewSettingId = await copySelfReviewSettings(sourceAssignment.self_review_setting_id, targetClass.id);
  }

  // Step 2: Create the assignment record
  logger.info("  Creating assignment record...");
  const newAssignmentData = {
    class_id: targetClass.id,
    title: sourceAssignment.title,
    slug: sourceAssignment.slug,
    description: sourceAssignment.description,
    release_date: spec.releaseDateOverride || sourceAssignment.release_date,
    due_date: spec.dueDateOverride || sourceAssignment.due_date,
    latest_due_date: spec.latestDueDateOverride || sourceAssignment.latest_due_date,
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
    // These will be populated later
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
    throw new CLIError(`Failed to create assignment: ${assignmentError?.message || "Unknown error"}`);
  }

  // Re-fetch assignment to get any auto-created rubric IDs (triggers may create rubrics)
  const { data: newAssignment, error: refetchError } = await supabase
    .from("assignments")
    .select("*")
    .eq("id", newAssignmentInitial.id)
    .single();

  if (refetchError || !newAssignment) {
    throw new CLIError(`Failed to re-fetch assignment: ${refetchError?.message || "Unknown error"}`);
  }

  // Step 3: Copy rubrics if enabled
  if (!options.skipRubrics) {
    // Log source and target rubric IDs for debugging
    logger.info(
      `  Source rubric IDs: grading=${sourceAssignment.grading_rubric_id || "none"}, self_review=${sourceAssignment.self_review_rubric_id || "none"}, meta=${sourceAssignment.meta_grading_rubric_id || "none"}`
    );
    logger.info(
      `  Target rubric IDs (auto-created): grading=${newAssignment.grading_rubric_id || "none"}, self_review=${newAssignment.self_review_rubric_id || "none"}, meta=${newAssignment.meta_grading_rubric_id || "none"}`
    );

    if (sourceAssignment.grading_rubric_id) {
      logger.info("  Copying grading rubric...");
      // Use existing auto-created rubric if available, otherwise create new
      await copyRubricTree(
        sourceAssignment.grading_rubric_id,
        newAssignment.id,
        targetClass.id,
        newAssignment.grading_rubric_id || undefined
      );
      logger.info(`    Rubric ID: ${newAssignment.grading_rubric_id || "created new"}`);
    }

    if (sourceAssignment.self_review_rubric_id) {
      logger.info("  Copying self-review rubric...");
      await copyRubricTree(
        sourceAssignment.self_review_rubric_id,
        newAssignment.id,
        targetClass.id,
        newAssignment.self_review_rubric_id || undefined
      );
      logger.info(`    Rubric ID: ${newAssignment.self_review_rubric_id || "created new"}`);
    }

    if (sourceAssignment.meta_grading_rubric_id) {
      logger.info("  Copying meta-grading rubric...");
      // Meta rubric is typically not auto-created, so create new
      const newMetaRubricId = await copyRubricTree(
        sourceAssignment.meta_grading_rubric_id,
        newAssignment.id,
        targetClass.id,
        newAssignment.meta_grading_rubric_id || undefined
      );
      // Update assignment with meta rubric ID if it was newly created
      if (!newAssignment.meta_grading_rubric_id && newMetaRubricId) {
        await supabase
          .from("assignments")
          .update({ meta_grading_rubric_id: newMetaRubricId })
          .eq("id", newAssignment.id);
      }
      logger.info(`    Rubric ID: ${newAssignment.meta_grading_rubric_id || newMetaRubricId}`);
    }

    logger.success("  Rubrics copied successfully");
  } else {
    logger.info("  Skipping rubrics (--skip-rubrics flag)");
  }

  // Step 4: Copy autograder config if it exists
  if (sourceAssignment.has_autograder) {
    logger.info("  Copying autograder configuration...");
    await copyAutograderConfig(sourceAssignment.id, newAssignment.id, targetClass.id);
  }

  // Step 5: Copy git repositories
  if (!options.skipRepos) {
    await copyRepositories(sourceAssignment, newAssignment, sourceClass, targetClass);
  }

  return {
    success: true,
    sourceAssignmentId: sourceAssignment.id,
    newAssignmentId: newAssignment.id
  };
}

/**
 * Copy self-review settings
 */
async function copySelfReviewSettings(sourceSettingsId: number, targetClassId: number): Promise<number> {
  const supabase = getSupabaseClient();
  const sourceSettings = await fetchSelfReviewSettings(sourceSettingsId);

  if (!sourceSettings) {
    throw new CLIError(`Self-review settings not found: ${sourceSettingsId}`);
  }

  const { data: newSettings, error } = await supabase
    .from("assignment_self_review_settings")
    .insert({
      class_id: targetClassId,
      enabled: sourceSettings.enabled,
      allow_early: sourceSettings.allow_early,
      deadline_offset: sourceSettings.deadline_offset
    })
    .select("id")
    .single();

  if (error || !newSettings) {
    throw new CLIError(`Failed to copy self-review settings: ${error?.message || "Unknown error"}`);
  }

  return newSettings.id;
}

/**
 * Deep copy a rubric with all its parts, criteria, checks, and check references.
 * Builds ID mappings to ensure all foreign keys are correctly updated.
 *
 * If existingRubricId is provided, the existing rubric's content will be cleared
 * and replaced with the source rubric's content (upsert behavior).
 *
 * @param sourceRubricId - ID of the rubric to copy from
 * @param newAssignmentId - ID of the new assignment
 * @param targetClassId - ID of the target class
 * @param existingRubricId - Optional ID of an existing rubric to update instead of creating new
 * @returns The rubric ID (existing or newly created)
 */
async function copyRubricTree(
  sourceRubricId: number,
  newAssignmentId: number,
  targetClassId: number,
  existingRubricId?: number
): Promise<number> {
  const supabase = getSupabaseClient();
  const sourceRubric = await fetchRubricWithHierarchy(sourceRubricId);

  if (!sourceRubric) {
    throw new CLIError(`Rubric not found: ${sourceRubricId}`);
  }

  // ID mappings: old ID -> new ID
  const partIdMap = new Map<number, number>();
  const criteriaIdMap = new Map<number, number>();
  const checkIdMap = new Map<number, number>();

  // Count items for logging
  const partCount = sourceRubric.rubric_parts?.length || 0;
  let criteriaCount = 0;
  let checkCount = 0;
  for (const part of sourceRubric.rubric_parts || []) {
    criteriaCount += part.rubric_criteria?.length || 0;
    for (const criteria of part.rubric_criteria || []) {
      checkCount += criteria.rubric_checks?.length || 0;
    }
  }
  logger.info(`    Source rubric "${sourceRubric.name}": ${partCount} parts, ${criteriaCount} criteria, ${checkCount} checks`);

  let targetRubricId: number;

  if (existingRubricId) {
    // Use existing rubric - clear its contents first
    logger.info(`    Using existing rubric ID ${existingRubricId}, clearing contents...`);

    // Delete in reverse order of dependencies: references -> checks -> criteria -> parts
    await supabase.from("rubric_check_references").delete().eq("rubric_id", existingRubricId);
    await supabase.from("rubric_checks").delete().eq("rubric_id", existingRubricId);
    await supabase.from("rubric_criteria").delete().eq("rubric_id", existingRubricId);
    await supabase.from("rubric_parts").delete().eq("rubric_id", existingRubricId);

    // Update rubric metadata
    const { error: updateError } = await supabase
      .from("rubrics")
      .update({
        name: sourceRubric.name,
        description: sourceRubric.description,
        cap_score_to_assignment_points: sourceRubric.cap_score_to_assignment_points,
        is_private: sourceRubric.is_private,
        review_round: sourceRubric.review_round
      })
      .eq("id", existingRubricId);

    if (updateError) {
      throw new CLIError(`Failed to update rubric: ${updateError.message}`);
    }

    targetRubricId = existingRubricId;
  } else {
    // Create new rubric
    const { data: newRubric, error: rubricError } = await supabase
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

    if (rubricError || !newRubric) {
      throw new CLIError(`Failed to create rubric: ${rubricError?.message || "Unknown error"}`);
    }

    targetRubricId = newRubric.id;
  }

  // Copy parts
  for (const part of sourceRubric.rubric_parts || []) {
    const { data: newPart, error: partError } = await supabase
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

    if (partError || !newPart) {
      throw new CLIError(`Failed to create rubric part: ${partError?.message || "Unknown error"}`);
    }

    // Track part ID mapping
    partIdMap.set(part.id, newPart.id);

    // Copy criteria
    for (const criteria of part.rubric_criteria || []) {
      const { data: newCriteria, error: criteriaError } = await supabase
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

      if (criteriaError || !newCriteria) {
        throw new CLIError(`Failed to create rubric criteria: ${criteriaError?.message || "Unknown error"}`);
      }

      // Track criteria ID mapping
      criteriaIdMap.set(criteria.id, newCriteria.id);

      // Copy checks
      for (const check of criteria.rubric_checks || []) {
        const { data: newCheck, error: checkError } = await supabase
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

        if (checkError || !newCheck) {
          throw new CLIError(`Failed to create rubric check: ${checkError?.message || "Unknown error"}`);
        }

        // Track check ID mapping
        checkIdMap.set(check.id, newCheck.id);
      }
    }
  }

  // Copy rubric_check_references (dependencies between checks)
  const { data: checkReferences, error: refFetchError } = await supabase
    .from("rubric_check_references")
    .select("*")
    .eq("rubric_id", sourceRubricId);

  if (refFetchError) {
    logger.warning(`    Warning: Failed to fetch check references: ${refFetchError.message}`);
  } else if (checkReferences && checkReferences.length > 0) {
    logger.info(`    Copying ${checkReferences.length} check references...`);

    for (const ref of checkReferences) {
      const newReferencedId = checkIdMap.get(ref.referenced_rubric_check_id);
      const newReferencingId = checkIdMap.get(ref.referencing_rubric_check_id);

      if (!newReferencedId || !newReferencingId) {
        logger.warning(`    Warning: Could not map check reference IDs (${ref.referenced_rubric_check_id} -> ${ref.referencing_rubric_check_id})`);
        continue;
      }

      const { error: refError } = await supabase.from("rubric_check_references").insert({
        assignment_id: newAssignmentId,
        class_id: targetClassId,
        rubric_id: targetRubricId,
        referenced_rubric_check_id: newReferencedId,
        referencing_rubric_check_id: newReferencingId
      });

      if (refError) {
        logger.warning(`    Warning: Failed to copy check reference: ${refError.message}`);
      }
    }
  }

  logger.info(`    Copied ${partCount} parts, ${criteriaCount} criteria, ${checkCount} checks -> rubric ID ${targetRubricId}`);
  return targetRubricId;
}

/**
 * Copy autograder configuration
 * Checks if record exists first to handle re-runs gracefully
 */
async function copyAutograderConfig(
  sourceAssignmentId: number,
  newAssignmentId: number,
  targetClassId: number
): Promise<void> {
  const supabase = getSupabaseClient();
  const sourceConfig = await fetchAutograderConfig(sourceAssignmentId);

  if (!sourceConfig) {
    // No autograder config to copy
    return;
  }

  // Check if autograder record already exists (from previous run)
  const { data: existing } = await supabase.from("autograder").select("id").eq("id", newAssignmentId).single();

  if (existing) {
    // Update existing record with config values (preserve grader_repo if already set)
    const { error } = await supabase
      .from("autograder")
      .update({
        config: sourceConfig.config,
        max_submissions_count: sourceConfig.max_submissions_count,
        max_submissions_period_secs: sourceConfig.max_submissions_period_secs
      })
      .eq("id", newAssignmentId);

    if (error) {
      throw new CLIError(`Failed to update autograder config: ${error.message}`);
    }
  } else {
    // Insert new record
    const { error } = await supabase.from("autograder").insert({
      id: newAssignmentId,
      class_id: targetClassId,
      config: sourceConfig.config,
      max_submissions_count: sourceConfig.max_submissions_count,
      max_submissions_period_secs: sourceConfig.max_submissions_period_secs,
      grader_repo: null,
      grader_commit_sha: null,
      workflow_sha: null,
      latest_autograder_sha: null
    });

    if (error) {
      throw new CLIError(`Failed to copy autograder config: ${error.message}`);
    }
  }
}

/**
 * Call edge function to create handout repo
 */
async function createHandoutRepoViaEdgeFunction(assignmentId: number, classId: number): Promise<string> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.functions.invoke("assignment-create-handout-repo", {
    body: { assignment_id: assignmentId, class_id: classId }
  });

  if (error) {
    throw new CLIError(`Failed to create handout repo via edge function: ${error.message}`);
  }

  if (data?.error) {
    throw new CLIError(`Failed to create handout repo: ${data.error.message}`);
  }

  // Return the full repo name (org/repo)
  return `${data.org_name}/${data.repo_name}`;
}

/**
 * Call edge function to create solution repo
 */
async function createSolutionRepoViaEdgeFunction(assignmentId: number, classId: number): Promise<string> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.functions.invoke("assignment-create-solution-repo", {
    body: { assignment_id: assignmentId, class_id: classId }
  });

  if (error) {
    throw new CLIError(`Failed to create solution repo via edge function: ${error.message}`);
  }

  if (data?.error) {
    throw new CLIError(`Failed to create solution repo: ${data.error.message}`);
  }

  // Return the full repo name (org/repo)
  return `${data.org_name}/${data.repo_name}`;
}

/**
 * Copy git repositories (handout and solution)
 *
 * Flow:
 * 1. Call edge function to create target repo (this uses GitHub App auth)
 * 2. Clone source repo locally
 * 3. Force push to newly created target repo
 */
async function copyRepositories(
  sourceAssignment: Assignment,
  newAssignment: Assignment,
  sourceClass: Class,
  targetClass: Class
): Promise<void> {
  // Copy handout repo
  if (sourceAssignment.template_repo) {
    logger.info("  Creating handout repository via edge function...");

    // Create the target repo via edge function (this handles GitHub App auth)
    const targetRepoFullName = await createHandoutRepoViaEdgeFunction(newAssignment.id, targetClass.id);
    logger.info(`    Created: ${targetRepoFullName}`);

    // Wait a moment for GitHub to fully provision the repo
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Now clone source and push to target
    logger.info("  Pushing source content to handout repository...");
    const tempDir = await createTempDir("pawtograder-copy-handout-");
    try {
      await cloneAndPushRepo(sourceAssignment.template_repo, targetRepoFullName, tempDir);
      logger.success(`  Handout repo: ${targetRepoFullName}`);
    } finally {
      await cleanupTempDir(tempDir);
    }
  }

  // Copy solution repo
  if (sourceAssignment.has_autograder) {
    const sourceAutograder = await fetchAutograderConfig(sourceAssignment.id);
    if (sourceAutograder?.grader_repo) {
      logger.info("  Creating solution repository via edge function...");

      // Create the target repo via edge function
      const targetRepoFullName = await createSolutionRepoViaEdgeFunction(newAssignment.id, targetClass.id);
      logger.info(`    Created: ${targetRepoFullName}`);

      // Wait a moment for GitHub to fully provision the repo
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Now clone source and push to target
      logger.info("  Pushing source content to solution repository...");
      const tempDir = await createTempDir("pawtograder-copy-solution-");
      try {
        await cloneAndPushRepo(sourceAutograder.grader_repo, targetRepoFullName, tempDir);
        logger.success(`  Solution repo: ${targetRepoFullName}`);
      } finally {
        await cleanupTempDir(tempDir);
      }
    }
  }
}

/**
 * Print a dry-run summary table
 */
function printDryRunTable(assignments: AssignmentCopySpec[]): void {
  logger.tableHeader(["Slug", "Title", "Release Date", "Due Date"]);

  for (const spec of assignments) {
    const a = spec.sourceAssignment;
    const releaseDate = spec.releaseDateOverride || a.release_date || "-";
    const dueDate = spec.dueDateOverride || a.due_date || "-";
    logger.tableRow([a.slug, a.title, releaseDate, dueDate]);
  }

  logger.blank();
}

/**
 * Print final summary
 */
function printSummary(results: CopyResult[]): void {
  logger.step("Summary");

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  logger.info(`Succeeded: ${succeeded}`);
  if (failed > 0) {
    logger.warning(`Failed: ${failed}`);

    logger.blank();
    logger.error("Failed assignments:");
    for (const r of results.filter((r) => !r.success)) {
      logger.info(`  - Source ID ${r.sourceAssignmentId}: ${r.error}`);
    }
  }
}
