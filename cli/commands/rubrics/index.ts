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
import * as path from "path";
import * as YAML from "yaml";
import { resolveClass, resolveAssignment, fetchRubricWithHierarchy, getSupabaseClient } from "../../utils/db";
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
  review_round: number | null;
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
          const classData = await resolveClass(args.class as string);
          const assignment = await resolveAssignment(classData.id, args.assignment as string);

          logger.step(`Rubrics for assignment: ${assignment.title}`);
          logger.blank();

          const rubrics = [
            { type: "Grading", id: assignment.grading_rubric_id },
            { type: "Self-Review", id: assignment.self_review_rubric_id },
            { type: "Meta-Grading", id: assignment.meta_grading_rubric_id }
          ];

          const supabase = getSupabaseClient();

          for (const rubric of rubrics) {
            if (rubric.id) {
              const { data } = await supabase
                .from("rubrics")
                .select("id, name, description")
                .eq("id", rubric.id)
                .single();

              if (data) {
                logger.info(`${rubric.type} Rubric (ID: ${data.id})`);
                logger.info(`  Name: ${data.name}`);
                logger.info(`  Description: ${data.description || "(none)"}`);
              } else {
                logger.info(`${rubric.type} Rubric: ID ${rubric.id} (not found)`);
              }
            } else {
              logger.info(`${rubric.type} Rubric: (not set)`);
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
          const classData = await resolveClass(args.class as string);
          const assignment = await resolveAssignment(classData.id, args.assignment as string);

          logger.step(`Exporting rubric for assignment: ${assignment.title}`);

          // Determine which rubric to export
          let rubricId: number | null = null;
          const rubricType = args.type as string;

          if (rubricType === "grading") {
            rubricId = assignment.grading_rubric_id;
          } else if (rubricType === "self_review") {
            rubricId = assignment.self_review_rubric_id;
          } else if (rubricType === "meta") {
            rubricId = assignment.meta_grading_rubric_id;
          }

          if (!rubricId) {
            throw new CLIError(`No ${rubricType} rubric found for this assignment`);
          }

          logger.info(`Fetching ${rubricType} rubric (ID: ${rubricId})...`);

          // Fetch full rubric hierarchy
          const rubric = await fetchRubricWithHierarchy(rubricId);

          if (!rubric) {
            throw new CLIError(`Rubric not found: ${rubricId}`);
          }

          // Convert to YML structure
          const rubricYml: RubricYml = {
            name: rubric.name,
            description: rubric.description,
            cap_score_to_assignment_points: rubric.cap_score_to_assignment_points,
            is_private: rubric.is_private,
            review_round: rubric.review_round,
            parts: (rubric.rubric_parts || []).map((part) => ({
              name: part.name,
              description: part.description,
              ordinal: part.ordinal,
              criteria: (part.rubric_criteria || []).map((criteria) => ({
                name: criteria.name,
                description: criteria.description,
                ordinal: criteria.ordinal,
                total_points: criteria.total_points,
                is_additive: criteria.is_additive,
                is_deduction_only: criteria.is_deduction_only,
                min_checks_per_submission: criteria.min_checks_per_submission,
                max_checks_per_submission: criteria.max_checks_per_submission,
                checks: (criteria.rubric_checks || []).map((check) => ({
                  name: check.name,
                  description: check.description,
                  ordinal: check.ordinal,
                  points: check.points,
                  is_annotation: check.is_annotation,
                  is_comment_required: check.is_comment_required,
                  is_required: check.is_required,
                  annotation_target: check.annotation_target,
                  artifact: check.artifact,
                  file: check.file,
                  group: check.group,
                  max_annotations: check.max_annotations,
                  student_visibility: check.student_visibility
                }))
              }))
            }))
          };

          // Generate output filename
          const outputFile = (args.output as string) || `${assignment.slug}-${rubricType}-rubric.yml`;

          // Write YAML file
          const yamlContent = YAML.stringify(rubricYml, {
            indent: 2,
            lineWidth: 120,
            nullStr: "null"
          });

          fs.writeFileSync(outputFile, yamlContent, "utf8");

          // Summary
          const partCount = rubricYml.parts.length;
          let criteriaCount = 0;
          let checkCount = 0;
          for (const part of rubricYml.parts) {
            criteriaCount += part.criteria.length;
            for (const criteria of part.criteria) {
              checkCount += criteria.checks.length;
            }
          }

          logger.success(`Exported rubric to: ${outputFile}`);
          logger.info(`  Name: ${rubric.name}`);
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
          const classData = await resolveClass(args.class as string);
          const assignment = await resolveAssignment(classData.id, args.assignment as string);

          logger.step(`Importing rubric for assignment: ${assignment.title}`);

          // Read and parse YML file
          const filePath = args.file as string;
          if (!fs.existsSync(filePath)) {
            throw new CLIError(`File not found: ${filePath}`);
          }

          const yamlContent = fs.readFileSync(filePath, "utf8");
          const rubricYml = YAML.parse(yamlContent) as RubricYml;

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

          // Determine which rubric to update
          const rubricType = args.type as string;
          let targetRubricId: number | null = null;

          if (rubricType === "grading") {
            targetRubricId = assignment.grading_rubric_id;
          } else if (rubricType === "self_review") {
            targetRubricId = assignment.self_review_rubric_id;
          } else if (rubricType === "meta") {
            targetRubricId = assignment.meta_grading_rubric_id;
          }

          if (!targetRubricId) {
            throw new CLIError(`No ${rubricType} rubric exists for this assignment. Create the rubric first.`);
          }

          logger.info(`Updating ${rubricType} rubric (ID: ${targetRubricId})...`);

          await importRubricFromYml(rubricYml, targetRubricId, assignment.id, classData.id);

          logger.success(`Rubric imported successfully`);
          logger.info(`  Rubric ID: ${targetRubricId}`);
          logger.info(`  Parts: ${partCount}`);
          logger.info(`  Criteria: ${criteriaCount}`);
          logger.info(`  Checks: ${checkCount}`);
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

/**
 * Import rubric from YML, replacing existing content
 */
async function importRubricFromYml(
  rubricYml: RubricYml,
  targetRubricId: number,
  assignmentId: number,
  classId: number
): Promise<void> {
  const supabase = getSupabaseClient();

  // Step 1: Clear existing rubric content (in dependency order)
  logger.info("  Clearing existing rubric content...");

  await supabase.from("rubric_check_references").delete().eq("rubric_id", targetRubricId);
  await supabase.from("rubric_checks").delete().eq("rubric_id", targetRubricId);
  await supabase.from("rubric_criteria").delete().eq("rubric_id", targetRubricId);
  await supabase.from("rubric_parts").delete().eq("rubric_id", targetRubricId);

  // Step 2: Update rubric metadata
  logger.info("  Updating rubric metadata...");

  const { error: updateError } = await supabase
    .from("rubrics")
    .update({
      name: rubricYml.name,
      description: rubricYml.description,
      cap_score_to_assignment_points: rubricYml.cap_score_to_assignment_points ?? true,
      is_private: rubricYml.is_private ?? false,
      review_round: rubricYml.review_round
    })
    .eq("id", targetRubricId);

  if (updateError) {
    throw new CLIError(`Failed to update rubric: ${updateError.message}`);
  }

  // Step 3: Insert parts
  logger.info("  Importing parts...");

  for (const part of rubricYml.parts) {
    const { data: newPart, error: partError } = await supabase
      .from("rubric_parts")
      .insert({
        assignment_id: assignmentId,
        class_id: classId,
        rubric_id: targetRubricId,
        name: part.name,
        description: part.description,
        ordinal: part.ordinal
      })
      .select("id")
      .single();

    if (partError || !newPart) {
      throw new CLIError(`Failed to create part '${part.name}': ${partError?.message || "Unknown error"}`);
    }

    // Insert criteria
    for (const criteria of part.criteria) {
      const { data: newCriteria, error: criteriaError } = await supabase
        .from("rubric_criteria")
        .insert({
          assignment_id: assignmentId,
          class_id: classId,
          rubric_id: targetRubricId,
          rubric_part_id: newPart.id,
          name: criteria.name,
          description: criteria.description,
          ordinal: criteria.ordinal,
          total_points: criteria.total_points,
          is_additive: criteria.is_additive ?? false,
          is_deduction_only: criteria.is_deduction_only ?? false,
          min_checks_per_submission: criteria.min_checks_per_submission,
          max_checks_per_submission: criteria.max_checks_per_submission
        })
        .select("id")
        .single();

      if (criteriaError || !newCriteria) {
        throw new CLIError(
          `Failed to create criteria '${criteria.name}': ${criteriaError?.message || "Unknown error"}`
        );
      }

      // Insert checks
      for (const check of criteria.checks) {
        const { error: checkError } = await supabase.from("rubric_checks").insert({
          assignment_id: assignmentId,
          class_id: classId,
          rubric_id: targetRubricId,
          rubric_criteria_id: newCriteria.id,
          name: check.name,
          description: check.description,
          ordinal: check.ordinal,
          points: check.points,
          is_annotation: check.is_annotation ?? false,
          is_comment_required: check.is_comment_required ?? false,
          is_required: check.is_required ?? false,
          annotation_target: check.annotation_target,
          artifact: check.artifact,
          file: check.file,
          group: check.group,
          max_annotations: check.max_annotations,
          student_visibility: check.student_visibility ?? "visible"
        });

        if (checkError) {
          throw new CLIError(`Failed to create check '${check.name}': ${checkError.message}`);
        }
      }
    }
  }
}

export const handler = () => {};
