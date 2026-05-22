/**
 * `pawtograder assessment export` — streams a class snapshot to a directory.
 *
 * Thin slice (current): writes manifest.json, subjects.json, sections.json
 * by consuming the assessment.export.preamble NDJSON stream. Per-assignment
 * facts (rubrics, scores, tests, hints) and gradebook are wired in later.
 *
 * Identity modes:
 *   --identity opaque (default) — random per-run salt, intra-dump only
 *   --identity hash             — deterministic from --salt; joinable across runs
 *   --identity raw              — real ids/emails/names; needs --i-understand-pii
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { Argv, ArgumentsCamelCase } from "yargs";
import { streamApiCall } from "@/cli/utils/streamApi";
import { logger, handleError, CLIError } from "@/cli/utils/logger";
import { withTransientRetry } from "@/cli/utils/transientRetry";

type IdentityMode = "raw" | "hash" | "opaque";

interface ExportArgs {
  class: string;
  identity: IdentityMode;
  salt?: string;
  "i-understand-pii"?: boolean;
  iUnderstandPii?: boolean;
  output?: string;
  assignment?: string[];
  "gradebook-column"?: string[];
  gradebookColumn?: string[];
  concurrency?: number;
  "with-test-output"?: boolean;
  withTestOutput?: boolean;
  "test-output-max-bytes"?: number;
  testOutputMaxBytes?: number;
}

export const exportBuilder = (yargs: Argv) => {
  return yargs
    .option("class", {
      alias: "c",
      describe: "Class ID, slug, or name",
      type: "string",
      demandOption: true
    })
    .option("identity", {
      describe: "Subject identifier mode",
      type: "string",
      choices: ["raw", "hash", "opaque"] as const,
      default: "opaque" as const
    })
    .option("salt", {
      describe: "Salt for identity=hash (required); ignored for identity=opaque (random salt is generated per run)",
      type: "string"
    })
    .option("i-understand-pii", {
      describe: "Required to use identity=raw — acknowledges that real student PII will be written to disk",
      type: "boolean",
      default: false
    })
    .option("output", {
      alias: "o",
      describe: "Output directory (default: ./assessment-export-<class>-<timestamp>)",
      type: "string"
    })
    .option("assignment", {
      alias: "a",
      describe:
        "Assignment selector — id, slug, or glob (e.g. 'hw-*'). Repeatable. Omit to export all assignments in the class.",
      type: "string",
      array: true
    })
    .option("gradebook-column", {
      describe:
        "Gradebook column selector — id, slug, or glob. Repeatable. Omit to export all columns (instructor_only included).",
      type: "string",
      array: true
    })
    .option("concurrency", {
      describe: "Parallel per-assignment streams (1–8)",
      type: "number",
      default: 4
    })
    .option("with-test-output", {
      describe: "Include grader_result_tests.output (truncated). Off by default — outputs can be MB each.",
      type: "boolean",
      default: false
    })
    .option("test-output-max-bytes", {
      describe: "Per-test output cap when --with-test-output is set (default 4096)",
      type: "number",
      default: 4096
    })
    .check((argv) => {
      if (argv.identity === "raw" && !argv["i-understand-pii"]) {
        throw new Error(
          "--identity raw requires --i-understand-pii to acknowledge that real student data will be written to disk"
        );
      }
      if (argv.identity === "hash" && !argv.salt) {
        throw new Error("--identity hash requires --salt (any string of length >= 16)");
      }
      if (argv.identity === "hash" && argv.salt && argv.salt.length < 16) {
        throw new Error("--salt must be at least 16 characters");
      }
      return true;
    });
};

export async function exportHandler(args: ArgumentsCamelCase<ExportArgs>): Promise<void> {
  try {
    const mode = args.identity;
    const salt = mode === "raw" ? null : mode === "hash" ? args.salt! : generateRandomSalt();
    const dumpId = crypto.randomUUID();

    const outputDir =
      args.output ?? path.join(process.cwd(), `assessment-export-${sanitizeForFilename(args.class)}-${timestamp()}`);

    // 0o700 so other local users can't read PII even if they have shell
    // access on a multi-user host. mkdirSync's mode arg only affects the
    // final segment — chmod the path explicitly to defend against existing
    // intermediate dirs being more permissive.
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(outputDir, 0o700);
    } catch {
      // Best-effort on platforms where chmod is a no-op (e.g. Windows).
    }

    logger.step(`Exporting assessment data for class: ${args.class}`);
    logger.info(`Output: ${outputDir}`);
    logger.info(`Identity mode: ${mode}${mode === "opaque" ? " (random per-run salt, intra-dump only)" : ""}`);
    logger.info(`Dump id: ${dumpId}`);
    if (mode === "raw") {
      logger.warning(
        "Real student ids, emails, and names will be written to disk. Handle the output directory accordingly."
      );
    }

    const params: Record<string, unknown> = {
      class: args.class,
      identity_mode: mode,
      dump_id: dumpId
    };
    if (salt !== null) params.salt = salt;
    if (mode === "raw") params.confirm_pii = true;
    if (args.assignment && args.assignment.length > 0) params.assignments = args.assignment;
    if (args.gradebookColumn && args.gradebookColumn.length > 0) params.gradebook_columns = args.gradebookColumn;

    let manifest: Record<string, unknown> | null = null;
    const subjects: Record<string, unknown>[] = [];
    const sections: Record<string, unknown>[] = [];
    const assignments: Record<string, unknown>[] = [];
    const gradebookColumns: Record<string, unknown>[] = [];
    const warnings: Record<string, unknown>[] = [];
    let endRecord: Record<string, unknown> | null = null;

    for await (const record of streamApiCall({ command: "assessment.export.preamble", params })) {
      switch (record.kind) {
        case "manifest":
          manifest = record;
          break;
        case "subject":
          subjects.push(record);
          break;
        case "section":
          sections.push(record);
          break;
        case "assignment":
          assignments.push(record);
          break;
        case "gradebook_column":
          gradebookColumns.push(record);
          break;
        case "warning":
          warnings.push(record);
          break;
        case "end":
          endRecord = record;
          break;
        default:
          // Forward-compat: unknown kinds are ignored so future server-side
          // additions don't break older CLIs.
          break;
      }
    }

    for (const w of warnings) {
      logger.warning(`${String(w.scope)}: ${String(w.message)} — ${JSON.stringify(w.selectors)}`);
    }

    if (manifest === null) {
      throw new CLIError("Server stream did not include a manifest record");
    }
    if (endRecord === null) {
      throw new CLIError("Server stream ended without an {end} marker — the dump may be incomplete");
    }

    // Cross-check server-reported counts against what we actually buffered.
    // A truncated stream that happens to flush an {end} line — e.g. a
    // crashing server that wrote the header before failing on a subject
    // page — would otherwise be accepted silently.
    assertExpectedCount(endRecord, "subjects", subjects.length);
    assertExpectedCount(endRecord, "sections", sections.length);
    assertExpectedCount(endRecord, "assignments", assignments.length);
    assertExpectedCount(endRecord, "gradebook_columns", gradebookColumns.length);

    writeJson(path.join(outputDir, "manifest.json"), manifest);
    writeJson(path.join(outputDir, "subjects.json"), subjects);
    writeJson(path.join(outputDir, "sections.json"), sections);
    writeJson(path.join(outputDir, "assignments.json"), assignments);
    writeJson(path.join(outputDir, "gradebook-columns.json"), gradebookColumns);

    logger.success(
      `Preamble: ${subjects.length} subjects, ${sections.length} sections, ${assignments.length} assignments, ${gradebookColumns.length} gradebook columns`
    );

    // Phase 2: parallel per-assignment streams + one gradebook stream.
    const assignmentsDir = path.join(outputDir, "assignments");
    fs.mkdirSync(assignmentsDir, { recursive: true, mode: 0o700 });

    const concurrency = Math.max(1, Math.min(8, args.concurrency ?? 4));
    const perAssignmentTotals = await runWithConcurrency(
      assignments.map((a) => async () => {
        const slug = String(a.slug ?? a.id);
        const dir = path.join(assignmentsDir, sanitizeForFilename(slug));
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const totals = await streamAssignmentToDir(args, salt, mode, dumpId, a.id as number, slug, dir);
        logger.info(
          `  ${slug}: ${totals.submissions} submissions, ${totals.scores} scores, ${totals.grader_tests} tests, ${totals.hints} hints, ${totals.error_pin_engagement} error-pin engagement rows`
        );
        return totals;
      }),
      concurrency
    );

    const gradebookTotals = await streamGradebookToDir(args, salt, mode, dumpId, outputDir);
    logger.info(`  gradebook: ${gradebookTotals.gradebook_scores} private cells`);

    // Backfill the manifest with grand totals across all phases. Doing this
    // post-hoc avoids racing the preamble (which doesn't know how many
    // submissions/scores will arrive across the per-assignment fan-out).
    const grand = aggregateTotals(perAssignmentTotals, gradebookTotals);
    const enrichedManifest = { ...manifest, totals: grand };
    writeJson(path.join(outputDir, "manifest.json"), enrichedManifest);

    logger.success(
      `Done. ${assignments.length} assignment(s), ${grand.submissions} submissions, ${grand.scores} scores, ${grand.grader_tests} tests, ${grand.hints} hints, ${grand.error_pin_engagement} error-pin engagement rows, ${grand.gradebook_scores} gradebook cells in ${outputDir}`
    );
  } catch (error) {
    handleError(error);
  }
}

function writeJson(filePath: string, data: unknown): void {
  // 0o600 so PII files match the 0o700 directory's posture. writeFileSync's
  // mode option only applies on file creation; chmod afterwards covers the
  // overwrite case where the file already existed with looser perms.
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms where chmod is a no-op (e.g. Windows).
  }
}

/**
 * Confirm the server-reported count for a section matches what we actually
 * received. Stops a partially-flushed stream from being silently accepted
 * just because it happened to include the trailing {end} line.
 */
function assertExpectedCount(endRecord: Record<string, unknown>, field: string, actual: number): void {
  const counts = endRecord.counts as Record<string, unknown> | undefined;
  const expected = counts?.[field];
  if (typeof expected !== "number") return; // server didn't report this count; nothing to verify
  if (expected !== actual) {
    throw new CLIError(
      `Stream count mismatch for ${field}: server reported ${expected} but received ${actual}. ` +
        "The dump is incomplete; do not use it for analysis."
    );
  }
}

function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * 32 bytes of OS entropy, base32-encoded. Mirrors the server-side
 * generateRandomSalt() so opaque-mode tokens have the same security
 * properties; the CLI is the source of truth since the salt never leaves it.
 */
function generateRandomSalt(): string {
  const bytes = crypto.randomBytes(32);
  return base32Encode(bytes);
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

interface AssignmentTotals {
  rubric_checks: number;
  autograder_tests: number;
  groups: number;
  submissions: number;
  scores: number;
  grader_tests: number;
  hints: number;
  error_pin_engagement: number;
}

interface GradebookTotals {
  gradebook_scores: number;
}

/**
 * Stream one assignment's per-assignment data into its own subdirectory.
 * Demuxes NDJSON record kinds into separate files (rubric.json, groups.json,
 * submissions.json, scores.json, tests.json, hints.json) so analysts can
 * load just the table they care about without parsing the whole stream.
 */
async function streamAssignmentToDir(
  args: ArgumentsCamelCase<ExportArgs>,
  salt: string | null,
  mode: IdentityMode,
  dumpId: string,
  assignmentId: number,
  slug: string,
  dir: string
): Promise<AssignmentTotals> {
  const params: Record<string, unknown> = {
    class: args.class,
    identity_mode: mode,
    dump_id: dumpId,
    assignment: assignmentId,
    with_test_output: args.withTestOutput === true,
    test_output_max_bytes: args.testOutputMaxBytes ?? 4096
  };
  if (salt !== null) params.salt = salt;
  if (mode === "raw") params.confirm_pii = true;

  // The whole stream is consumed under retry. Each attempt rebuilds buckets
  // from scratch — a "terminated" mid-stream means we've buffered partial
  // data and can't tell what we're missing, so we throw it away and re-fetch.
  // Tokens are derived from the same per-run salt, so a retried call yields
  // exactly the same data as the original.
  const { manifest, buckets, endRecord } = await withTransientRetry(
    async () => {
      const buckets: Record<string, Record<string, unknown>[]> = {
        rubric: [],
        rubric_part: [],
        rubric_criteria: [],
        rubric_check: [],
        autograder: [],
        autograder_test: [],
        autograder_raw_config: [],
        group: [],
        submission: [],
        score: [],
        grader_test: [],
        hint: [],
        error_pin_engagement: []
      };
      let manifest: Record<string, unknown> | null = null;
      let endRecord: Record<string, unknown> | null = null;

      for await (const record of streamApiCall({ command: "assessment.export.assignment", params })) {
        if (record.kind === "manifest") {
          manifest = record;
          continue;
        }
        if (record.kind === "end") {
          endRecord = record;
          continue;
        }
        const bucket = buckets[String(record.kind)];
        if (bucket) bucket.push(record);
      }

      if (manifest === null) throw new CLIError(`assignment ${slug}: missing manifest`);
      if (endRecord === null) throw new CLIError(`assignment ${slug}: stream ended without {end}`);
      return { manifest, buckets, endRecord };
    },
    {
      onRetry: (attempt, err, delayMs) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warning(
          `assignment ${slug}: transient error on attempt ${attempt} (${message}); retrying in ${delayMs}ms`
        );
      }
    }
  );

  // Verify counts against server-reported totals so a truncated per-assignment
  // stream doesn't silently produce a partial dump.
  assertExpectedCount(endRecord, "scores", buckets.score!.length);
  assertExpectedCount(endRecord, "submissions", buckets.submission!.length);
  assertExpectedCount(endRecord, "grader_tests", buckets.grader_test!.length);
  assertExpectedCount(endRecord, "hints", buckets.hint!.length);
  assertExpectedCount(endRecord, "error_pin_engagement", buckets.error_pin_engagement!.length);

  writeJson(path.join(dir, "manifest.json"), manifest);
  writeJson(path.join(dir, "rubric.json"), {
    rubric: buckets.rubric![0] ?? null,
    parts: buckets.rubric_part,
    criteria: buckets.rubric_criteria,
    checks: buckets.rubric_check
  });
  writeJson(path.join(dir, "autograder.json"), {
    autograder: buckets.autograder![0] ?? null,
    tests: buckets.autograder_test,
    raw_config: buckets.autograder_raw_config![0]?.config ?? null
  });
  if (buckets.group!.length > 0) writeJson(path.join(dir, "groups.json"), buckets.group);
  writeJson(path.join(dir, "submissions.json"), buckets.submission);
  writeJson(path.join(dir, "scores.json"), buckets.score);
  writeJson(path.join(dir, "tests.json"), buckets.grader_test);
  writeJson(path.join(dir, "hints.json"), buckets.hint);
  writeJson(path.join(dir, "error-pin-engagement.json"), buckets.error_pin_engagement);

  const counts = (endRecord.counts as Record<string, number>) ?? {};
  return {
    rubric_checks: counts.rubric_checks ?? buckets.rubric_check!.length,
    autograder_tests: counts.autograder_tests ?? buckets.autograder_test!.length,
    groups: counts.groups ?? buckets.group!.length,
    submissions: counts.submissions ?? buckets.submission!.length,
    scores: counts.scores ?? buckets.score!.length,
    grader_tests: counts.grader_tests ?? buckets.grader_test!.length,
    hints: counts.hints ?? buckets.hint!.length,
    error_pin_engagement: counts.error_pin_engagement ?? buckets.error_pin_engagement!.length
  };
}

async function streamGradebookToDir(
  args: ArgumentsCamelCase<ExportArgs>,
  salt: string | null,
  mode: IdentityMode,
  dumpId: string,
  outputDir: string
): Promise<GradebookTotals> {
  const params: Record<string, unknown> = {
    class: args.class,
    identity_mode: mode,
    dump_id: dumpId
  };
  if (salt !== null) params.salt = salt;
  if (mode === "raw") params.confirm_pii = true;
  if (args.gradebookColumn && args.gradebookColumn.length > 0) {
    params.gradebook_columns = args.gradebookColumn;
  }

  const { cells, warnings, endRecord } = await withTransientRetry(
    async () => {
      const cells: Record<string, unknown>[] = [];
      const warnings: Record<string, unknown>[] = [];
      let endRecord: Record<string, unknown> | null = null;

      for await (const record of streamApiCall({ command: "assessment.export.gradebook", params })) {
        if (record.kind === "gradebook_score") cells.push(record);
        else if (record.kind === "warning") warnings.push(record);
        else if (record.kind === "end") endRecord = record;
      }
      if (endRecord === null) throw new CLIError("gradebook stream ended without {end}");
      return { cells, warnings, endRecord };
    },
    {
      onRetry: (attempt, err, delayMs) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warning(`gradebook: transient error on attempt ${attempt} (${message}); retrying in ${delayMs}ms`);
      }
    }
  );

  for (const w of warnings) {
    logger.warning(`gradebook: ${String(w.message)} — ${JSON.stringify(w.selectors)}`);
  }

  assertExpectedCount(endRecord, "gradebook_scores", cells.length);

  const dir = path.join(outputDir, "gradebook");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(path.join(dir, "scores.json"), cells);

  return { gradebook_scores: cells.length };
}

/**
 * Run a list of async tasks with bounded parallelism. Promise.all + chunking
 * would force lockstep batches; this runs N workers each picking the next
 * task off the queue so a slow assignment doesn't stall the whole pool.
 */
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

function aggregateTotals(
  perAssignment: AssignmentTotals[],
  gradebook: GradebookTotals
): AssignmentTotals & GradebookTotals {
  const sum = (key: keyof AssignmentTotals) => perAssignment.reduce((acc, t) => acc + t[key], 0);
  return {
    rubric_checks: sum("rubric_checks"),
    autograder_tests: sum("autograder_tests"),
    groups: sum("groups"),
    submissions: sum("submissions"),
    scores: sum("scores"),
    grader_tests: sum("grader_tests"),
    hints: sum("hints"),
    error_pin_engagement: sum("error_pin_engagement"),
    gradebook_scores: gradebook.gradebook_scores
  };
}
