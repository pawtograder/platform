/**
 * Null-safe summary statistics for a set of scores.
 *
 * Used by the instructor assignment dashboard to show min / max / average
 * scores for an assignment (overall, or filtered by class/lab section).
 * Non-numeric, null, undefined, and non-finite values are ignored so callers
 * can pass raw view rows (e.g. `total_score`, `autograder_score`) directly
 * without pre-filtering ungraded submissions.
 */
export type ScoreStats = {
  /** How many finite numeric values contributed to the stats. */
  count: number;
  min: number | null;
  max: number | null;
  /** Arithmetic mean of the contributing values, or null when count === 0. */
  mean: number | null;
};

/** An empty result, returned when there are no numeric values. */
const EMPTY_STATS: ScoreStats = { count: 0, min: null, max: null, mean: null };

/**
 * Compute min/max/mean/count over a list of possibly-missing scores.
 * Ignores null, undefined, NaN, and Infinity.
 */
export function computeScoreStats(values: readonly (number | null | undefined)[]): ScoreStats {
  let count = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;

  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    count += 1;
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }

  if (count === 0) return { ...EMPTY_STATS };
  return { count, min, max, mean: sum / count };
}

/**
 * Convenience helper: pull a numeric field off each row and compute its stats.
 * Keeps the dashboard call sites terse, e.g. `statsForField(rows, "total_score")`.
 */
export function statsForField<T>(rows: readonly T[], field: keyof T): ScoreStats {
  return computeScoreStats(rows.map((row) => row[field] as number | null | undefined));
}

/** Format a stat value for display, showing a placeholder when missing. */
export function formatStat(value: number | null, fractionDigits = 1): string {
  if (value === null) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(fractionDigits);
}
