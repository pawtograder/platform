/**
 * Delete assignment command implementation
 *
 * Permanently deletes an assignment and all associated data including:
 * - All student repositories from GitHub
 * - Handout repository (template) from GitHub
 * - Solution repository (grader) from GitHub
 * - All submissions and grading results
 * - All assignment groups, invitations, and join requests
 * - All due date exceptions and late tokens
 * - All review assignments and submission reviews
 * - All gradebook columns and their dependencies
 * - All autograder configurations
 * - The assignment itself
 */

import type { ArgumentsCamelCase } from "yargs";
import * as readline from "readline";
import { apiCall } from "../../utils/api";
import { logger, handleError } from "../../utils/logger";

interface DeleteOptions {
  class: string;
  identifier: string;
  force?: boolean;
}

/**
 * Main handler for the delete command
 */
export async function deleteAssignmentHandler(args: ArgumentsCamelCase<DeleteOptions>) {
  try {
    // 1. Fetch assignment details for confirmation
    logger.step("Resolving class and assignment...");
    const showData = await apiCall("assignments.show", {
      class: args.class,
      identifier: args.identifier
    });
    const assignment = showData.assignment;
    const classInfo = showData.class;

    logger.info(`Class: ${classInfo.name} (${classInfo.slug})`);
    logger.info(`Assignment: ${assignment.title} (${assignment.slug})`);
    logger.info(`Assignment ID: ${assignment.id}`);
    logger.blank();

    // 2. Show warning information
    printDeleteWarning(assignment);

    // 3. Confirm deletion unless --force is specified
    if (!args.force) {
      const confirmed = await confirmDeletion(assignment.title);
      if (!confirmed) {
        logger.info("Deletion cancelled.");
        return;
      }
    } else {
      logger.warning("--force specified, skipping confirmation");
    }

    // 4. Call the edge function to delete the assignment
    logger.step("Deleting assignment...");
    const data = await apiCall("assignments.delete", {
      class: args.class as string,
      identifier: args.identifier as string
    });

    logger.success(data.message || `Assignment "${assignment.title}" has been successfully deleted.`);
  } catch (error) {
    handleError(error);
  }
}

/**
 * Print warning information about what will be deleted
 */
function printDeleteWarning(assignment: { template_repo?: string; has_autograder?: boolean }): void {
  logger.warning("WARNING: This action is PERMANENT and CANNOT be undone!");
  logger.blank();

  logger.info("Before deletion, the system will check:");
  logger.info("  - If any student repository has a commit beyond the initial commit");
  logger.info("  - If checks fail, deletion will be aborted");
  logger.blank();

  logger.info("If checks pass, ALL related data will be PERMANENTLY deleted:");
  logger.info("  - All student repositories from GitHub");
  if (assignment.template_repo) {
    logger.info(`  - Handout repository: ${assignment.template_repo}`);
  }
  if (assignment.has_autograder) {
    logger.info("  - Solution repository (grader) from GitHub");
  }
  logger.info("  - All submissions and grading results");
  logger.info("  - All assignment groups, invitations, and join requests");
  logger.info("  - All due date exceptions and late tokens");
  logger.info("  - All review assignments and submission reviews");
  logger.info("  - All gradebook columns and their dependencies");
  logger.info("  - All autograder configurations");
  logger.info("  - The assignment record itself");
  logger.blank();
}

/**
 * Prompt user for confirmation
 */
async function confirmDeletion(assignmentTitle: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(
      `Are you sure you want to delete "${assignmentTitle}"? This action cannot be undone. [y/N] `,
      (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === "y" || normalized === "yes");
      }
    );
  });
}
