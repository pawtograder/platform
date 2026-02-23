/**
 * Classes command group
 *
 * Usage:
 *   pawtograder classes list
 *   pawtograder classes show <identifier>
 */

import type { Argv } from "yargs";
import { callCLI } from "../../utils/api";
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
          const data = await callCLI("classes.list");

          if (!data.classes || data.classes.length === 0) {
            logger.info("No classes found.");
            return;
          }

          logger.tableHeader(["ID", "Slug", "Name", "GitHub Org"]);
          for (const c of data.classes) {
            logger.tableRow([c.id, c.slug, c.name, c.github_org]);
          }
          logger.blank();
          logger.info(`Total: ${data.classes.length} classes`);
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
          const data = await callCLI("classes.show", {
            identifier: args.identifier as string
          });
          const c = data.class;

          logger.step(`Class: ${c.name}`);
          logger.info(`ID: ${c.id}`);
          logger.info(`Slug: ${c.slug}`);
          logger.info(`Semester: ${c.semester}`);
          logger.info(`GitHub Org: ${c.github_org || "(not set)"}`);
          logger.info(`Timezone: ${c.time_zone || "(not set)"}`);
          logger.info(`Canvas ID: ${c.canvas_id || "(not set)"}`);
          logger.info(`Demo: ${c.is_demo ? "Yes" : "No"}`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
