/**
 * Schedule CSV parsing for assignment copy operations
 */

import { parse } from "csv-parse/sync";
import { readFileSync } from "fs";
import { AssignmentScheduleRow } from "../types";
import { CLIError } from "./logger";

/**
 * Parse a schedule CSV file for assignment copy operations
 *
 * CSV Format:
 *   assignment_slug OR assignment_title (at least one required) - identifies the assignment
 *   release_date (optional) - override release date
 *   due_date (optional) - override due date
 *   latest_due_date (optional) - override latest due date
 *
 * Supported date formats:
 *   - ISO: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
 *   - US: MM/DD/YY, M/D/YY, MM/DD/YYYY, or M/D/YYYY
 *
 * Example with slugs:
 *   assignment_slug,release_date,due_date
 *   hw-1,2026-01-15,2026-01-22
 *   lab-1,1/20/26,1/24/26
 *
 * Example with titles:
 *   assignment_title,release_date,due_date
 *   Assignment 1: Recipe Domain Model,2026-01-15,2026-01-22
 *   Lab 1: Java Tooling and Setup,01/20/26,01/24/26
 *
 * Empty date fields use the source assignment's values.
 */
export function parseAssignmentScheduleCsv(filePath: string): AssignmentScheduleRow[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new CLIError(`Failed to read CSV file: ${filePath}`);
  }

  let records: Record<string, string>[];
  try {
    records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });
  } catch (err) {
    throw new CLIError(`Failed to parse CSV file: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (records.length === 0) {
    throw new CLIError("CSV file is empty");
  }

  // Validate at least one identifier column exists
  const firstRecord = records[0];
  const hasSlug = "assignment_slug" in firstRecord;
  const hasTitle = "assignment_title" in firstRecord;

  if (!hasSlug && !hasTitle) {
    throw new CLIError('CSV must have either an "assignment_slug" or "assignment_title" column');
  }

  // Map and validate records
  const rows: AssignmentScheduleRow[] = records.map((record, index) => {
    const slug = record.assignment_slug?.trim() || undefined;
    const title = record.assignment_title?.trim() || undefined;

    if (!slug && !title) {
      throw new CLIError(`Row ${index + 2}: assignment_slug or assignment_title is required`);
    }

    return {
      assignment_slug: slug,
      assignment_title: title,
      release_date: record.release_date?.trim() || undefined,
      due_date: record.due_date?.trim() || undefined,
      latest_due_date: record.latest_due_date?.trim() || undefined
    };
  });

  return rows;
}

/**
 * Normalize a date string to ISO format (YYYY-MM-DD)
 * Accepts:
 *   - ISO: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
 *   - US short: MM/DD/YY or M/D/YY (2-digit year)
 *   - US long: MM/DD/YYYY or M/D/YYYY (4-digit year)
 *
 * Returns the normalized ISO date string, or undefined if input is empty
 */
export function normalizeDate(dateStr: string | undefined, fieldName: string): string | undefined {
  if (!dateStr) return undefined;

  // ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS
  const isoPattern = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;
  if (isoPattern.test(dateStr)) {
    const parsed = new Date(dateStr);
    if (isNaN(parsed.getTime())) {
      throw new CLIError(`Invalid date for ${fieldName}: ${dateStr}`);
    }
    return dateStr;
  }

  // US format: MM/DD/YY or MM/DD/YYYY (with optional single-digit month/day)
  const usPattern = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;
  const usMatch = dateStr.match(usPattern);
  if (usMatch) {
    const month = parseInt(usMatch[1], 10);
    const day = parseInt(usMatch[2], 10);
    let year = parseInt(usMatch[3], 10);

    // Convert 2-digit year: 00-49 -> 2000-2049, 50-99 -> 1950-1999
    if (year < 100) {
      year = year < 50 ? 2000 + year : 1900 + year;
    }

    // Validate month and day ranges
    if (month < 1 || month > 12) {
      throw new CLIError(`Invalid month in ${fieldName}: ${dateStr}`);
    }
    if (day < 1 || day > 31) {
      throw new CLIError(`Invalid day in ${fieldName}: ${dateStr}`);
    }

    // Format as ISO
    const isoDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    // Validate the resulting date
    const parsed = new Date(isoDate);
    if (isNaN(parsed.getTime())) {
      throw new CLIError(`Invalid date for ${fieldName}: ${dateStr}`);
    }

    return isoDate;
  }

  throw new CLIError(
    `Invalid date format for ${fieldName}: ${dateStr}. Expected ISO (YYYY-MM-DD) or US (MM/DD/YY or MM/DD/YYYY)`
  );
}

/**
 * Validate a date string (for backward compatibility)
 * @deprecated Use normalizeDate instead
 */
export function validateIsoDate(dateStr: string | undefined, fieldName: string): void {
  normalizeDate(dateStr, fieldName);
}
