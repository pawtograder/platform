/**
 * submissions artifacts import — upload submission artifact blobs via CLI API.
 */

import type { Argv } from "yargs";
import * as fs from "fs";
import * as path from "path";
import { apiCall } from "../../utils/api";
import { logger, handleError, CLIError } from "../../utils/logger";

const DEFAULT_BATCH = 5;

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
        })
        .option("batch-size", {
          describe: "Artifacts per API request (smaller = smaller payloads, less gateway timeout risk). Default 5.",
          type: "number",
          default: DEFAULT_BATCH
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

        const batchSize = Math.max(1, Math.floor(Number(args["batch-size"]) || DEFAULT_BATCH));
        const totalBatches = Math.ceil(resolved.length / batchSize);
        logger.step(`Importing ${resolved.length} artifact(s) in ${totalBatches} batch(es) of up to ${batchSize}…`);
        if (process.env.PAWTOGRADER_HTTP_TIMEOUT_MS === undefined) {
          logger.info(
            "Tip: set PAWTOGRADER_HTTP_TIMEOUT_MS=600000 (10 min) if requests time out; use DEBUG=1 to log each HTTP call."
          );
        }
        const totals = { uploaded: 0, skipped: 0, overwritten: 0, errors: 0 };
        const allErrors: unknown[] = [];

        for (let i = 0; i < resolved.length; i += batchSize) {
          const batch = resolved.slice(i, i + batchSize);
          const batchNum = Math.floor(i / batchSize) + 1;
          const estChars = batch.reduce((n, a) => n + a.content_base64.length, 0);
          const estMb = estChars / (1024 * 1024);
          logger.info(
            `Batch ${batchNum}/${totalBatches}: ${batch.length} artifact(s), ~${estMb.toFixed(2)} MiB base64 payload…`
          );
          if (estMb > 5) {
            logger.warning(
              "This batch is large; the gateway may reject or time out. Try --batch-size 1 or split the manifest."
            );
          }
          const t0 = Date.now();
          const data = await apiCall("submissions.artifacts.import", {
            class: args.class as string,
            assignment: args.assignment as string,
            artifacts: batch,
            overwrite: args.overwrite === true,
            dry_run: args["dry-run"] === true
          });
          logger.info(`Batch ${batchNum} finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
