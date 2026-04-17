/**
 * Surveys command group
 *
 * Usage:
 *   pawtograder surveys copy --source-class <slug> --target-class <slug> [--survey <uuid|title>] [--all] [--target-assignment <slug>] [--dry-run]
 */

import type { Argv } from "yargs";
import { apiCall } from "../../utils/api";
import { logger, handleError } from "../../utils/logger";

export const command = "surveys <action>";
export const describe = "Manage surveys";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "copy",
      "Copy surveys between classes",
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
          .option("survey", {
            describe: "Single survey to copy (row id, logical survey_id UUID, or exact title)",
            type: "string"
          })
          .option("all", {
            describe: "Copy all surveys from source class (latest version per survey)",
            type: "boolean"
          })
          .option("target-assignment", {
            describe: "Target class assignment (ID or slug) to link copied surveys",
            type: "string"
          })
          .option("dry-run", {
            describe: "Show what would be copied without making changes",
            type: "boolean",
            default: false
          })
          .check((argv) => {
            const n = [argv.survey, argv.all].filter(Boolean).length;
            if (n !== 1) {
              throw new Error("Must specify exactly one of: --survey or --all");
            }
            return true;
          });
      },
      async (args) => {
        try {
          logger.step("Copying surveys...");

          const params: Record<string, unknown> = {
            source_class: args.sourceClass,
            target_class: args.targetClass,
            dry_run: args.dryRun
          };

          if (args.survey) {
            params.survey = args.survey;
          } else if (args.all) {
            params.all = true;
          }
          if (args.targetAssignment) {
            params.target_assignment = args.targetAssignment;
          }

          const data = await apiCall("surveys.copy", params);

          if (data.dry_run) {
            logger.step("DRY RUN - No changes will be made");
            logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
            logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
            if (data.target_assignment) {
              logger.info(`Target assignment: ${data.target_assignment.slug ?? data.target_assignment.id}`);
            }
            logger.blank();
            logger.tableHeader(["Title", "Logical ID", "Linked assignment"]);
            for (const s of data.surveys_to_copy) {
              logger.tableRow([s.title, s.survey_id, s.assignment_id != null ? String(s.assignment_id) : "-"]);
            }
            logger.blank();
            return;
          }

          logger.info(`Source: ${data.source_class.name} (${data.source_class.slug})`);
          logger.info(`Target: ${data.target_class.name} (${data.target_class.slug})`);
          logger.blank();

          for (const r of data.results) {
            if (r.success) {
              logger.success(
                `Copied: ${r.source_title} -> row ${r.new_survey_id} (logical ${r.new_survey_logical_id})`
              );
              if (r.warnings?.length) {
                for (const w of r.warnings) {
                  logger.warning(`  ${w}`);
                }
              }
            } else {
              logger.error(`Failed: ${r.source_title} - ${r.error}`);
            }
          }

          logger.blank();
          logger.step("Summary");
          logger.info(`Succeeded: ${data.summary.succeeded}/${data.summary.total}`);
          if (data.summary.failed > 0) {
            logger.warning(`Failed: ${data.summary.failed}`);
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
