/**
 * Help Requests command group (stub)
 *
 * Usage:
 *   pawtograder help-requests list --class <identifier>
 *   pawtograder help-requests close --id <id>
 */

import type { Argv } from "yargs";
import { logger } from "../../utils/logger";

export const command = "help-requests <action>";
export const describe = "Manage help requests";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List help requests for a class (stub)",
      (yargs) => {
        return yargs
          .option("class", {
            alias: "c",
            describe: "Class ID, slug, or name",
            type: "string",
            demandOption: true
          })
          .option("status", {
            describe: "Filter by status",
            type: "string",
            choices: ["open", "closed", "all"],
            default: "all"
          });
      },
      () => {
        logger.warning("help-requests list: Not yet implemented");
      }
    )
    .command(
      "close",
      "Close a help request (stub)",
      (yargs) => {
        return yargs.option("id", {
          describe: "Help request ID",
          type: "number",
          demandOption: true
        });
      },
      () => {
        logger.warning("help-requests close: Not yet implemented");
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
