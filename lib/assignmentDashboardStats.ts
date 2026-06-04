/**
 * Pure helpers powering the instructor assignment dashboard: grading-progress
 * counts, score histograms, and section/lab filtering. Kept free of React so
 * they can be unit-tested directly.
 */

/** The filter value meaning "no section/lab filter". */
export const ALL_SECTIONS_FILTER = "all";

export type GradingStatusRow = {
  completed_at?: string | null;
  released?: boolean | null;
};

export type GradingCounts = {
  total: number;
  graded: number;
  released: number;
  notReleased: number;
};

/** Count total / graded (completed) / released / not-released submissions. */
export function computeGradingCounts(rows: readonly GradingStatusRow[]): GradingCounts {
  const total = rows.length;
  const graded = rows.filter((r) => r.completed_at != null).length;
  const released = rows.filter((r) => r.released === true).length;
  return { total, graded, released, notReleased: total - released };
}

export type HistogramBin = { name: string; value: number };

/** Bucket scores into rounded-integer bins, sorted ascending. Ignores missing values. */
export function buildScoreHistogram(values: readonly (number | null | undefined)[]): HistogramBin[] {
  const buckets = new Map<number, number>();
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    const rounded = Math.round(value);
    buckets.set(rounded, (buckets.get(rounded) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([score, count]) => ({ name: String(score), value: count }));
}

export type SectionRow = {
  class_section_name?: string | null;
  lab_section_name?: string | null;
};

export type SectionOptions = {
  classSections: string[];
  labSections: string[];
};

/** Distinct, sorted class-section and lab-section names present in the rows. */
export function collectSectionOptions(rows: readonly SectionRow[]): SectionOptions {
  const classSet = new Set<string>();
  const labSet = new Set<string>();
  for (const row of rows) {
    if (row.class_section_name) classSet.add(row.class_section_name);
    if (row.lab_section_name) labSet.add(row.lab_section_name);
  }
  return {
    classSections: Array.from(classSet).sort(),
    labSections: Array.from(labSet).sort()
  };
}

/**
 * Filter rows by a section selector. The selector is either `ALL_SECTIONS_FILTER`
 * or a `"class:<name>"` / `"lab:<name>"` string. Section names may themselves
 * contain ":" so only the first colon is treated as the delimiter.
 */
export function filterRowsBySection<T extends SectionRow>(rows: readonly T[], filter: string): readonly T[] {
  if (filter === ALL_SECTIONS_FILTER) return rows;
  const delimiterIndex = filter.indexOf(":");
  if (delimiterIndex === -1) return rows;
  const kind = filter.slice(0, delimiterIndex);
  const name = filter.slice(delimiterIndex + 1);
  if (kind === "class") return rows.filter((r) => r.class_section_name === name);
  if (kind === "lab") return rows.filter((r) => r.lab_section_name === name);
  return rows;
}
