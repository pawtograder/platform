/**
 * Assignment copy command - calls the CLI edge function
 *
 * Handles CSV schedule parsing locally, then sends the schedule data
 * to the edge function which performs all DB and GitHub operations.
 */

import * as fs from "fs";
import { callCLI } from "../../utils/api";
import { logger, handleError, CLIError } from "../../utils/logger";
import { parseAssignmentScheduleCsv } from "../../utils/schedule";

export async function copyAssignmentsHandler(args: any): Promise<void> {
  try {
    const sourceClass = args.sourceClass as string;
    const targetClass = args.targetClass as string;
    const assignment = args.assignment as string | undefined;
    const schedulePath = args.schedule as string | undefined;
    const all = args.all as boolean;
    const dryRun = args.dryRun as boolean;
    const skipRepos = args.skipRepos as boolean;
    const skipRubrics = args.skipRubrics as boolean;

    logger.step("Copying assignments...");
    logger.info(`Source: ${sourceClass}`);
    logger.info(`Target: ${targetClass}`);

    // Build params for the edge function
    const params: Record<string, unknown> = {
      source_class: sourceClass,
      target_class: targetClass,
      dry_run: dryRun,
      skip_repos: skipRepos,
      skip_rubrics: skipRubrics
    };

    if (assignment) {
      params.assignment = assignment;
    } else if (all) {
      params.all = true;
    } else if (schedulePath) {
      // Parse the CSV locally and send the schedule as data
      if (!fs.existsSync(schedulePath)) {
        throw new CLIError(`Schedule file not found: ${schedulePath}`);
      }
      const schedule = await parseAssignmentScheduleCsv(schedulePath);
      params.schedule = schedule;
    }

    const data = await callCLI("assignments.copy", params);

    if (data.dry_run) {
      logger.step("DRY RUN - No changes will be made");
      logger.blank();
      logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
      logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
      logger.blank();
      logger.tableHeader(["Slug", "Title", "Release Date", "Due Date"]);
      for (const a of data.assignments_to_copy) {
        logger.tableRow([a.slug, a.title, a.release_date || "-", a.due_date || "-"]);
      }
      return;
    }

    // Show results
    logger.blank();
    logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
    logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
    logger.blank();

    for (const result of data.results) {
      if (result.success) {
        logger.success(`${result.source_title} (${result.source_slug}) → ID ${result.new_assignment_id}`);
      } else {
        logger.error(`${result.source_title} (${result.source_slug}): ${result.error}`);
      }
    }

    logger.blank();
    logger.step("Copy Summary");
    logger.info(`Total: ${data.summary.total}`);
    logger.info(`Succeeded: ${data.summary.succeeded}`);
    if (data.summary.failed > 0) {
      logger.warning(`Failed: ${data.summary.failed}`);
    }
  } catch (error) {
    handleError(error);
  }
}
