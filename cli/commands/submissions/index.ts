/**
 * Submissions command group
 *
 * Usage:
 *   pawtograder submissions comments import --file batch-results.json --class <id> --assignment <id> --author-profile-id <uuid>
 *   pawtograder submissions artifacts import --file manifest.json --class <id> --assignment <id> [--overwrite]
 */

import type { Argv } from "yargs";
import { logger } from "../../utils/logger";
import { buildCommentsCommands } from "./comments";
import { buildArtifactsCommands } from "./artifacts";

export const command = "submissions <action>";
export const describe = "Manage submissions";

export const builder = (yargs: Argv) => {
  return yargs
    .command("comments", "Batch import or sync submission comments (file / artifact / submission-level)", (y) =>
      buildCommentsCommands(y)
    )
    .command("artifacts", "Import submission artifact blobs from a manifest", (y) =>
      buildArtifactsCommands(y).demandCommand(1, "Specify artifacts import")
    )
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
