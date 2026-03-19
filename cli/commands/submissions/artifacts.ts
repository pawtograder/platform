/**
 * submissions artifacts import — upload submission artifact blobs via CLI API.
 */

import type { Argv } from "yargs";
import * as fs from "fs";
import * as path from "path";
import { apiCall } from "../../utils/api";
import { logger, handleError, CLIError } from "../../utils/logger";

const BATCH = 15;

interface ManifestEntry {
  submission_id: number;
  name: string;
  data: { format: string; display: string };
  content_base64?: string;
  content_file?: string;
}

export function buildArtifactsCommands(yargs: Argv): Argv {
  return yargs.command(
    "import",
    "Import submission artifacts (base64 or content_file paths in manifest)",
    (y) =>
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
          describe: "JSON manifest with artifacts[]",
          type: "string",
          demandOption: true
        })
        .option("overwrite", {
          describe: "Replace existing artifact with same name on submission",
          type: "boolean",
          default: false
        })
        .option("dry-run", {
          describe: "Preview counts only",
          type: "boolean",
          default: false
        }),
    async (args) => {
      try {
        const manifestPath = args.file as string;
        if (!fs.existsSync(manifestPath)) {
          throw new CLIError(`File not found: ${manifestPath}`);
        }
        const dir = path.dirname(path.resolve(manifestPath));
        const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { artifacts?: ManifestEntry[] };
        const entries = parsed.artifacts;
        if (!entries?.length) {
          throw new CLIError("Manifest must include non-empty artifacts array");
        }

        const resolved: Array<{
          submission_id: number;
          name: string;
          data: { format: string; display: string };
          content_base64: string;
        }> = [];

        for (const e of entries) {
          let b64 = e.content_base64;
          if (!b64 && e.content_file) {
            const abs = path.isAbsolute(e.content_file) ? e.content_file : path.join(dir, e.content_file);
            if (!fs.existsSync(abs)) {
              throw new CLIError(`content_file not found: ${abs}`);
            }
            b64 = fs.readFileSync(abs).toString("base64");
          }
          if (!b64) {
            throw new CLIError(`Artifact ${e.name} needs content_base64 or content_file`);
          }
          resolved.push({
            submission_id: e.submission_id,
            name: e.name,
            data: e.data,
            content_base64: b64
          });
        }

        logger.step(`Importing ${resolved.length} artifact(s) in batches of ${BATCH}…`);
        const totals = { uploaded: 0, skipped: 0, overwritten: 0, errors: 0 };
        const allErrors: unknown[] = [];

        for (let i = 0; i < resolved.length; i += BATCH) {
          const batch = resolved.slice(i, i + BATCH);
          const data = await apiCall("submissions.artifacts.import", {
            class: args.class as string,
            assignment: args.assignment as string,
            artifacts: batch,
            overwrite: args.overwrite === true,
            dry_run: args["dry-run"] === true
          });
          const s = data.summary;
          if (s) {
            totals.uploaded += Number(s.uploaded ?? 0);
            totals.skipped += Number(s.skipped ?? 0);
            totals.overwritten += Number(s.overwritten ?? 0);
            totals.errors += Number(s.errors ?? 0);
          }
          if (Array.isArray(data.errors)) {
            allErrors.push(...data.errors);
          }
        }

        logger.success("Artifacts import complete");
        logger.info(JSON.stringify(totals, null, 2));
        if (allErrors.length) {
          logger.warning("Errors:");
          logger.info(JSON.stringify(allErrors.slice(0, 30), null, 2));
        }
      } catch (error) {
        handleError(error);
      }
    }
  );
}
