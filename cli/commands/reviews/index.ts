/**
 * Reviews command group (stub)
 *
 * Usage:
 *   pawtograder reviews list --assignment <identifier> --class <identifier>
 *   pawtograder reviews assign --assignment <identifier> --class <identifier>
 */

import type { Argv } from "yargs";
import { logger } from "../../utils/logger";

export const command = "reviews <action>";
export const describe = "Manage submission reviews and review assignments";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List reviews for an assignment (stub)",
      (yargs) => {
        return yargs
          .option("class", {
            alias: "c",
            describe: "Class ID, slug, or name",
            type: "string",
            demandOption: true
          })
          .option("assignment", {
            alias: "a",
            describe: "Assignment ID or slug",
            type: "string",
            demandOption: true
          });
      },
      () => {
        logger.warning("reviews list: Not yet implemented");
      }
    )
    .command(
      "assign",
      "Create review assignments (stub)",
      (yargs) => {
        return yargs
          .option("class", {
            alias: "c",
            describe: "Class ID, slug, or name",
            type: "string",
            demandOption: true
          })
          .option("assignment", {
            alias: "a",
            describe: "Assignment ID or slug",
            type: "string",
            demandOption: true
          });
      },
      () => {
        logger.warning("reviews assign: Not yet implemented");
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
