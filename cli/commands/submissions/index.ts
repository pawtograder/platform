/**
 * Submissions command group
 *
 * Usage:
 *   pawtograder submissions export -c <class> [-a hw-*] [--include-file 'src/**'] [--exclude-file 'build/**']
 *   pawtograder submissions comments import --file batch-results.json --class <id> --assignment <id> --author-profile-id <uuid>
 *   pawtograder submissions artifacts import --file manifest.json --class <id> --assignment <id> [--overwrite]
 */

import type { Argv } from "yargs";
import { logger } from "@/cli/utils/logger";
import { buildCommentsCommands } from "./comments";
import { buildArtifactsCommands } from "./artifacts";
import { exportBuilder, exportHandler } from "./export";

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
      "Export submission metadata and source files for an assignment",
      (yargs) => exportBuilder(yargs),
      exportHandler
    )
    .demandCommand(1, "You must specify an action");
};

export const handler = () => {};
