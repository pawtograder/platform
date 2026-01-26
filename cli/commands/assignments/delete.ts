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
import { resolveClass, resolveAssignment, getSupabaseClient } from "../../utils/db";
import { logger, handleError, CLIError } from "../../utils/logger";
import { Assignment } from "../../types";

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
    // 1. Resolve class and assignment
    logger.step("Resolving class and assignment...");
    const classData = await resolveClass(args.class);
    const assignment = await resolveAssignment(classData.id, args.identifier);

    logger.info(`Class: ${classData.name} (${classData.slug})`);
    logger.info(`Assignment: ${assignment.title} (${assignment.slug})`);
    logger.info(`Assignment ID: ${assignment.id}`);
    logger.blank();

    // 2. Show warning information
    printDeleteWarning(assignment);

    // 3. Confirm deletion unless --force is specified
    if (!args.force) {
      const confirmed = await confirmDeletion(assignment);
      if (!confirmed) {
        logger.info("Deletion cancelled.");
        return;
      }
    } else {
      logger.warning("--force specified, skipping confirmation");
    }

    // 4. Call the edge function to delete the assignment
    logger.step("Deleting assignment...");
    await deleteAssignmentViaEdgeFunction(assignment.id, classData.id);

    logger.success(`Assignment "${assignment.title}" has been successfully deleted.`);
  } catch (error) {
    handleError(error);
  }
}

/**
 * Print warning information about what will be deleted
 */
function printDeleteWarning(assignment: Assignment): void {
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
async function confirmDeletion(assignment: Assignment): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(
      `Are you sure you want to delete "${assignment.title}"? This action cannot be undone. [y/N] `,
      (answer) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === "y" || normalized === "yes");
      }
    );
  });
}

/**
 * Call edge function to delete the assignment
 */
async function deleteAssignmentViaEdgeFunction(assignmentId: number, classId: number): Promise<void> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.functions.invoke("assignment-delete", {
    body: { assignment_id: assignmentId, class_id: classId }
  });

  if (error) {
    throw new CLIError(`Failed to delete assignment: ${error.message}`);
  }

  if (data?.error) {
    const errorDetail = data.error.details || data.error.message || "Unknown error";
    throw new CLIError(`Failed to delete assignment: ${errorDetail}`);
  }

  if (data?.message) {
    logger.info(data.message);
  }
}
