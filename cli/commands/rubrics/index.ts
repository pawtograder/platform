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
import { apiCall } from "@/cli/utils/api";
import { logger, handleError, CLIError } from "@/cli/utils/logger";
import { addJsonOption, emitJson } from "@/cli/utils/output";
import { assertFiniteNumbers } from "@/cli/utils/finiteNumbers";

export const command = "rubrics <action>";
export const describe = "Import and export rubrics in YML format";

// YML structure types

/**
 * A YAML reference on a rubric check. Either name-keyed (review_round + part +
 * criterion + check) or by numeric `id` fallback. Mirrors `YamlReference` in
 * `utils/supabase/DatabaseTypes.d.ts` — the frontend CLI just passes these
 * through unchanged to/from the edge function.
 */
interface YamlReferenceYml {
  review_round?: string;
  part?: string;
  criterion?: string;
  check?: string;
  id?: number;
}

interface RubricCheckYml {
  id?: number;
  data?: unknown;
  kpi_category?: string | null;
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
  references?: YamlReferenceYml[];
}

interface RubricCriteriaYml {
  id?: number;
  data?: unknown;
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
  id?: number;
  data?: unknown;
  is_individual_grading?: boolean;
  is_assign_to_student?: boolean;
  name: string;
  description: string | null;
  ordinal: number;
  criteria: RubricCriteriaYml[];
}

interface RubricYml {
  hide_unless_assigned?: boolean;
  _source?: Record<string, unknown>;
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
        return addJsonOption(
          yargs
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
        );
      },
      async (args) => {
        try {
          const data = await apiCall("rubrics.list", {
            class: args.class as string,
            assignment: args.assignment as string
          });

          if (emitJson(args, data)) return;

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
          })
          .option("strip-ids", {
            describe: "Omit database ids, so importing creates every row new (a template, not a round-trip)",
            type: "boolean",
            default: false
          });
      },
      async (args) => {
        try {
          const rubricType = args.type as string;

          logger.step("Exporting rubric...");
          const data = await apiCall("rubrics.export", {
            class: args.class as string,
            assignment: args.assignment as string,
            type: rubricType,
            strip_ids: args.stripIds as boolean
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
            describe: "Resolve and validate against the live rubric, and report what would change",
            type: "boolean",
            default: false
          })
          .option("verbose", {
            describe: "Also print the parsed rubric tree",
            type: "boolean",
            default: false
          })
          .option("json", {
            describe: "Emit the raw JSON response instead of a formatted plan",
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
          assertFiniteNumbers(parsedDoc, "");
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

          // Suppressed under --json: `emitJson` requires that nothing else reaches
          // stdout, and these lines land there (logger.info is console.log), so
          // `rubrics import --json | jq` failed on the leading "📋 Importing rubric…".
          const jsonMode = args.json === true;
          if (!jsonMode) {
            logger.step(`Importing rubric for assignment: ${args.assignment}`);
            logger.info(`Parsed rubric: ${rubricYml.name}`);
            logger.info(`  Parts: ${partCount}`);
            logger.info(`  Criteria: ${criteriaCount}`);
            logger.info(`  Checks: ${checkCount}`);

            if (args.verbose) {
              logger.blank();
              printRubricTree(rubricYml);
            }
          }

          // The dry run goes to the server. It used to return here after printing the
          // parsed file, which validated nothing the file did not already state — no
          // enum checks, no reference resolution, and no idea what the write would
          // actually change.
          const data = await apiCall("rubrics.import", {
            class: args.class as string,
            assignment: args.assignment as string,
            type: args.type as string,
            rubric: rubricYml,
            dry_run: args.dryRun === true
          });

          if (emitJson(args, data)) return;

          if (data.dry_run) logger.step("DRY RUN - No changes will be made");

          if (data.rebuilding_from_foreign_yaml) {
            logger.blank();
            logger.warning(
              "This YAML carries ids from a different rubric, so every existing row will be replaced " +
                "rather than updated. That is the cross-assignment copy workflow — re-export from this " +
                "rubric if you meant to edit it in place."
            );
          }

          printImportPlan(data.plan);

          if (Array.isArray(data.warnings) && data.warnings.length > 0) {
            logger.blank();
            for (const w of data.warnings) logger.warning(w);
          }

          logger.blank();
          if (data.dry_run) {
            logger.info("Nothing was changed. Re-run without --dry-run to apply.");
            return;
          }

          logger.success(data.message);
          logger.info(`  Rubric ID: ${data.target_rubric_id}`);
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
 * Prints the import plan, deletions first: those are the only entries that can lose
 * work, and a check that still has grading comments cannot be deleted at all.
 */
function printImportPlan(plan: {
  parts: { insert: string[]; update: number[]; remove: Array<{ id: number; name: string }> };
  criteria: { insert: string[]; update: number[]; remove: Array<{ id: number; name: string }> };
  checks: {
    insert: string[];
    update: number[];
    remove: Array<{ id: number; name: string }>;
    points_changed: Array<{ id: number; name: string; from: number; to: number }>;
  };
  /** Optional: absent from a server that predates the criterion-scoring diff. */
  criteria_scoring_changed?: Array<{ id: number; name: string }>;
  foreign_ids: Array<{ level: string; id: number; name: string }>;
  broad_change: boolean;
}): void {
  logger.blank();
  logger.step("Plan");

  const removals = [
    ...plan.parts.remove.map((r) => `part '${r.name}'`),
    ...plan.criteria.remove.map((r) => `criterion '${r.name}'`),
    ...plan.checks.remove.map((r) => `check '${r.name}'`)
  ];
  if (removals.length > 0) {
    logger.warning(`Removing ${removals.length} row(s):`);
    for (const r of removals) logger.info(`  - ${r}`);
  }

  if (plan.checks.points_changed.length > 0) {
    logger.warning(`Changing points on ${plan.checks.points_changed.length} check(s):`);
    for (const c of plan.checks.points_changed) {
      logger.info(`  - '${c.name}': ${c.from} -> ${c.to} (cascades to existing comments)`);
    }
  }

  const scoringChanged = plan.criteria_scoring_changed ?? [];
  if (scoringChanged.length > 0) {
    logger.warning(`Changing scoring on ${scoringChanged.length} criteria (total_points/additive/deduction-only):`);
    for (const c of scoringChanged) {
      logger.info(`  - '${c.name}'`);
    }
  }

  const inserts = plan.parts.insert.length + plan.criteria.insert.length + plan.checks.insert.length;
  const updates = plan.parts.update.length + plan.criteria.update.length + plan.checks.update.length;
  logger.info(`Creating: ${inserts} row(s)`);
  logger.info(`Updating: ${updates} row(s)`);
  if (
    removals.length === 0 &&
    inserts === 0 &&
    plan.checks.points_changed.length === 0 &&
    scoringChanged.length === 0
  ) {
    logger.info("No structural changes.");
  }
  if (plan.broad_change) {
    logger.info("Affected submission reviews will be recomputed.");
  }
}

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
        if (Array.isArray(check.references) && check.references.length > 0) {
          logger.info(`        References: ${check.references.length}`);
        }
      }
    }
  }
}

export const handler = () => {};
