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

/** Classify a Likert value as negative, neutral, or positive based on scale midpoint */
export function getLikertDirection(value: number, allValues: number[]): "negative" | "neutral" | "positive" {
  if (allValues.length === 0) return "neutral";
  const sorted = [...allValues].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const midpoint = (min + max) / 2;
  const tolerance = 0.3;
  if (Math.abs(value - midpoint) <= tolerance) return "neutral";
  return value < midpoint ? "negative" : "positive";
}

/** Get color for a Likert value */
export function getLikertColor(value: number, allValues: number[]): string {
  const dir = getLikertDirection(value, allValues);
  return LIKERT_COLORS[dir];
}

/** Partition values into left (negative), neutral, right (positive) for diverging chart */
export function partitionForDiverging(allValues: number[]): {
  left: number[];
  neutral: number[];
  right: number[];
} {
  const left: number[] = [];
  const neutral: number[] = [];
  const right: number[] = [];
  for (const v of allValues) {
    const dir = getLikertDirection(v, allValues);
    if (dir === "negative") left.push(v);
    else if (dir === "neutral") neutral.push(v);
    else right.push(v);
  }
  return { left, neutral, right };
}

/** Get diverging chart color (gradient within polarity) */
export function getDivergingColor(value: number, allValues: number[]): string {
  const { left, neutral, right } = partitionForDiverging(allValues);
  if (neutral.includes(value)) return DIVERGING_COLORS.neutral;
  if (left.includes(value)) {
    const idx = left.indexOf(value);
    const isExtreme = idx === 0;
    return isExtreme ? DIVERGING_COLORS.negativeStrong : DIVERGING_COLORS.negativeLight;
  }
  if (right.includes(value)) {
    const idx = right.indexOf(value);
    const isExtreme = idx === right.length - 1;
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
