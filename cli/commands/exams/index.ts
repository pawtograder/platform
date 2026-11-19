/**
 * Exams command group
 *
 * Usage:
 *   pawtograder exams list -c <class> [--json]
 *   pawtograder exams questions -c <class> -a <assignment> [--json]
 *   pawtograder exams scans upload -c <class> -a <assignment> --file scans.pdf --pages-per-exam <n>
 *   pawtograder exams scans process -c <class> --batch <id>
 *   pawtograder exams scans status -c <class> --batch <id> [--json]
 *   pawtograder exams scans finalize -c <class> --batch <id> [--dry-run] [--json]
 */

import type { Argv } from "yargs";
import { apiCall } from "@/cli/utils/api";
import { logger, handleError } from "@/cli/utils/logger";
import { addJsonOption, emitJson, printTable } from "@/cli/utils/output";
import { buildScansCommands } from "./scans";

export const command = "exams <action>";
export const describe = "Paper exams: list exams and questions, upload and process scan batches";

export const builder = (yargs: Argv) => {
  return yargs
    .command("scans", "Upload, process, check and finalize scan batches", (y) =>
      buildScansCommands(y).demandCommand(1, "Specify a scans action")
    )
    .command(
      "list",
      "List the exams in a class",
      (y) =>
        addJsonOption(
          y.option("class", { alias: "c", describe: "Class ID, slug, or name", type: "string", demandOption: true })
        ),
      async (args) => {
        try {
          const data = await apiCall("exams.list", { class: args.class as string });
          if (emitJson(args, data)) return;

          logger.step(`Exams in ${data.class.name}`);
          if (!data.exams.length) {
            logger.info("No exams found.");
            return;
          }
          printTable(
            ["Exam", "Assignment", "Slug", "Pages", "Status", "Mode", "Batches"],
            data.exams.map((e: Record<string, unknown>) => [
              e.id as number,
              e.assignment_title as string,
              e.assignment_slug as string,
              e.num_pages as number,
              e.status as string,
              e.delivery_mode as string,
              e.batches as number
            ])
          );
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "questions",
      "List an exam's questions with their grading rubric check IDs",
      (y) =>
        addJsonOption(
          y
            .option("class", { alias: "c", describe: "Class ID, slug, or name", type: "string", demandOption: true })
            .option("assignment", { alias: "a", describe: "Assignment ID or slug", type: "string", demandOption: true })
        ),
      async (args) => {
        try {
          const data = await apiCall("exams.questions", {
            class: args.class as string,
            assignment: args.assignment as string
          });
          if (emitJson(args, data)) return;

          logger.step(`Questions for ${data.assignment.title} (exam ${data.exam.id})`);
          if (!data.questions.length) {
            logger.info("No questions found.");
            return;
          }
          if (data.grading_rubric_id == null) logger.warning("The assignment has no grading rubric.");
          printTable(
            ["Question", "Path", "Points", "Type", "Rubric check IDs"],
            data.questions.map((q: Record<string, unknown>) => [
              q.question_id as number,
              q.path as string,
              q.points as number | null,
              q.answer_type as string | null,
              (q.rubric_checks as Array<{ id: number }>).map((c) => c.id).join(", ") || null
            ])
          );
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "Specify an exams action");
};

export const handler = () => {};
