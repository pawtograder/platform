/**
 * Classes command group
 *
 * Usage:
 *   pawtograder classes list
 *   pawtograder classes show <identifier>
 */

import type { Argv } from "yargs";
import { listClasses, resolveClass } from "../../utils/db";
import { logger, handleError } from "../../utils/logger";

export const command = "classes <action>";
export const describe = "Manage classes";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List all classes",
      () => {},
      async () => {
        try {
          logger.step("Listing classes...");
          const classes = await listClasses();

          if (classes.length === 0) {
            logger.info("No classes found.");
            return;
          }

          logger.tableHeader(["ID", "Slug", "Name", "GitHub Org"]);
          for (const c of classes) {
            logger.tableRow([c.id, c.slug, c.name, c.github_org]);
          }
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
          const classData = await resolveClass(args.identifier as string);

          logger.step(`Class: ${classData.name}`);
          logger.info(`ID: ${classData.id}`);
          logger.info(`Slug: ${classData.slug}`);
          logger.info(`Semester: ${classData.semester}`);
          logger.info(`GitHub Org: ${classData.github_org || "(not set)"}`);
          logger.info(`Timezone: ${classData.time_zone || "(not set)"}`);
          logger.info(`Canvas ID: ${classData.canvas_id || "(not set)"}`);
          logger.info(`Demo: ${classData.is_demo ? "Yes" : "No"}`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
