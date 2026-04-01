/**
 * Copy assignments command implementation
 *
 * Sends a copy request to the CLI edge function, which handles:
 * - Assignment record creation
 * - Rubrics (deep copy)
 * - Autograder configuration
 * - Self-review settings
 * - Git repositories (handout and solution)
 */

import type { ArgumentsCamelCase } from "yargs";
import { apiCall } from "../../utils/api";
import { logger, handleError } from "../../utils/logger";
import { parseAssignmentScheduleCsv, normalizeDate } from "../../utils/schedule";

interface CopyOptions {
  sourceClass: string;
  targetClass: string;
  assignment?: string;
  schedule?: string;
  all?: boolean;
  dryRun: boolean;
  skipRepos: boolean;
  skipRubrics: boolean;
  skipSurveys: boolean;
}

/**
 * Main handler for the copy command
 */
export async function copyAssignmentsHandler(args: ArgumentsCamelCase<CopyOptions>) {
  try {
    logger.step("Preparing assignment copy...");

    const params: Record<string, unknown> = {
      source_class: args.sourceClass,
      target_class: args.targetClass,
      dry_run: args.dryRun,
      skip_repos: args.skipRepos,
      skip_rubrics: args.skipRubrics,
      skip_surveys: args.skipSurveys
    };

    if (args.assignment) {
      params.assignment = args.assignment;
    } else if (args.all) {
      params.all = true;
    } else if (args.schedule) {
      // Read and parse CSV locally, send parsed data to edge function
      const rows = parseAssignmentScheduleCsv(args.schedule);
      const schedule = rows.map((row, i) => ({
        assignment_slug: row.assignment_slug,
        assignment_title: row.assignment_title,
        release_date: normalizeDate(row.release_date, `Row ${i + 2} release_date`),
        due_date: normalizeDate(row.due_date, `Row ${i + 2} due_date`)
      }));
      params.schedule = schedule;
    }

    const assignmentCount = params.assignment ? 1 : params.schedule ? (params.schedule as unknown[]).length : undefined;
    logger.info(
      `Sending request to ${params.source_class} → ${params.target_class}${assignmentCount ? ` (${assignmentCount} assignment${assignmentCount > 1 ? "s" : ""})` : ""}...`
    );
    logger.info("   This may take several minutes (copying repos, rubrics, etc.). Please wait.");
    const data = await apiCall("assignments.copy", params);

    if (data.dry_run) {
      logger.step("DRY RUN - No changes will be made");
      logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
      logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
      logger.blank();

      logger.tableHeader(["Slug", "Title", "Release", "Due", "Linked surveys"]);
      for (const a of data.assignments_to_copy) {
        const n = Array.isArray(a.linked_surveys) ? a.linked_surveys.length : 0;
        logger.tableRow([a.slug, a.title, a.release_date || "-", a.due_date || "-", String(n)]);
      }
      logger.blank();
      return;
    }

    // Show results
    logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
    logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
    logger.blank();

    for (const r of data.results) {
      const existingLabel = r.was_existing ? " (existing, validated/fixed)" : "";
      if (r.success) {
        logger.success(`Copied: ${r.source_title} -> ID ${r.new_assignment_id}${existingLabel}`);
      } else {
        logger.error(`Failed: ${r.source_title} - ${r.error}`);
        if (r.status?.errors?.length) {
          for (const e of r.status.errors) {
            logger.info(`  - ${e.step}: ${e.error}`);
          }
        }
      }
    }

    // Summary
    logger.step("Summary");
    logger.info(`Total: ${data.summary.total}`);
    logger.info(`Succeeded: ${data.summary.succeeded}`);
    if (data.summary.failed > 0) {
      logger.warning(`Failed: ${data.summary.failed}`);
    }
  } catch (error) {
    handleError(error);
  }
}
