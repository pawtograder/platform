/**
 * Copy assignments command implementation
 *
 * Sends a copy request to the CLI edge function, which handles:
 * - Assignment record creation
 * - Rubrics (deep copy)
 * - Autograder configuration
 * - Self-review settings
 * - Synchronously creating empty handout/solution repos from GitHub templates
 *
 * After the edge function returns, this handler performs the handout/solution repo
 * content copy *locally* via SSH `git clone` + `rsync` + `git push`, because the
 * Edge Function's REST-API copy path is subject to Supabase timeouts and GitHub
 * tree-size limits. See `cli/lib/assignments/copyAssignmentRepos.ts`.
 */

import type { ArgumentsCamelCase } from "yargs";
import { apiCall } from "../../utils/api";
import { logger, handleError } from "../../utils/logger";
import { parseAssignmentScheduleCsv, normalizeDate } from "../../utils/schedule";
import { runCopyAssignmentRepos } from "../../lib/assignments/copyAssignmentRepos";
import type { RepoCopyPair } from "../../lib/assignments/types";

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
  /** Server-side timing logs in the CLI edge function */
  debug?: boolean;
  /** Local directory used for SSH git clones of handout/solution source+target repos */
  workdir?: string;
  concurrency?: number;
  delayMs?: number;
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
    if (args.debug) {
      params.debug = true;
    }

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
        due_date: normalizeDate(row.due_date, `Row ${i + 2} due_date`),
        latest_due_date: normalizeDate(row.latest_due_date, `Row ${i + 2} latest_due_date`)
      }));
      params.schedule = schedule;
    }

    const assignmentCount = params.assignment ? 1 : params.schedule ? (params.schedule as unknown[]).length : undefined;
    logger.info(
      `Sending request to ${params.source_class} → ${params.target_class}${assignmentCount ? ` (${assignmentCount} assignment${assignmentCount > 1 ? "s" : ""})` : ""}...`
    );
    logger.info("   Server is copying DB rows, rubrics, autograder, surveys, and creating empty repos.");
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

    // Show server-side results
    logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
    logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
    logger.blank();

    for (const r of data.results) {
      const existingLabel = r.was_existing ? " (existing, validated/fixed)" : "";
      if (r.success) {
        logger.success(`Prepared: ${r.source_title} -> ID ${r.new_assignment_id}${existingLabel}`);
      } else {
        logger.error(`Failed: ${r.source_title} - ${r.error}`);
        if (r.status?.errors?.length) {
          for (const e of r.status.errors) {
            logger.info(`  - ${e.step}: ${e.error}`);
          }
        }
      }
    }

    const serverCopyHadFailures = data.summary.failed > 0 || data.results.some((row) => !row.success);
    if (serverCopyHadFailures) {
      process.exitCode = 1;
    }

    // Local repo content copy (via SSH git) — skipped if --skip-repos.
    const repoPairs = (data.repo_copy_pairs as RepoCopyPair[] | undefined) ?? [];
    if (args.skipRepos) {
      if (repoPairs.length > 0) {
        logger.info(`Skipping local repo copy for ${repoPairs.length} pair(s) (--skip-repos).`);
      }
    } else if (repoPairs.length === 0) {
      logger.info("No handout/solution repos queued for content copy.");
    } else if (!args.workdir) {
      logger.error("No --workdir provided; cannot run local repo copy. Re-run with --workdir <path> or --skip-repos.");
      process.exitCode = 1;
    } else {
      logger.step(
        `Copying repo contents locally via SSH git (${repoPairs.length} pair${repoPairs.length > 1 ? "s" : ""})...`
      );
      const concurrency = Math.min(8, Math.max(1, Number(args.concurrency) || 4));
      const delayMs = Math.max(0, Number(args.delayMs) || 0);

      const { result } = await runCopyAssignmentRepos(repoPairs, {
        workDir: args.workdir,
        dryRun: args.dryRun,
        concurrency,
        delayMs
      });

      if (result.errors > 0 || result.cloneFailures > 0) {
        process.exitCode = 1;
      }
    }

    // Combined summary
    logger.step("Summary");
    logger.info(`Total assignments: ${data.summary.total}`);
    logger.info(`Succeeded (server): ${data.summary.succeeded}`);
    if (data.summary.failed > 0) {
      logger.warning(`Failed (server): ${data.summary.failed}`);
    }
    if (repoPairs.length > 0) {
      logger.info(`Repo pairs queued: ${repoPairs.length}`);
    }
  } catch (error) {
    handleError(error);
  }
}
