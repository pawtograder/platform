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

/**
 * Formats an ISO timestamp as a date, or `-` when unset.
 *
 * Pass the class time zone (every command echoes it back on `data.class.time_zone`).
 * Without it these render in the operator's local zone, which moves a deadline onto the
 * wrong day for anyone working away from campus — an 11pm Boston due date reads as the
 * next morning from Europe. `formatZoneLabel` names the zone in the surrounding output
 * so the dates are not merely correct but legible as such.
 */
/**
 * One `Intl.DateTimeFormat` per (kind, zone) instead of one per cell.
 *
 * V8 only serves its internal Intl cache for the no-options form, so passing an options
 * bag builds a fresh ICU formatter on every call — around 10,000 of them for a
 * `reviews list --limit 5000` with two date columns.
 *
 * `classes.time_zone` is free text (NOT NULL, DEFAULT 'America/New_York', no CHECK
 * constraint), and `Intl` throws `RangeError: Invalid time zone specified` on a value
 * like `Eastern`. Unguarded, that killed every list command that renders a date and
 * printed no rows at all, for a reason unrelated to what was asked. The write path
 * already rejects an unknown zone explicitly (`zonedDate.ts`); here we fall back to the
 * operator's local zone so the rows still render, and `formatZoneLabel` stops claiming a
 * zone we could not honor.
 */
const dateFormatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(kind: "date" | "datetime", timeZone?: string | null): Intl.DateTimeFormat | null {
  const key = `${kind}|${timeZone ?? ""}`;
  const cached = dateFormatters.get(key);
  if (cached !== undefined) return cached;

  // Spelled out to match what `toLocaleDateString()`/`toLocaleString()` produce with no
  // options, so memoizing does not quietly change the rendered format (`dateStyle:
  // "short"` would, to a two-digit year).
  const options: Intl.DateTimeFormatOptions =
    kind === "date"
      ? { year: "numeric", month: "numeric", day: "numeric" }
      : {
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "numeric",
          second: "numeric"
        };
  let formatter: Intl.DateTimeFormat | null;
  try {
    formatter = new Intl.DateTimeFormat(undefined, timeZone ? { ...options, timeZone } : options);
  } catch {
    formatter = timeZone ? new Intl.DateTimeFormat(undefined, options) : null;
  }
  dateFormatters.set(key, formatter);
  return formatter;
}

/** Whether `timeZone` is one `Intl` will accept, so callers do not label a zone we ignored. */
export function isUsableTimeZone(timeZone?: string | null): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function formatDate(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const formatter = formatterFor("date", timeZone);
  return formatter ? formatter.format(d) : d.toLocaleDateString();
}

/** Formats an ISO timestamp as a date and time, or `-` when unset. See {@link formatDate}. */
export function formatDateTime(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const formatter = formatterFor("datetime", timeZone);
  return formatter ? formatter.format(d) : d.toLocaleString();
}

/**
 * A parenthesised note naming the zone dates are shown in, or empty when unknown.
 * Empty rather than guessing: claiming a zone we were not told — or one `Intl` rejected,
 * and so did not actually apply — is worse than silence.
 */
export function formatZoneLabel(timeZone?: string | null): string {
  return isUsableTimeZone(timeZone) ? ` (times in ${timeZone})` : "";
}
