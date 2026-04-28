/**
 * Rubrics command group
 *
 * Usage:
 *   pawtograder rubrics export --assignment <id|slug> --class <identifier> [--output <file.yml>]
 *   pawtograder rubrics import --assignment <id|slug> --class <identifier> --file <file.yml> [--type grading|self_review|meta]
 *   pawtograder rubrics list --assignment <id|slug> --class <identifier>
 */

import type { Argv } from "yargs";
import * as fs from "fs";
import * as YAML from "yaml";
import { apiCall } from "../../utils/api";
import { logger, handleError, CLIError } from "../../utils/logger";

export const command = "rubrics <action>";
export const describe = "Import and export rubrics in YML format";

// YML structure types
interface RubricCheckYml {
  name: string;
  description: string | null;
  ordinal: number;
  points: number;
  is_annotation: boolean;
  is_comment_required: boolean;
  is_required: boolean;
  annotation_target: string | null;
  artifact: string | null;
  file: string | null;
  group: string | null;
  max_annotations: number | null;
  student_visibility: string;
}

interface RubricCriteriaYml {
  name: string;
  description: string | null;
  ordinal: number;
  total_points: number;
  is_additive: boolean;
  is_deduction_only: boolean;
  min_checks_per_submission: number | null;
  max_checks_per_submission: number | null;
  checks: RubricCheckYml[];
}

interface RubricPartYml {
  name: string;
  description: string | null;
  ordinal: number;
  criteria: RubricCriteriaYml[];
}

interface RubricYml {
  name: string;
  description: string | null;
  cap_score_to_assignment_points: boolean;
  is_private: boolean;
  review_round: string | null;
  parts: RubricPartYml[];
}

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
          const data = await apiCall("rubrics.list", {
            class: args.class as string,
            assignment: args.assignment as string
          });

          logger.step(`Rubrics for assignment: ${data.assignment.title}`);
          logger.blank();

          for (const rubric of data.rubrics) {
            const typeLabel =
              rubric.type === "grading" ? "Grading" : rubric.type === "self_review" ? "Self-Review" : "Meta-Grading";

            if (rubric.id) {
              logger.info(`${typeLabel} Rubric (ID: ${rubric.id})`);
              logger.info(`  Name: ${rubric.name}`);
              logger.info(`  Description: ${rubric.description || "(none)"}`);
            } else {
              logger.info(`${typeLabel} Rubric: (not set)`);
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
          const rubricType = args.type as string;

          logger.step("Exporting rubric...");
          const data = await apiCall("rubrics.export", {
            class: args.class as string,
            assignment: args.assignment as string,
            type: rubricType
          });

          const rubricData = data.rubric as RubricYml;

          // Generate output filename — we need assignment slug, get it from a show call
          // or derive from args
          const assignmentSlug = args.assignment as string;
          const outputFile = (args.output as string) || `${assignmentSlug}-${rubricType}-rubric.yml`;

          // Write YAML file
          const yamlContent = YAML.stringify(rubricData, {
            indent: 2,
            lineWidth: 120,
            nullStr: "null"
          });

          fs.writeFileSync(outputFile, yamlContent, "utf8");

          // Summary
          const partCount = rubricData.parts?.length || 0;
          let criteriaCount = 0;
          let checkCount = 0;
          for (const part of rubricData.parts || []) {
            criteriaCount += part.criteria?.length || 0;
            for (const criteria of part.criteria || []) {
              checkCount += criteria.checks?.length || 0;
            }
          }

          logger.success(`Exported rubric to: ${outputFile}`);
          logger.info(`  Name: ${rubricData.name}`);
          logger.info(`  Parts: ${partCount}`);
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
          const parsedDoc = YAML.parse(yamlContent);
          if (parsedDoc === null || typeof parsedDoc !== "object" || Array.isArray(parsedDoc)) {
            throw new CLIError("Invalid YML: empty or invalid document");
          }
          const rubricYml = parsedDoc as RubricYml;

          // Validate structure
          if (!rubricYml.name) {
            throw new CLIError("Invalid YML: missing 'name' field");
          }
          if (!Array.isArray(rubricYml.parts)) {
            throw new CLIError("Invalid YML: 'parts' must be an array");
          }

          // Count items
          const partCount = rubricYml.parts.length;
          let criteriaCount = 0;
          let checkCount = 0;
          for (const part of rubricYml.parts) {
            if (!Array.isArray(part.criteria)) {
              throw new CLIError(`Invalid YML: part '${part.name}' must have 'criteria' array`);
            }
            criteriaCount += part.criteria.length;
            for (const criteria of part.criteria) {
              if (!Array.isArray(criteria.checks)) {
                throw new CLIError(`Invalid YML: criteria '${criteria.name}' must have 'checks' array`);
              }
              checkCount += criteria.checks.length;
            }
          }

          logger.step(`Importing rubric for assignment: ${args.assignment}`);
          logger.info(`Parsed rubric: ${rubricYml.name}`);
          logger.info(`  Parts: ${partCount}`);
          logger.info(`  Criteria: ${criteriaCount}`);
          logger.info(`  Checks: ${checkCount}`);

          if (args.dryRun) {
            logger.step("DRY RUN - No changes will be made");
            logger.blank();
            printRubricTree(rubricYml);
            return;
          }

          // Send parsed rubric data to edge function
          const data = await apiCall("rubrics.import", {
            class: args.class as string,
            assignment: args.assignment as string,
            type: args.type as string,
            rubric: rubricYml,
            dry_run: false
          });

          logger.success("Rubric imported successfully");
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

/**
 * Print rubric tree for dry-run preview
 */
function printRubricTree(rubric: RubricYml): void {
  logger.info(`Rubric: ${rubric.name}`);
  if (rubric.description) {
    logger.info(`  Description: ${rubric.description}`);
  }

  for (const part of rubric.parts) {
    logger.info(`  Part ${part.ordinal}: ${part.name}`);

    for (const criteria of part.criteria) {
      logger.info(`    Criteria ${criteria.ordinal}: ${criteria.name} (${criteria.total_points} pts)`);

      for (const check of criteria.checks) {
        const points = check.points >= 0 ? `+${check.points}` : `${check.points}`;
        logger.info(`      Check: ${check.name} (${points})`);
      }
    }
  }
}

export const handler = () => {};
