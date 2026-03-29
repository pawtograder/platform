import type { QuestionStats } from "@/types/survey-analytics";

/** Shared color scale: red (negative) -> gray (neutral) -> green (positive) */
export const LIKERT_COLORS = {
  negative: "#DC2626",
  neutral: "#6B7280",
  positive: "#16A34A"
} as const;

/** Diverging chart colors matching reference: pink/red (disagree) -> gray (neutral) -> blue (agree) */
export const DIVERGING_COLORS = {
  negativeStrong: "#BE185D",
  negativeLight: "#F9A8D4",
  neutral: "#9CA3AF",
  positiveLight: "#93C5FD",
  positiveStrong: "#2563EB"
} as const;

/** Classify a Likert value as negative, neutral, or positive based on scale midpoint.
 * Uses fixed scale bounds (scaleMin/scaleMax) when provided so polarity is stable across filtered views.
 * Falls back to allValues min/max when scale bounds are not provided. */
export function getLikertDirection(
  value: number,
  allValues: number[],
  scaleMin?: number,
  scaleMax?: number
): "negative" | "neutral" | "positive" {
  const useFixedScale = scaleMin != null && scaleMax != null;
  if (!useFixedScale && allValues.length === 0) return "neutral";
  const midpoint = useFixedScale ? (scaleMin + scaleMax) / 2 : (Math.min(...allValues) + Math.max(...allValues)) / 2;
  const tolerance = 0.3;
  if (Math.abs(value - midpoint) <= tolerance) return "neutral";
  return value < midpoint ? "negative" : "positive";
}

/** Get color for a Likert value */
export function getLikertColor(value: number, allValues: number[], scaleMin?: number, scaleMax?: number): string {
  const dir = getLikertDirection(value, allValues, scaleMin, scaleMax);
  return LIKERT_COLORS[dir];
}

/** Partition values into left (negative), neutral, right (positive) for diverging chart */
export function partitionForDiverging(
  allValues: number[],
  scaleMin?: number,
  scaleMax?: number
): {
  left: number[];
  neutral: number[];
  right: number[];
} {
  const left: number[] = [];
  const neutral: number[] = [];
  const right: number[] = [];
  for (const v of allValues) {
    const dir = getLikertDirection(v, allValues, scaleMin, scaleMax);
    if (dir === "negative") left.push(v);
    else if (dir === "neutral") neutral.push(v);
    else right.push(v);
  }
  return { left, neutral, right };
}

/** Get diverging chart color (gradient within polarity) */
export function getDivergingColor(value: number, allValues: number[], scaleMin?: number, scaleMax?: number): string {
  const { left, neutral, right } = partitionForDiverging(allValues, scaleMin, scaleMax);
  if (neutral.includes(value)) return DIVERGING_COLORS.neutral;
  if (left.includes(value)) {
    const leftMin = Math.min(...left);
    const isExtreme = value === leftMin;
    return isExtreme ? DIVERGING_COLORS.negativeStrong : DIVERGING_COLORS.negativeLight;
  }
  if (right.includes(value)) {
    const rightMax = Math.max(...right);
    const isExtreme = value === rightMax;
    return isExtreme ? DIVERGING_COLORS.positiveStrong : DIVERGING_COLORS.positiveLight;
  }
  return DIVERGING_COLORS.neutral;
}

/** Build ordered value list from distribution */
export function getOrderedValues(distribution: Record<number, number>): number[] {
  return Object.keys(distribution)
    .map(Number)
    .sort((a, b) => a - b);
}

/** Compute max count across all questions for consistent axes */
export function getGlobalMaxCount(questionStats: Record<string, QuestionStats>): number {
  let max = 0;
  for (const stats of Object.values(questionStats)) {
    if (!stats?.distribution) continue;
    for (const count of Object.values(stats.distribution)) {
      max = Math.max(max, count);
    }
  }
  return max === 0 ? 10 : Math.ceil(max * 1.2);
}

/** Truncate long question titles for chart display */
export function truncateTitle(title: string, maxLen = 50): string {
  if (title.length <= maxLen) return title;
  return title.slice(0, maxLen - 3) + "...";
}

/** Comparison indicator: group vs course mean. Returns arrow type or null if within tolerance. */
export type ComparisonArrowType = "up" | "down" | "double-up" | "double-down";

export function getComparisonArrowType(
  groupMean: number,
  courseMean: number,
  tolerance = 0.15,
  doubleThreshold = 0.6
): ComparisonArrowType | null {
  const diff = groupMean - courseMean;
  if (Math.abs(diff) < tolerance) return null;
  if (diff > doubleThreshold) return "double-up";
  if (diff > tolerance) return "up";
  if (diff < -doubleThreshold) return "double-down";
  if (diff < -tolerance) return "down";
  return null;
}
