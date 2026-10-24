/**
 * Classes command group
 *
 * Usage:
 *   pawtograder classes list
 *   pawtograder classes show <identifier>
 */

import type { Argv } from "yargs";
import { apiCall } from "@/cli/utils/api";
import { logger, handleError } from "@/cli/utils/logger";
import { addJsonOption, emitJson, printTable } from "@/cli/utils/output";

export const command = "classes <action>";
export const describe = "Manage classes";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List all classes",
      (yargs) => addJsonOption(yargs),
      async (args) => {
        try {
          const data = await apiCall("classes.list");

          if (emitJson(args, data)) return;

          logger.step("Classes");
          const classes = data.classes;

          if (classes.length === 0) {
            logger.info("No classes found.");
            return;
          }

          printTable(
            ["ID", "Slug", "Name", "Term", "GitHub Org"],
            classes.map((c: Record<string, unknown>) => [
              c.id as number,
              c.slug as string,
              c.name as string,
              c.term as number | null,
              c.github_org as string | null
            ])
          );
          logger.blank();
          logger.info(`Total: ${classes.length} classes`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "show <identifier>",
      "Show details for a class",
      (yargs) => {
        return yargs.positional("identifier", {
          describe: "Class ID, slug, or name",
          type: "string",
          demandOption: true
        });
      },
      async (args) => {
        try {
          const data = await apiCall("classes.show", { identifier: args.identifier as string });
          const classData = data.class;

          logger.step(`Class: ${classData.name}`);
          logger.info(`ID: ${classData.id}`);
          logger.info(`Slug: ${classData.slug}`);
          logger.info(`Semester: ${classData.semester ?? "(not set)"}`);
          logger.info(`GitHub Org: ${classData.github_org || "(not set)"}`);
          logger.info(`Timezone: ${classData.time_zone || "(not set)"}`);
          logger.info(`Demo: ${classData.is_demo ? "Yes" : "No"}`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
