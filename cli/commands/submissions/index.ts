/**
 * Submissions command group
 *
 * Usage:
 *   pawtograder submissions list -c <class> -a <assignment> [--include-non-submitters] [--json]
 *   pawtograder submissions export -c <class> [-a hw-*] [--include-file 'src/**'] [--exclude-file 'build/**']
 *   pawtograder submissions comments import --file batch-results.json --class <id> --assignment <id> --author-profile-id <uuid>
 *   pawtograder submissions artifacts import --file manifest.json --class <id> --assignment <id> [--overwrite]
 */

import type { Argv } from "yargs";
import { apiCall } from "@/cli/utils/api";
import { logger, handleError } from "@/cli/utils/logger";
import { addJsonOption, emitJson, printTable, formatDate, formatZoneLabel } from "@/cli/utils/output";
import { buildCommentsCommands } from "./comments";
import { buildArtifactsCommands } from "./artifacts";
import { exportBuilder, exportHandler } from "./export";

export const command = "submissions <action>";
export const describe = "Manage submissions";

export const builder = (yargs: Argv) => {
  return yargs
    .command("comments", "Batch import or sync submission comments (file / artifact / submission-level)", (y) =>
      buildCommentsCommands(y)
    )
    .command("artifacts", "Import submission artifact blobs from a manifest", (y) =>
      buildArtifactsCommands(y).demandCommand(1, "Specify artifacts import")
    )
    .command(
      "list",
      "List submissions for an assignment",
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
            .option("limit", {
              describe: "Maximum rows to return",
              type: "number",
              default: 1000
            })
            .option("include-non-submitters", {
              describe: "Also list enrolled students who have not submitted",
              type: "boolean",
              default: false
            })
        );
      },
      async (args) => {
        try {
          const data = await apiCall("submissions.list", {
            class: args.class as string,
            assignment: args.assignment as string,
            limit: args.limit as number,
            include_non_submitters: args.includeNonSubmitters as boolean
          });

          if (emitJson(args, data)) return;

          const tz = data.class.time_zone as string | null;
          logger.step(`Submissions for ${data.assignment.title} (${data.class.name})${formatZoneLabel(tz)}`);

          const submissions = data.submissions ?? [];
          if (submissions.length === 0) {
            logger.info("No submissions found.");
            return;
          }

          printTable(
            ["Student", "Group", "Submission", "SHA", "Autograder", "Total", "Released", "Grader", "Graded"],
            submissions.map((s: Record<string, unknown>) => [
              s.name as string,
              s.groupname as string | null,
              s.activesubmissionid as number | null,
              typeof s.sha === "string" ? s.sha.slice(0, 8) : null,
              s.autograder_score as number | null,
              // Per-student figure, not the review's shared total: they differ
              // for individually graded rubric parts.
              s.student_total_score as number | null,
              // On this view `released` is a timestamp, not a boolean.
              s.released ? "Yes" : "No",
              (s.gradername as string | null) ?? (s.assignedgradername as string | null),
              formatDate(s.completed_at as string | null, tz)
            ])
          );

          logger.blank();
          const { rows, distinct_submissions, non_submitters, truncated } = data.summary;
          logger.info(`Rows: ${rows} (${distinct_submissions} distinct submission(s))`);
          if (non_submitters > 0) {
            logger.info(`Students without a submission: ${non_submitters}`);
          }
          if (truncated) {
            logger.warning(`Output truncated at --limit ${args.limit}; pass a higher --limit for the full list.`);
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "export",
      "Export submission metadata and source files for an assignment",
      (yargs) => exportBuilder(yargs),
      exportHandler
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
