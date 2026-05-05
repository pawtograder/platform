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
import { streamApiCall } from "../../utils/streamApi";
import { logger, handleError, CLIError } from "../../utils/logger";

type IdentityMode = "raw" | "hash" | "opaque";

interface ExportArgs {
  class: string;
  identity: IdentityMode;
  salt?: string;
  "i-understand-pii"?: boolean;
  iUnderstandPii?: boolean;
  output?: string;
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
    .check((argv) => {
      if (argv.identity === "raw" && !argv["i-understand-pii"]) {
        throw new Error("--identity raw requires --i-understand-pii to acknowledge that real student data will be written to disk");
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
      args.output ??
      path.join(process.cwd(), `assessment-export-${sanitizeForFilename(args.class)}-${timestamp()}`);

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
      logger.warning("Real student ids, emails, and names will be written to disk. Handle the output directory accordingly.");
    }

    const params: Record<string, unknown> = {
      class: args.class,
      identity_mode: mode,
      dump_id: dumpId
    };
    if (salt !== null) params.salt = salt;
    if (mode === "raw") params.confirm_pii = true;

    let manifest: Record<string, unknown> | null = null;
    const subjects: Record<string, unknown>[] = [];
    const sections: Record<string, unknown>[] = [];
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
        case "end":
          endRecord = record;
          break;
        default:
          // Forward-compat: unknown kinds are ignored so future server-side
          // additions don't break older CLIs.
          break;
      }
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

    writeJson(path.join(outputDir, "manifest.json"), manifest);
    writeJson(path.join(outputDir, "subjects.json"), subjects);
    writeJson(path.join(outputDir, "sections.json"), sections);

    logger.success(`Wrote ${subjects.length} subjects and ${sections.length} sections to ${outputDir}`);
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
function assertExpectedCount(
  endRecord: Record<string, unknown>,
  field: "subjects" | "sections",
  actual: number
): void {
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
