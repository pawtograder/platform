/**
 * Rubrics command group
 *
 * Usage:
 *   pawtograder rubrics list --assignment <id|slug> --class <identifier>
 *   pawtograder rubrics export --assignment <id|slug> --class <identifier> [--output <file.yml>]
 *   pawtograder rubrics import --assignment <id|slug> --class <identifier> --file <file.yml> [--type grading|self_review|meta]
 */

import type { Argv } from "yargs";
import * as fs from "fs";
import * as YAML from "yaml";
import { callCLI } from "../../utils/api";
import { logger, handleError, CLIError } from "../../utils/logger";

export const command = "rubrics <action>";
export const describe = "Import and export rubrics in YML format";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List rubrics for an assignment",
      (yargs) => {
        return yargs
          .option("assignment", {
            alias: "a",
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
          const data = await callCLI("rubrics.list", {
            class: args.class as string,
            assignment: args.assignment as string
          });

          logger.step(`Rubrics for assignment: ${data.assignment.title}`);
          logger.blank();

          const typeLabels: Record<string, string> = {
            grading: "Grading",
            self_review: "Self-Review",
            meta: "Meta-Grading"
          };

          for (const rubric of data.rubrics) {
            const label = typeLabels[rubric.type] || rubric.type;
            if (rubric.id) {
              logger.info(`${label} Rubric (ID: ${rubric.id})`);
              logger.info(`  Name: ${rubric.name || "(unnamed)"}`);
              logger.info(`  Description: ${rubric.description || "(none)"}`);
            } else {
              logger.info(`${label} Rubric: (not set)`);
            }
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "export",
      "Export a rubric to YML file",
      (yargs) => {
        return yargs
          .option("assignment", {
            alias: "a",
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
          .option("type", {
            alias: "T",
            describe: "Which rubric to export",
            type: "string",
            choices: ["grading", "self_review", "meta"],
            default: "grading"
          })
          .option("output", {
            alias: "o",
            describe: "Output file path (default: <assignment-slug>-<type>-rubric.yml)",
            type: "string"
          });
      },
      async (args) => {
        try {
          const data = await callCLI("rubrics.export", {
            class: args.class as string,
            assignment: args.assignment as string,
            type: args.type as string
          });

          const rubric = data.rubric;

          // Generate output filename - use assignment identifier as fallback
          const assignmentSlug = (args.assignment as string).replace(/[^a-z0-9-]/gi, "-");
          const outputFile = (args.output as string) || `${assignmentSlug}-${args.type}-rubric.yml`;

          // Write YAML file
          const yamlContent = YAML.stringify(rubric, {
            indent: 2,
            lineWidth: 120,
            nullStr: "null"
          });

          fs.writeFileSync(outputFile, yamlContent, "utf8");

          // Count items
          let criteriaCount = 0;
          let checkCount = 0;
          for (const part of rubric.parts || []) {
            criteriaCount += (part.criteria || []).length;
            for (const criteria of part.criteria || []) {
              checkCount += (criteria.checks || []).length;
            }
          }

          logger.success(`Exported rubric to: ${outputFile}`);
          logger.info(`  Name: ${rubric.name}`);
          logger.info(`  Parts: ${(rubric.parts || []).length}`);
          logger.info(`  Criteria: ${criteriaCount}`);
          logger.info(`  Checks: ${checkCount}`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "import",
      "Import a rubric from YML file",
      (yargs) => {
        return yargs
          .option("assignment", {
            alias: "a",
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
          .option("file", {
            alias: "f",
            describe: "YML file to import",
            type: "string",
            demandOption: true
          })
          .option("type", {
            alias: "T",
            describe: "Which rubric to replace",
            type: "string",
            choices: ["grading", "self_review", "meta"],
            default: "grading"
          })
          .option("dry-run", {
            describe: "Show what would be imported without making changes",
            type: "boolean",
            default: false
          });
      },
      async (args) => {
        try {
          // Read and parse YML file locally
          const filePath = args.file as string;
          if (!fs.existsSync(filePath)) {
            throw new CLIError(`File not found: ${filePath}`);
          }

          const yamlContent = fs.readFileSync(filePath, "utf8");
          const rubricData = YAML.parse(yamlContent);

          logger.step(`Importing rubric from: ${filePath}`);

          const data = await callCLI("rubrics.import", {
            class: args.class as string,
            assignment: args.assignment as string,
            type: args.type as string,
            rubric: rubricData,
            dry_run: args.dryRun as boolean
          });

          if (data.dry_run) {
            logger.step("DRY RUN - No changes will be made");
            logger.blank();
            logger.info(`Target rubric ID: ${data.target_rubric_id}`);
            logger.info(`Parts: ${data.summary.parts}`);
            logger.info(`Criteria: ${data.summary.criteria}`);
            logger.info(`Checks: ${data.summary.checks}`);
            return;
          }

          logger.success(data.message || "Rubric imported successfully");
          logger.info(`  Rubric ID: ${data.rubric_id}`);
          logger.info(`  Parts: ${data.summary.parts}`);
          logger.info(`  Criteria: ${data.summary.criteria}`);
          logger.info(`  Checks: ${data.summary.checks}`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
