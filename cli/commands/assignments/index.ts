/**
 * Assignments command group
 *
 * Usage:
 *   pawtograder assignments list --class <identifier>
 *   pawtograder assignments show <identifier> --class <identifier>
 *   pawtograder assignments copy --source-class <slug> --target-class <slug> [--schedule <file>] [--all] [--assignment <slug>]
 *   pawtograder assignments delete <identifier> --class <identifier> [--force]
 */

import type { Argv } from "yargs";
import { resolveClass, fetchAssignmentsForClass, resolveAssignment } from "../../utils/db";
import { logger, handleError } from "../../utils/logger";
import { copyAssignmentsHandler } from "./copy";
import { deleteAssignmentHandler } from "./delete";

export const command = "assignments <action>";
export const describe = "Manage assignments";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List assignments for a class",
      (yargs) => {
        return yargs.option("class", {
          alias: "c",
          describe: "Class ID, slug, or name",
          type: "string",
          demandOption: true
        });
      },
      async (args) => {
        try {
          const classData = await resolveClass(args.class as string);
          logger.step(`Assignments for ${classData.name}`);

          const assignments = await fetchAssignmentsForClass(classData.id);

          if (assignments.length === 0) {
            logger.info("No assignments found.");
            return;
          }

          logger.tableHeader(["ID", "Slug", "Title", "Due Date"]);
          for (const a of assignments) {
            const dueDate = a.due_date ? new Date(a.due_date).toLocaleDateString() : "-";
            logger.tableRow([a.id, a.slug, a.title, dueDate]);
          }
          logger.blank();
          logger.info(`Total: ${assignments.length} assignments`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "show <identifier>",
      "Show details for an assignment",
      (yargs) => {
        return yargs
          .positional("identifier", {
            describe: "Assignment ID or slug",
            type: "string",
            demandOption: true
          })
          .option("class", {
            alias: "c",
            describe: "Class ID, slug, or name",
            type: "string",
            demandOption: true
          });
      },
      async (args) => {
        try {
          const classData = await resolveClass(args.class as string);
          const assignment = await resolveAssignment(classData.id, args.identifier as string);

          logger.step(`Assignment: ${assignment.title}`);
          logger.info(`ID: ${assignment.id}`);
          logger.info(`Slug: ${assignment.slug}`);
          logger.info(`Class ID: ${assignment.class_id}`);
          logger.info(`Description: ${assignment.description || "(none)"}`);
          logger.info(`Release Date: ${assignment.release_date || "(not set)"}`);
          logger.info(`Due Date: ${assignment.due_date || "(not set)"}`);
          logger.info(`Latest Due Date: ${assignment.latest_due_date || "(not set)"}`);
          logger.info(`Total Points: ${assignment.total_points || "(not set)"}`);
          logger.info(`Has Autograder: ${assignment.has_autograder ? "Yes" : "No"}`);
          logger.info(`Has Handgrader: ${assignment.has_handgrader ? "Yes" : "No"}`);
          logger.info(`Template Repo: ${assignment.template_repo || "(not set)"}`);
          logger.info(`Grading Rubric ID: ${assignment.grading_rubric_id || "(not set)"}`);
          logger.info(`Self Review Rubric ID: ${assignment.self_review_rubric_id || "(not set)"}`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "copy",
      "Copy assignments between classes",
      (yargs) => {
        return yargs
          .option("source-class", {
            alias: "s",
            describe: "Source class (ID, slug, or name)",
            type: "string",
            demandOption: true
          })
          .option("target-class", {
            alias: "t",
            describe: "Target class (ID, slug, or name)",
            type: "string",
            demandOption: true
          })
          .option("assignment", {
            alias: "a",
            describe: "Single assignment to copy (ID or slug)",
            type: "string"
          })
          .option("schedule", {
            describe: "CSV file with assignment slugs/titles and date overrides",
            type: "string"
          })
          .option("all", {
            describe: "Copy all assignments from source class",
            type: "boolean"
          })
          .option("dry-run", {
            describe: "Show what would be copied without making changes",
            type: "boolean",
            default: false
          })
          .option("skip-repos", {
            describe: "Skip git repository operations",
            type: "boolean",
            default: false
          })
          .option("skip-rubrics", {
            describe: "Skip rubric copying",
            type: "boolean",
            default: false
          })
          .check((argv) => {
            const specifiedCount = [argv.assignment, argv.schedule, argv.all].filter(Boolean).length;
            if (specifiedCount !== 1) {
              throw new Error("Must specify exactly one of: --assignment, --schedule, or --all");
            }
            return true;
          });
      },
      copyAssignmentsHandler
    )
    .command(
      "delete <identifier>",
      "Delete an assignment and all associated data",
      (yargs) => {
        return yargs
          .positional("identifier", {
            describe: "Assignment ID or slug",
            type: "string",
            demandOption: true
          })
          .option("class", {
            alias: "c",
            describe: "Class ID, slug, or name",
            type: "string",
            demandOption: true
          })
          .option("force", {
            alias: "f",
            describe: "Skip confirmation prompt",
            type: "boolean",
            default: false
          });
      },
      deleteAssignmentHandler
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
