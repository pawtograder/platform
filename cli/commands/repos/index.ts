/**
 * repos — student repo maintenance (Edge metadata + local git)
 *
 *   pawtograder repos list --class <id|slug> --assignment <id|slug>
 *   pawtograder repos sync-grade-workflow --class ... --assignment ... --workdir ...
 *   pawtograder repos copy-after-source-due --class ... --source-assignment ... --target-assignment ... --workdir ...
 */

import type { Argv } from "yargs";
import { apiCall } from "../../utils/api";
import { logger, handleError } from "../../utils/logger";
import { runSyncGradeWorkflow, runCrossAssignmentCopy } from "../../lib/repos";

export const command = "repos <action>";
export const describe = "Student repository tools (API metadata + local git)";

export const builder = (yargs: Argv) => {
  return yargs
    .command(
      "list",
      "List repositories for an assignment",
      (y) => {
        return y
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
      async (args) => {
        try {
          const data = await apiCall("repos.list", {
            class: args.class as string,
            assignment: args.assignment as string
          });
          logger.step(`Repositories — ${data.assignment.title}`);
          logger.info(
            `Assignment ID: ${data.assignment.id} | template_repo: ${data.assignment.template_repo ?? "(none)"}`
          );
          logger.blank();

          const repos = data.repositories as Array<{ id: number; repository: string }>;
          if (repos.length === 0) {
            logger.info("No repositories.");
            return;
          }
          logger.tableHeader(["ID", "Repository"]);
          for (const r of repos) {
            logger.tableRow([r.id, r.repository]);
          }
          logger.blank();
          logger.info(`Total: ${repos.length}`);
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "sync-grade-workflow",
      "Sync .github/workflows/grade.yml from handout to all student repos (local git)",
      (y) => {
        return y
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
          .option("workdir", {
            alias: "w",
            describe: "Local directory for git clones",
            type: "string",
            demandOption: true
          })
          .option("dry-run", {
            describe: "Preview changes only (no commit/push)",
            type: "boolean",
            default: false
          })
          .option("concurrency", {
            describe: "Parallel clone/fetch operations (1–8)",
            type: "number",
            default: 2
          })
          .option("delay-ms", {
            describe: "Delay between clone batches (ms)",
            type: "number",
            default: 0
          });
      },
      async (args) => {
        try {
          const dryRun = args.dryRun as boolean;
          if (dryRun) {
            logger.info("DRY RUN — no commit/push\n");
          }
          logger.step("Fetching context from API...");
          const raw = await apiCall("repos.sync_grade_workflow.context", {
            class: args.class as string,
            assignment: args.assignment as string
          });
          const ctx = raw as import("../../lib/repos/types").SyncGradeWorkflowContext;
          logger.info(`Assignment: ${ctx.assignment_title} (${ctx.assignment_id}) | Handout: ${ctx.template_repo}\n`);

          const concurrency = Math.min(8, Math.max(1, Number(args.concurrency) || 2));
          const delayMs = Math.max(0, Number(args["delay-ms"]) || 0);

          const result = await runSyncGradeWorkflow(ctx, {
            workDir: args.workdir as string,
            dryRun,
            concurrency,
            delayMs
          });

          if (result.errors > 0) {
            process.exitCode = 1;
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .command(
      "copy-after-source-due",
      "Copy source assignment repo trees to target after source due date (local git + rsync)",
      (y) => {
        return y
          .option("class", {
            alias: "c",
            describe: "Class ID, slug, or name",
            type: "string",
            demandOption: true
          })
          .option("source-assignment", {
            alias: "s",
            describe: "Source assignment ID or slug",
            type: "string",
            demandOption: true
          })
          .option("target-assignment", {
            alias: "t",
            describe: "Target assignment ID or slug",
            type: "string",
            demandOption: true
          })
          .option("workdir", {
            alias: "w",
            describe: "Local directory for git clones",
            type: "string",
            demandOption: true
          })
          .option("dry-run", {
            describe: "Preview with rsync -n only",
            type: "boolean",
            default: false
          })
          .option("mirror-delete", {
            describe: "Pass rsync --delete (still excludes .git)",
            type: "boolean",
            default: false
          })
          .option("concurrency", {
            describe: "Parallel clone/fetch operations (1–8)",
            type: "number",
            default: 2
          })
          .option("delay-ms", {
            describe: "Delay between clone batches (ms)",
            type: "number",
            default: 0
          });
      },
      async (args) => {
        try {
          const dryRun = args.dryRun as boolean;
          if (dryRun) {
            logger.info("DRY RUN — no commit/push\n");
          }
          logger.step("Fetching context from API...");
          const raw = await apiCall("repos.cross_assignment_copy.context", {
            class: args.class as string,
            source_assignment: args["source-assignment"] as string,
            target_assignment: args["target-assignment"] as string
          });
          const ctx = raw as import("../../lib/repos/types").CrossAssignmentCopyContext;
          logger.info(
            `Source: ${ctx.source_assignment_title} (${ctx.source_assignment_id}) → Target: ${ctx.target_assignment_title} (${ctx.target_assignment_id})\n`
          );

          const concurrency = Math.min(8, Math.max(1, Number(args.concurrency) || 2));
          const delayMs = Math.max(0, Number(args["delay-ms"]) || 0);

          const result = await runCrossAssignmentCopy(ctx, {
            workDir: args.workdir as string,
            dryRun,
            mirrorDelete: args["mirror-delete"] as boolean,
            concurrency,
            delayMs
          });

          if (result.errors > 0) {
            process.exitCode = 1;
          }
        } catch (error) {
          handleError(error);
        }
      }
    )
    .demandCommand(1, "You must specify a repos subcommand");
};

export const handler = () => {};
