/**
 * submissions comments import|sync — batch file / artifact / submission comments via CLI API.
 */

import type { Argv } from "yargs";
import * as fs from "fs";
import { apiCall } from "../../utils/api";
import { logger, handleError, CLIError } from "../../utils/logger";

export function buildCommentsCommands(yargs: Argv): Argv {
  const common = (y: Argv) =>
    y
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
      .option("file", {
        alias: "f",
        describe: "JSON file (batch-results.json or manifest with file_comments / violations / …)",
        type: "string",
        demandOption: true
      })
      .option("author-profile-id", {
        describe: "Profile UUID for comment author (or use --rubric-part-id)",
        type: "string"
      })
      .option("rubric-part-id", {
        describe: "Rubric part ID — assignee from review_assignments used as author",
        type: "number"
      })
      .option("dry-run", {
        describe: "Validate and summarize only",
        type: "boolean",
        default: false
      });

  return yargs
    .command(
      "import",
      "Import comments (add-only inserts; no sync deletes)",
      (y) => common(y),
      async (args) => {
        await runCommentsCommand(args, "import");
      }
    )
    .command(
      "sync",
      "Sync comments (insert then soft-delete rubric checks missing from payload)",
      (y) => common(y),
      async (args) => {
        await runCommentsCommand(args, "sync");
      }
    )
    .demandCommand(1, "Specify import or sync");
}

async function runCommentsCommand(args: Record<string, unknown>, mode: "import" | "sync"): Promise<void> {
  try {
    const filePath = args.file as string;
    if (!fs.existsSync(filePath)) {
      throw new CLIError(`File not found: ${filePath}`);
    }
    const rawText = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(rawText) as Record<string, unknown>;

    const authorProfileId = args["author-profile-id"] as string | undefined;
    const rubricPartId = args["rubric-part-id"] as number | undefined;
    if (authorProfileId && rubricPartId != null) {
      throw new CLIError("Use only one of --author-profile-id or --rubric-part-id");
    }
    if (!authorProfileId && rubricPartId == null) {
      throw new CLIError("One of --author-profile-id or --rubric-part-id is required");
    }

    const raw = normalizeRawFromFile(parsed);

    logger.step(`${mode === "sync" ? "Sync" : "Import"} submission comments…`);
    const cmd = mode === "sync" ? "submissions.comments.sync" : "submissions.comments.import";
    const data = await apiCall(cmd, {
      class: args.class as string,
      assignment: args.assignment as string,
      raw,
      author_profile_id: authorProfileId ?? null,
      rubric_part_id: rubricPartId ?? null,
      dry_run: args["dry-run"] === true
    });

    logger.success("Done");
    const skippedNoAssignee = data.skipped_without_review_assignee ?? data.skipped_inactive_without_review_assignee;
    if (Array.isArray(skippedNoAssignee) && skippedNoAssignee.length > 0) {
      logger.warning(
        `Skipped comments for ${skippedNoAssignee.length} submission(s) with no review assignee: ${skippedNoAssignee.join(", ")}`
      );
    }
    logger.info(JSON.stringify(data.summary, null, 2));
    if (Array.isArray(data.errors) && data.errors.length > 0) {
      logger.warning(`${data.errors.length} error detail row(s); see JSON`);
      logger.info(JSON.stringify(data.errors.slice(0, 50), null, 2));
      if (data.errors.length > 50) logger.info("… truncated …");
    }
  } catch (error) {
    handleError(error);
  }
}

/** Accept either generalized shape or legacy batch-results.json */
function normalizeRawFromFile(parsed: Record<string, unknown>): Record<string, unknown> {
  const file_comments = parsed.file_comments;
  const artifact_comments = parsed.artifact_comments;
  const submission_comments = parsed.submission_comments;
  const violations = parsed.violations;
  const partial_credits = parsed.partial_credits;
  const summary = parsed.summary;
  const sync_submission_ids = parsed.sync_submission_ids;

  return {
    file_comments,
    artifact_comments,
    submission_comments,
    violations,
    partial_credits,
    summary,
    sync_submission_ids
  };
}
