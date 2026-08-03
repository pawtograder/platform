/**
 * Reviews command group
 *
 * Usage:
 *   pawtograder reviews list --assignment <identifier> --class <identifier> [--status pending] [--json]
 *   pawtograder reviews assign --assignment <identifier> --class <identifier> --due-date 2026-09-01 [--by-part]
 *   pawtograder reviews assign --assignment <identifier> --class <identifier> --due-date 2026-09-01 --file drafts.json
 */

import * as fs from "fs";
import type { Argv } from "yargs";
import { apiCall } from "@/cli/utils/api";
import { logger, handleError, CLIError } from "@/cli/utils/logger";
import { addJsonOption, emitJson, printTable, formatDate, formatZoneLabel, truncate } from "@/cli/utils/output";
import { normalizeDate } from "@/cli/utils/schedule";

export const command = "reviews <action>";
export const describe = "Manage submission reviews and review assignments";

/** Reads and parses a `--file` draft manifest. */
function readDraftManifest(filePath: string): unknown {
  if (!fs.existsSync(filePath)) {
    throw new CLIError(`Draft manifest not found: ${filePath}`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CLIError(`Failed to read ${filePath}: ${msg}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CLIError(
      `${filePath} is not valid JSON: ${msg}\n` +
        '   Expected an array of {"assignee_profile_id": "...", "submission_id": 1, "rubric_part_id": null}'
    );
  }
}

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List review assignments for an assignment",
      (yargs) => {
        return addJsonOption(
          yargs
            .option("class", {
              alias: "c",
              describe: "Class ID, slug, or name",
              type: "string",
              demandOption: true
            })
            .option("assignment", {
              alias: "a",
              describe: "Assignment ID or slug",
              type: "string",
              demandOption: true
            })
            .option("rubric", {
              describe: "Restrict to one rubric: grading, self_review, meta, or a rubric ID (default: all rounds)",
              type: "string"
            })
            .option("assignee", {
              describe: "Filter by assignee profile ID or name substring",
              type: "string"
            })
            .option("status", {
              describe: "Filter by completion state",
              type: "string",
              choices: ["pending", "completed", "all"],
              default: "all"
            })
            .option("limit", {
              describe: "Maximum review assignments to return (max 5000; use --offset to read past that)",
              type: "number",
              default: 1000
            })
            .option("offset", {
              describe: "Skip this many review assignments before listing",
              type: "number",
              default: 0
            })
        );
      },
      async (args) => {
        try {
          const data = await apiCall("reviews.list", {
            class: args.class as string,
            assignment: args.assignment as string,
            rubric: args.rubric as string | undefined,
            assignee: args.assignee as string | undefined,
            status: args.status as string,
            limit: args.limit as number,
            offset: args.offset as number
          });

          if (emitJson(args, data)) return;

          const tz = data.class.time_zone as string | null;
          logger.step(`Review assignments for ${data.assignment.title} (${data.class.name})${formatZoneLabel(tz)}`);

          const reviews = data.reviews ?? [];
          if (reviews.length === 0) {
            logger.info("No review assignments found.");
            return;
          }

          printTable(
            ["ID", "Assignee", "Submission", "Rubric Parts", "Due", "Completed", "Score"],
            reviews.map((r: Record<string, unknown>) => [
              r.id as number,
              (r.assignee_name as string | null) ?? (r.assignee_profile_id as string),
              r.submission_id as number,
              truncate((r.rubric_part_names as string[]).join(", ") || "(whole rubric)", 32),
              formatDate(r.due_date as string | null, tz),
              // The composite rule: the assignment itself, or the linked review
              // completed by this assignee. Matching the web reviews table.
              r.review_completed_by_assignee
                ? formatDate((r.completed_at as string | null) ?? (r.review_completed_at as string | null), tz)
                : "-",
              r.review_total_score as number | null
            ])
          );

          logger.blank();
          logger.info(
            `Showing ${data.summary.total} of ${data.summary.matching} matching ` +
              `(${data.summary.completed} completed, ${data.summary.pending} pending across the assignment)`
          );
          if (data.summary.truncated) {
            logger.warning(
              `Output truncated at --limit ${args.limit}. Continue with --offset ${data.summary.next_offset}.`
            );
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "assign",
      "Create review assignments, balanced round-robin across graders or from a manifest",
      (yargs) => {
        return addJsonOption(
          yargs
            .option("class", {
              alias: "c",
              describe: "Class ID, slug, or name",
              type: "string",
              demandOption: true
            })
            .option("assignment", {
              alias: "a",
              describe: "Assignment ID or slug",
              type: "string",
              demandOption: true
            })
            .option("rubric", {
              describe: "Rubric to assign: grading, self_review, meta, or a rubric ID",
              type: "string",
              default: "grading"
            })
            .option("due-date", {
              describe:
                "Due date for the created assignments. A bare date (YYYY-MM-DD or MM/DD/YYYY) means " +
                "end of that day in the class's time zone; append T17:00 for a specific time, or " +
                "pass a timestamp with an offset to be explicit.",
              type: "string",
              demandOption: true
            })
            .option("grader", {
              describe: "Restrict the pool to these grader profile IDs (repeatable; default: all class staff)",
              type: "string",
              array: true
            })
            .option("by-part", {
              describe: "Create one assignment per rubric part instead of one per submission",
              type: "boolean",
              default: false
            })
            .option("include-non-submitters", {
              describe:
                "Also assign manual placeholder stubs (students who did not submit). Excluded by default, " +
                "matching the web bulk-assign page.",
              type: "boolean",
              default: false
            })
            .option("file", {
              alias: "f",
              describe: "JSON manifest of explicit assignments, instead of round-robin allocation",
              type: "string"
            })
            .option("dry-run", {
              describe: "Show what would be assigned without writing anything",
              type: "boolean",
              default: false
            })
            .check((argv) => {
              if (argv.file && (argv.grader || argv.byPart || argv.includeNonSubmitters)) {
                throw new Error(
                  "--file supplies explicit assignments; it cannot be combined with --grader, --by-part, " +
                    "or --include-non-submitters"
                );
              }
              return true;
            })
        );
      },
      async (args) => {
        try {
          // A timestamp that already carries an offset is passed through untouched;
          // the server interprets bare dates and times in the class's time zone.
          const rawDueDate = String(args.dueDate);
          const dueDate = /(?:Z|[+-]\d{2}:?\d{2})$/.test(rawDueDate)
            ? rawDueDate
            : normalizeDate(rawDueDate, "--due-date");

          const params: Record<string, unknown> = {
            class: args.class as string,
            assignment: args.assignment as string,
            rubric: args.rubric as string,
            due_date: dueDate,
            dry_run: args.dryRun as boolean
          };

          if (args.file) {
            params.drafts = readDraftManifest(args.file as string);
          } else {
            if (args.grader) params.graders = args.grader as string[];
            params.by_part = args.byPart as boolean;
            params.include_non_submitters = args.includeNonSubmitters as boolean;
          }

          const data = await apiCall("reviews.assign", params);

          if (emitJson(args, data)) return;

          const drafts = data.drafts ?? [];

          if (data.dry_run) {
            logger.step("DRY RUN - No review assignments will be created");
          }
          logger.info(`Assignment: ${data.assignment.title} (${data.assignment.slug})`);
          logger.info(`Rubric ID: ${data.rubric_id}`);
          logger.info(`Due: ${data.due_date}`);
          logger.blank();

          // `load` and this count cover new assignments only; the repointed ones are
          // reported separately below, because a grader keeping work they already had
          // is not new load on them.
          const load = (data.load ?? []) as Array<{ assignee_profile_id: string; count: number }>;
          const newCount = drafts.length - (data.retargeted_stale ?? 0);

          if (drafts.length === 0) {
            logger.info(data.message ?? "Nothing to assign.");
          } else if (newCount === 0) {
            logger.info("Planned: no new review assignments.");
          } else {
            printTable(
              ["Grader", "New reviews"],
              load.map((entry) => [entry.assignee_profile_id, entry.count])
            );
            logger.blank();
            logger.info(`Planned: ${newCount} new review assignment(s)`);
          }

          const excluded = data.submissions_excluded;
          if (excluded && (excluded.stubs > 0 || excluded.dropped_students > 0)) {
            if (excluded.stubs > 0) {
              logger.info(
                `Skipped ${excluded.stubs} placeholder stub(s) with no submission ` +
                  "(pass --include-non-submitters to grade them)"
              );
            }
            if (excluded.dropped_students > 0) {
              logger.info(`Skipped ${excluded.dropped_students} submission(s) whose students are no longer enrolled`);
            }
          }

          if (data.skipped_already_assigned > 0) {
            logger.info(`Already assigned, left alone: ${data.skipped_already_assigned}`);
          }

          if (data.stale_collisions > 0) {
            logger.warning(
              `${data.stale_collisions} assignment(s) still point at a superseded submission whose ` +
                "replacement is already assigned. Retargeting them would collide or duplicate the work — " +
                "clear the stale ones instead."
            );
          }

          if (data.retargeted_stale > 0) {
            logger.info(
              `Repointed to current submissions: ${data.retargeted_stale} ` +
                "(existing assignments that referenced a superseded submission)"
            );
          }

          const unassignable = data.unassignable ?? [];
          if (unassignable.length > 0) {
            logger.warning(
              `${unassignable.length} submission(s) had no eligible grader after grading conflicts and ` +
                "self-review exclusions; they were not assigned."
            );
            for (const entry of unassignable.slice(0, 10)) {
              logger.info(
                `  submission ${entry.submission_id}${entry.rubric_part_id ? ` part ${entry.rubric_part_id}` : ""}`
              );
            }
            if (unassignable.length > 10) {
              logger.info(`  … and ${unassignable.length - 10} more`);
            }
          }

          if (data.dry_run) {
            logger.blank();
            logger.info("Re-run without --dry-run to create these assignments.");
            return;
          }

          if (data.result) {
            logger.blank();
            logger.success("Review assignments written");
            logger.info(`Created: ${data.result.assignments_created}`);
            logger.info(`Updated: ${data.result.assignments_updated}`);
            if (data.result.assignments_retargeted) {
              logger.info(`Retargeted to newer submissions: ${data.result.assignments_retargeted}`);
            }
            if (data.result.assignments_reopened) {
              logger.info(`Reopened (new part added to completed work): ${data.result.assignments_reopened}`);
            }
            logger.info(`Rubric parts linked: ${data.result.parts_created}`);
            logger.info(`Submission reviews created: ${data.result.submission_reviews_created}`);
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
