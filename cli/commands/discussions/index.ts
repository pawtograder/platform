/**
 * Discussions command group
 *
 * Usage:
 *   pawtograder discussions list --class <identifier> [--json]
 */

import type { Argv } from "yargs";
import { apiCall } from "@/cli/utils/api";
import { logger, handleError } from "@/cli/utils/logger";
import { addJsonOption, emitJson, printTable, truncate } from "@/cli/utils/output";

export const command = "discussions <action>";
export const describe = "Manage discussion topics";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List discussion topics for a class, with thread and question counts",
      (yargs) => {
        return addJsonOption(
          yargs.option("class", {
            alias: "c",
            describe: "Class ID, slug, or name",
            type: "string",
            demandOption: true
          })
        );
      },
      async (args) => {
        try {
          const data = await apiCall("discussions.list", { class: args.class as string });

          if (emitJson(args, data)) return;

          logger.step(`Discussion topics for ${data.class.name}`);

          const topics = data.topics ?? [];
          if (topics.length === 0) {
            logger.info("No discussion topics found.");
            return;
          }

          printTable(
            ["ID", "Topic", "Threads", "Questions", "Unanswered", "Assignment", "Description"],
            topics.map((t: Record<string, unknown>) => [
              t.id as number,
              t.topic as string,
              t.threads as number,
              t.questions as number,
              t.unanswered_questions as number,
              (t.assignment_slug as string | null) ?? null,
              truncate(t.description as string | null, 40)
            ])
          );

          logger.blank();
          const { topics: topicCount, threads, questions, unanswered_questions } = data.summary;
          logger.info(`Total: ${topicCount} topic(s), ${threads} thread(s), ${questions} question(s)`);
          if (unanswered_questions > 0) {
            logger.warning(`Unanswered questions: ${unanswered_questions}`);
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
