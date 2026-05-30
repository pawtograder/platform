/**
 * `pawtograder assessment deanonymize` — export a CSV that maps each subject
 * token from a prior `assessment export --identity hash` run back to the
 * student's real identifiers.
 *
 * The --salt value must be identical to the one used in the original export
 * run so that the server can reproduce the same tokens (using the deployment
 * vault pepper). Because the mapping contains PII (name, email, SIS id) the
 * --i-understand-pii flag is required.
 *
 * Output CSV columns:
 *   subject_token, name, email, sis_user_id, class_section, lab_section
 */

import * as fs from "fs";
import * as path from "path";
import type { Argv, ArgumentsCamelCase } from "yargs";
import { streamApiCall } from "@/cli/utils/streamApi";
import { logger, handleError, CLIError } from "@/cli/utils/logger";

interface DeanonymizeArgs {
  class: string;
  salt: string;
  "i-understand-pii": boolean;
  iUnderstandPii?: boolean;
  output?: string;
}

export const deanonymizeBuilder = (yargs: Argv) => {
  return yargs
    .option("class", {
      alias: "c",
      describe: "Class ID, slug, or name",
      type: "string",
      demandOption: true
    })
    .option("salt", {
      describe:
        "Salt used in the original assessment export --identity hash run (must be identical to reproduce the same tokens)",
      type: "string",
      demandOption: true
    })
    .option("i-understand-pii", {
      describe: "Required — acknowledges that real student names, emails, and SIS ids will be written to disk",
      type: "boolean",
      default: false
    })
    .option("output", {
      alias: "o",
      describe: "Output CSV file path (default: ./<class>-roster-<timestamp>.csv)",
      type: "string"
    })
    .check((argv) => {
      if (!argv["i-understand-pii"]) {
        throw new Error(
          "--i-understand-pii is required — this command writes real student names, emails, and SIS ids to disk"
        );
      }
      if (argv.salt.length < 16) {
        throw new Error("--salt must be at least 16 characters (must match the salt from the original export run)");
      }
      return true;
    });
};

export async function deanonymizeHandler(args: ArgumentsCamelCase<DeanonymizeArgs>): Promise<void> {
  try {
    const outputPath =
      args.output ?? path.join(process.cwd(), `${sanitizeForFilename(args.class)}-roster-${timestamp()}.csv`);

    logger.step(`Exporting deanonymization roster for class: ${args.class}`);
    logger.info(`Output: ${outputPath}`);
    logger.warning(
      "Real student names, emails, and SIS ids will be written to disk. Handle the output file accordingly."
    );

    const params: Record<string, unknown> = {
      class: args.class,
      identity_mode: "hash",
      salt: args.salt,
      confirm_pii: true
    };

    const rows: Record<string, unknown>[] = [];
    let endRecord: Record<string, unknown> | null = null;

    for await (const record of streamApiCall({ command: "assessment.export.roster", params })) {
      switch (record.kind) {
        case "roster_row":
          rows.push(record);
          break;
        case "end":
          endRecord = record;
          break;
        default:
          break;
      }
    }

    if (endRecord === null) {
      throw new CLIError("Server stream ended without an {end} marker — the roster may be incomplete");
    }

    const counts = endRecord.counts as Record<string, unknown> | undefined;
    const expectedRows = counts?.rows;
    if (typeof expectedRows === "number" && expectedRows !== rows.length) {
      throw new CLIError(
        `Stream count mismatch: server reported ${expectedRows} rows but received ${rows.length}. ` +
          "The roster is incomplete; do not use it."
      );
    }

    const csv = buildCsv(rows);
    writeCsv(outputPath, csv);

    logger.success(`Done. ${rows.length} student(s) written to ${outputPath}`);
  } catch (error) {
    handleError(error);
  }
}

const CSV_HEADER = "subject_token,name,email,sis_user_id,class_section,lab_section";

function buildCsv(rows: Record<string, unknown>[]): string {
  const lines = [CSV_HEADER];
  for (const row of rows) {
    lines.push(
      [
        csvField(row.token),
        csvField(row.name),
        csvField(row.email),
        csvField(row.sis_user_id),
        csvField(row.class_section),
        csvField(row.lab_section)
      ].join(",")
    );
  }
  return lines.join("\n") + "\n";
}

/** Escape a value for CSV: wrap in double-quotes if it contains a comma,
 *  double-quote, or newline; escape inner double-quotes by doubling them.
 *  Null / undefined become empty strings. */
function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function writeCsv(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on platforms where chmod is a no-op (e.g. Windows).
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
