/**
 * Delete assignment command - calls the CLI edge function
 */

import * as readline from "readline";
import { callCLI } from "../../utils/api";
import { logger, handleError } from "../../utils/logger";

async function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
    });
  });
}

export async function deleteAssignmentHandler(args: any): Promise<void> {
  try {
    const classIdentifier = args.class as string;
    const identifier = args.identifier as string;
    const force = args.force as boolean;

    // First, show what will be deleted
    const showData = await callCLI("assignments.show", {
      class: classIdentifier,
      identifier
    });
    const a = showData.assignment;

    logger.warning(`⚠️  WARNING: This will permanently delete assignment "${a.title}" (${a.slug})`);
    logger.warning("This includes all submissions, grades, repositories, and related data.");
    logger.warning("This action CANNOT be undone.");
    logger.blank();

    if (!force) {
      const confirmed = await confirm(`Delete assignment "${a.title}"?`);
      if (!confirmed) {
        logger.info("Cancelled.");
        return;
      }
    }

    logger.step("Deleting assignment...");
    const data = await callCLI("assignments.delete", {
      class: classIdentifier,
      identifier
    });

    logger.success(data.message || `Assignment "${a.title}" deleted successfully`);
  } catch (error) {
    handleError(error);
  }
}
