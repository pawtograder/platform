/**
 * `pawtograder submissions export` — streams submission metadata and source
 * files with the same identity modes as assessment export.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Argv, ArgumentsCamelCase } from "yargs";
import { streamApiCall } from "@/cli/utils/streamApi";
import { logger, handleError, CLIError } from "@/cli/utils/logger";
import { withTransientRetry } from "@/cli/utils/transientRetry";
import {
  addExportIdentityOptions,
  assertExpectedCount,
  generateRandomSalt,
  refToken,
  sanitizeForFilename,
  timestamp,
  writeCsv,
  writeJson,
  writeJsonArray,
  type ExportIdentityMode
} from "@/cli/utils/exportFiles";

type ExportFormat = "json" | "csv";

interface ExportArgs {
  class: string;
  assignment?: string[];
  identity: ExportIdentityMode;
  salt?: string;
  "i-understand-pii"?: boolean;
  iUnderstandPii?: boolean;
  output?: string;
  "all-submissions"?: boolean;
  allSubmissions?: boolean;
  "with-binary"?: boolean;
  withBinary?: boolean;
  format?: ExportFormat;
  "include-file"?: string[];
  includeFile?: string[];
  "exclude-file"?: string[];
  excludeFile?: string[];
  concurrency?: number;
}

type AssignmentRef = { id: number; slug: string | null; title: string | null };

const SUBMISSION_CSV_HEADERS = [
  "submission",
  "subject",
  "group",
  "ordinal",
  "sha",
  "is_active",
  "created_at",
  "repository",
  "has_final_review"
];

const FILE_CSV_HEADERS = ["submission", "name", "is_binary", "file_size", "mime_type", "binary_omitted"];

function submissionToCsvRow(record: Record<string, unknown>): Record<string, unknown> {
  const submissionRef =
    typeof record.token === "string" ? { token: record.token } : record.id !== undefined ? { id: record.id } : null;
  return {
    submission: refToken(submissionRef),
    subject: refToken(record.subject),
    group: refToken(record.group),
    ordinal: record.ordinal ?? "",
    sha: record.sha ?? "",
    is_active: record.is_active ?? "",
    created_at: record.created_at ?? "",
    repository: record.repository ?? "",
    has_final_review: record.has_final_review ?? ""
  };
}

function fileToCsvRow(record: Record<string, unknown>): Record<string, unknown> {
  return {
    submission: refToken(record.submission),
    name: record.name ?? "",
    is_binary: record.is_binary ?? "",
    file_size: record.file_size ?? "",
    mime_type: record.mime_type ?? "",
    binary_omitted: record.binary_omitted ?? ""
  };
}

function normalizePatterns(raw: string[] | undefined): string[] {
  if (!raw) return [];
  return raw.map((p) => p.trim()).filter((p) => p.length > 0);
}

export const exportBuilder = (yargs: Argv) => {
  return addExportIdentityOptions(
    yargs
      .option("class", {
        alias: "c",
        describe: "Class ID, slug, or name",
        type: "string",
        demandOption: true
      })
      .option("assignment", {
        alias: "a",
        describe:
          "Assignment selector — id, slug, or glob (e.g. 'hw-*'). Repeatable. Omit to export all assignments in the class.",
        type: "string",
        array: true
      })
      .option("output", {
        alias: "o",
        describe: "Output directory (default: ./submissions-export-<class>-<timestamp>)",
        type: "string"
      })
      .option("all-submissions", {
        describe: "Include every submission attempt, not just is_active",
        type: "boolean",
        default: false
      })
      .option("with-binary", {
        describe: "Include binary file contents as content_base64 (JSON) or binary_omitted=false (CSV index)",
        type: "boolean",
        default: false
      })
      .option("include-file", {
        describe: "Only export files whose path matches this glob (repeatable). Omit to include all paths.",
        type: "string",
        array: true
      })
      .option("exclude-file", {
        describe: "Skip files whose path matches this glob (repeatable)",
        type: "string",
        array: true
      })
      .option("format", {
        describe: "Export format — json includes file contents; csv is metadata index only",
        type: "string",
        choices: ["csv", "json"] as const,
        default: "json" as const
      })
      .option("concurrency", {
        describe: "Parallel assignment exports (1–8)",
        type: "number",
        default: 4
      })
  );
};

async function consumeCatalogStream(params: Record<string, unknown>): Promise<{
  assignments: AssignmentRef[];
  warnings: Record<string, unknown>[];
}> {
  const assignments: AssignmentRef[] = [];
  const warnings: Record<string, unknown>[] = [];
  let endRecord: Record<string, unknown> | null = null;

  for await (const record of streamApiCall({
    command: "submissions.export",
    params: { ...params, section: "catalog" }
  })) {
    switch (record.kind) {
      case "assignment":
        assignments.push({
          id: record.id as number,
          slug: (record.slug as string | null) ?? null,
          title: (record.title as string | null) ?? null
        });
        break;
      case "warning":
        warnings.push(record);
        break;
      case "end":
        endRecord = record;
        break;
      default:
        break;
    }
  }

  if (endRecord === null) throw new CLIError("Catalog stream ended without an {end} marker");
  assertExpectedCount(endRecord, "assignments", assignments.length);

  return { assignments, warnings };
}

async function consumeMetaStream(params: Record<string, unknown>): Promise<{
  manifest: Record<string, unknown>;
  submissions: Record<string, unknown>[];
  warnings: Record<string, unknown>[];
  submissionIds: number[];
}> {
  let manifest: Record<string, unknown> | null = null;
  const submissions: Record<string, unknown>[] = [];
  const warnings: Record<string, unknown>[] = [];
  let endRecord: Record<string, unknown> | null = null;

  for await (const record of streamApiCall({ command: "submissions.export", params: { ...params, section: "meta" } })) {
    switch (record.kind) {
      case "manifest":
        manifest = record;
        break;
      case "submission":
        submissions.push(record);
        break;
      case "warning":
        warnings.push(record);
        break;
      case "end":
        endRecord = record;
        break;
      default:
        break;
    }
  }

  if (manifest === null) throw new CLIError("Server stream did not include a manifest record");
  if (endRecord === null)
    throw new CLIError("Server stream ended without an {end} marker — the dump may be incomplete");

  assertExpectedCount(endRecord, "submissions", submissions.length);

  const submissionIds = endRecord.submission_ids;
  if (!Array.isArray(submissionIds)) {
    throw new CLIError("Server meta stream did not include submission_ids");
  }

  return {
    manifest,
    submissions,
    warnings,
    submissionIds: submissionIds.filter((id): id is number => typeof id === "number")
  };
}

async function consumeFilesBatches(
  params: Record<string, unknown>,
  submissionIds: number[]
): Promise<{ files: Record<string, unknown>[]; warnings: Record<string, unknown>[] }> {
  const allFiles: Record<string, unknown>[] = [];
  const allWarnings: Record<string, unknown>[] = [];
  let filesBatchIndex = 0;

  while (true) {
    const files: Record<string, unknown>[] = [];
    const warnings: Record<string, unknown>[] = [];
    let endRecord: Record<string, unknown> | null = null;

    for await (const record of streamApiCall({
      command: "submissions.export",
      params: {
        ...params,
        section: "files",
        submission_ids: submissionIds,
        files_batch_index: filesBatchIndex
      }
    })) {
      switch (record.kind) {
        case "file":
          files.push(record);
          break;
        case "warning":
          warnings.push(record);
          break;
        case "end":
          endRecord = record;
          break;
        default:
          break;
      }
    }

    if (endRecord === null)
      throw new CLIError("Files stream ended without an {end} marker — the dump may be incomplete");
    assertExpectedCount(endRecord, "files", files.length);

    allFiles.push(...files);
    allWarnings.push(...warnings);

    const next = endRecord.next_files_batch_index;
    if (typeof next !== "number") break;
    filesBatchIndex = next;
  }

  return { files: allFiles, warnings: allWarnings };
}

async function exportOneAssignment(
  baseParams: Record<string, unknown>,
  assignment: AssignmentRef,
  dir: string,
  format: ExportFormat
): Promise<{ submissions: number; files: number; manifest: Record<string, unknown> }> {
  const slug = String(assignment.slug ?? assignment.id);
  const params = { ...baseParams, assignment: assignment.id };

  const meta = await withTransientRetry(() => consumeMetaStream(params), {
    onRetry: (attempt, err, delayMs) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warning(`${slug} meta: transient error on attempt ${attempt} (${message}); retrying in ${delayMs}ms`);
    }
  });

  for (const w of meta.warnings) {
    logger.warning(`${slug}: ${String(w.scope)}: ${String(w.message)}`);
  }

  const { files, warnings: fileWarnings } = await withTransientRetry(
    () => consumeFilesBatches(params, meta.submissionIds),
    {
      onRetry: (attempt, err, delayMs) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warning(`${slug} files: transient error on attempt ${attempt} (${message}); retrying in ${delayMs}ms`);
      }
    }
  );

  for (const w of fileWarnings) {
    logger.warning(`${slug}: ${String(w.scope)}: ${String(w.message)} — ${JSON.stringify(w)}`);
  }

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const assignmentManifest = {
    ...meta.manifest,
    totals: {
      submissions: meta.submissions.length,
      files: files.length
    },
    format
  };

  writeJson(path.join(dir, "manifest.json"), assignmentManifest);

  if (format === "json") {
    writeJsonArray(path.join(dir, "submissions.json"), meta.submissions);
    writeJsonArray(path.join(dir, "files.json"), files);
  } else {
    writeCsv(path.join(dir, "submissions.csv"), SUBMISSION_CSV_HEADERS, meta.submissions.map(submissionToCsvRow));
    writeCsv(path.join(dir, "files.csv"), FILE_CSV_HEADERS, files.map(fileToCsvRow));
  }

  return {
    submissions: meta.submissions.length,
    files: files.length,
    manifest: assignmentManifest
  };
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIdx = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= tasks.length) return;
      results[idx] = await tasks[idx]!();
    }
  });
  await Promise.all(workers);
  return results;
}

export async function exportHandler(args: ArgumentsCamelCase<ExportArgs>): Promise<void> {
  try {
    const mode = args.identity;
    const format = (args.format ?? "json") as ExportFormat;
    const salt = mode === "raw" ? null : mode === "hash" ? args.salt! : generateRandomSalt();
    const dumpId = crypto.randomUUID();
    const includeFiles = normalizePatterns(args.includeFile ?? args["include-file"]);
    const excludeFiles = normalizePatterns(args.excludeFile ?? args["exclude-file"]);
    const concurrency = Math.max(1, Math.min(8, args.concurrency ?? 4));

    const outputDir =
      args.output ?? path.join(process.cwd(), `submissions-export-${sanitizeForFilename(args.class)}-${timestamp()}`);

    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(outputDir, 0o700);
    } catch {
      // Best-effort on platforms where chmod is a no-op (e.g. Windows).
    }

    logger.step(`Exporting submissions for class: ${args.class}`);
    logger.info(`Output: ${outputDir}`);
    logger.info(
      `Identity mode: ${mode}${mode === "opaque" ? " (random per-run salt)" : mode === "hash" ? " (same --salt joins dumps on this deployment)" : ""}`
    );
    logger.info(`Format: ${format}`);
    logger.info(`Dump id: ${dumpId}`);
    if (args.allSubmissions === true) {
      logger.info("Submissions: all attempts (--all-submissions); default is is_active only");
    }
    if (args.withBinary === true) {
      logger.info("Binary files: included (--with-binary)");
    }
    if (includeFiles.length > 0) {
      logger.info(`File include globs: ${includeFiles.join(", ")}`);
    }
    if (excludeFiles.length > 0) {
      logger.info(`File exclude globs: ${excludeFiles.join(", ")}`);
    }
    if (mode === "raw") {
      logger.warning(
        "Real student ids, emails, and names will be written to disk. Handle the output directory accordingly."
      );
    }

    const baseParams: Record<string, unknown> = {
      class: args.class,
      identity_mode: mode,
      dump_id: dumpId,
      all_submissions: args.allSubmissions === true,
      with_binary: args.withBinary === true
    };
    if (salt !== null) baseParams.salt = salt;
    if (mode === "raw") baseParams.confirm_pii = true;
    if (includeFiles.length > 0) baseParams.include_files = includeFiles;
    if (excludeFiles.length > 0) baseParams.exclude_files = excludeFiles;
    if (args.assignment && args.assignment.length > 0) baseParams.assignments = args.assignment;

    const catalog = await withTransientRetry(() => consumeCatalogStream(baseParams), {
      onRetry: (attempt, err, delayMs) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warning(`catalog: transient error on attempt ${attempt} (${message}); retrying in ${delayMs}ms`);
      }
    });

    for (const w of catalog.warnings) {
      logger.warning(`assignments: ${String(w.message)} — ${JSON.stringify(w.selectors)}`);
    }

    if (catalog.assignments.length === 0) {
      throw new CLIError("No assignments matched the given selectors");
    }

    const multiAssignment = catalog.assignments.length > 1;
    const assignmentsRoot = multiAssignment ? path.join(outputDir, "assignments") : outputDir;
    if (multiAssignment) {
      fs.mkdirSync(assignmentsRoot, { recursive: true, mode: 0o700 });
    }

    const perAssignment = await runWithConcurrency(
      catalog.assignments.map((assignment) => async () => {
        const slug = sanitizeForFilename(String(assignment.slug ?? assignment.id));
        const dir = path.join(assignmentsRoot, slug);
        const totals = await exportOneAssignment(baseParams, assignment, dir, format);
        logger.info(`  ${slug}: ${totals.submissions} submissions, ${totals.files} files`);
        return { assignment, ...totals };
      }),
      concurrency
    );

    const grandSubmissions = perAssignment.reduce((n, r) => n + r.submissions, 0);
    const grandFiles = perAssignment.reduce((n, r) => n + r.files, 0);

    const rootManifest: Record<string, unknown> = {
      schema_version: 1,
      dump_id: dumpId,
      identity_mode: mode,
      exported_at: new Date().toISOString(),
      format,
      class: { id: undefined, slug: undefined, name: undefined },
      assignments: perAssignment.map((r) => ({
        id: r.assignment.id,
        slug: r.assignment.slug,
        title: r.assignment.title,
        submissions: r.submissions,
        files: r.files
      })),
      totals: { submissions: grandSubmissions, files: grandFiles },
      ...(includeFiles.length > 0 ? { include_files: includeFiles } : {}),
      ...(excludeFiles.length > 0 ? { exclude_files: excludeFiles } : {}),
      ...(args.allSubmissions === true ? { all_submissions: true } : {}),
      ...(args.withBinary === true ? { with_binary: true } : {})
    };

    // Re-use class info from the first per-assignment manifest when available.
    const firstManifest = perAssignment[0]?.manifest;
    if (firstManifest && typeof firstManifest.class === "object") {
      rootManifest.class = firstManifest.class;
    }

    writeJson(path.join(outputDir, "manifest.json"), rootManifest);

    logger.success(
      `Exported ${grandSubmissions} submissions and ${grandFiles} files across ${catalog.assignments.length} assignment(s) to ${outputDir}`
    );
  } catch (error) {
    handleError(error);
  }
}
