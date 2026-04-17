/**
 * Discussions command group (stub)
 *
 * Usage:
 *   pawtograder discussions list --class <identifier>
 */

import type { Argv } from "yargs";
import { logger } from "../../utils/logger";

export const command = "discussions <action>";
export const describe = "Manage discussion topics";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List discussion topics for a class (stub)",
      (yargs) => {
        return yargs.option("class", {
          alias: "c",
          describe: "Class ID, slug, or name",
          type: "string",
          demandOption: true
        });
      },
      () => {
        logger.warning("discussions list: Not yet implemented");
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
