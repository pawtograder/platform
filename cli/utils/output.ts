/* eslint-disable no-console */
/**
 * Output helpers shared by the CLI's list commands.
 *
 * Two concerns live here:
 *   - `--json`, so list output can be piped into jq instead of parsed out of a
 *     table. Handlers call `emitJson` right after `apiCall` and return early.
 *   - Column-aligned tables. `logger.tableRow` joins with tabs, which lines up
 *     only when every cell happens to be shorter than a tab stop; real rosters
 *     and repository URLs make a mess of it.
 */

import type { Argv } from "yargs";

/** Registers `--json` on a subcommand builder. */
export function addJsonOption<T>(yargs: Argv<T>) {
  return yargs.option("json", {
    describe: "Emit the raw JSON response instead of a formatted table",
    type: "boolean",
    default: false
  });
}

/**
 * Prints `payload` as JSON when `--json` was passed, and reports whether it
 * did. Handlers use the return value to skip their human-readable rendering:
 *
 *   if (emitJson(args, data)) return;
 *
 * Nothing else may be written to stdout in that case, or the output stops
 * being parseable.
 */
export function emitJson(args: { json?: boolean }, payload: unknown): boolean {
  if (!args.json) return false;
  console.log(JSON.stringify(payload, null, 2));
  return true;
}

export type TableCell = string | number | boolean | null | undefined;

function renderCell(value: TableCell): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

/**
 * Prints a table with each column padded to its widest cell. The trailing
 * column is not padded, so rows do not end in a run of spaces.
 *
 * Width is measured in UTF-16 code units, which is what `String#length`
 * gives. Wide glyphs (CJK, emoji) therefore under-measure and can still skew a
 * column; fixing that needs a grapheme/east-asian-width table, which is not
 * worth pulling in for operator output.
 */
export function printTable(columns: string[], rows: TableCell[][]): void {
  const rendered = rows.map((row) => row.map(renderCell));

  const widths = columns.map((heading, i) =>
    Math.max(heading.length, ...rendered.map((row) => (row[i] ?? "").length), 0)
  );

  const line = (cells: string[]) =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i])))
      .join("  ")
      .trimEnd();

  console.log();
  console.log(`   ${line(columns)}`);
  console.log(`   ${line(widths.map((w) => "-".repeat(w)))}`);
  for (const row of rendered) {
    console.log(`   ${line(columns.map((_, i) => row[i] ?? ""))}`);
  }
}

/** Shortens `value` for a table cell, marking truncation with an ellipsis. */
export function truncate(value: string | null | undefined, max: number): string {
  if (!value) return "-";
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1))}…`;
}

/** Formats an ISO timestamp as a locale date, or `-` when unset. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleDateString();
}

/** Formats an ISO timestamp as a locale date and time, or `-` when unset. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "-" : d.toLocaleString();
}
