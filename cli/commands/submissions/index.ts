/**
 * Submissions command group (stub)
 *
 * Usage:
 *   pawtograder submissions list --assignment <identifier> --class <identifier>
 *   pawtograder submissions export --assignment <identifier> --class <identifier>
 */

import type { Argv } from "yargs";
import { logger } from "../../utils/logger";

export const command = "submissions <action>";
export const describe = "Manage submissions";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List submissions for an assignment (stub)",
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
        logger.warning("submissions list: Not yet implemented");
      }
    )
    .command(
      "export",
      "Export submissions for an assignment (stub)",
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
          })
          .option("format", {
            describe: "Export format",
            type: "string",
            choices: ["csv", "json"],
            default: "csv"
          });
      },
      () => {
        logger.warning("submissions export: Not yet implemented");
      }
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
