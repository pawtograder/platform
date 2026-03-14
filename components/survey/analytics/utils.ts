import { Model } from "survey-core";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import type { QuestionStats, SurveyAnalyticsConfig } from "@/types/survey-analytics";

export type SurveyQuestionInfo = { name: string; title: string; type: string };

/** Get all questions from survey JSON in page order */
export function getAllQuestionsFromSurveyJson(surveyJson: Json): SurveyQuestionInfo[] {
  const questions: SurveyQuestionInfo[] = [];
  try {
    const survey = new Model(surveyJson);
    survey.getAllQuestions().forEach((q) => {
      if (q.name) {
        questions.push({ name: q.name, title: q.title || q.name, type: q.getType() });
      }
    });
  } catch {
    /* ignore */
  }
  return questions;
}

/** Format a response value for display, optionally with value labels for radiogroup/checkbox */
export function formatResponseValue(value: unknown, valueLabels?: Record<number, string>): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return valueLabels?.[Number(value)] ?? String(value);
  }
  if (Array.isArray(value)) {
    const labels = valueLabels ? value.map((v) => valueLabels[Number(v)] ?? String(v)).join(", ") : value.join(", ");
    return labels;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj.text && typeof obj.text === "string") return obj.text;
    if (obj.value) return String(obj.value);
    const stringValues = Object.values(obj).filter((v) => typeof v === "string");
    if (stringValues.length > 0) return stringValues.join(", ");
    const jsonStr = JSON.stringify(value);
    return jsonStr.length > 50 ? jsonStr.substring(0, 50) + "..." : jsonStr;
  }
  return String(value);
}

/** Extract value-to-label mapping from survey JSON for radiogroup/rating elements (Likert scale) */
export function getValueLabelsFromSurveyJson(surveyJson: Json, questionName: string): Record<number, string> {
  const labels: Record<number, string> = {};
  try {
    const pages = (
      surveyJson as {
        pages?: Array<{
          elements?: Array<{
            name?: string;
            type?: string;
            choices?: Array<{ value: number | string; text: string }>;
          }>;
        }>;
      }
    )?.pages;
    if (!pages) return labels;
    for (const page of pages) {
      for (const el of page.elements || []) {
        if (
          el.name === questionName &&
          (el.type === "radiogroup" || el.type === "rating" || el.type === "dropdown" || el.type === "checkbox")
        ) {
          for (const c of el.choices || []) {
            const v = typeof c.value === "number" ? c.value : Number(c.value);
            if (!isNaN(v) && c.text) labels[v] = c.text;
          }
          return labels;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return labels;
}

/** Create a stable key for grouping questions by their Likert scale (same labels = same group) */
export function getScaleGroupKey(labels: Record<number, string>): string {
  const entries = Object.entries(labels)
    .filter(([k]) => !isNaN(Number(k)))
    .sort(([a], [b]) => Number(a) - Number(b));
  return entries.map(([, v]) => v).join("|");
}

/** Human-readable label for a scale group (e.g. "Agree / Disagree" or "Much more... Much less") */
export function getScaleGroupLabel(labels: Record<number, string>): string {
  const entries = Object.entries(labels)
    .filter(([k]) => !isNaN(Number(k)))
    .sort(([a], [b]) => Number(a) - Number(b));
  const texts = entries.map(([, v]) => v);
  if (texts.length === 0) return "Other";
  if (texts.length <= 2) return texts.join(" / ");
  return `${texts[0]} … ${texts[texts.length - 1]}`;
}

export function computeStats(
  values: number[]
): Omit<QuestionStats, "deltaFromBaseline" | "distribution"> & { distribution: Record<number, number> } {
  if (values.length === 0) {
    return { mean: 0, median: 0, min: 0, max: 0, stdDev: 0, count: 0, distribution: {} };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  const mean = sum / values.length;
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
  const variance = values.length > 1 ? values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1) : 0;
  const stdDev = Math.sqrt(variance);

  const distribution: Record<number, number> = {};
  values.forEach((v) => {
    distribution[v] = (distribution[v] ?? 0) + 1;
  });

  return {
    mean,
    median,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdDev,
    count: values.length,
    distribution
  };
}

export function getDistributionWithDelta(stats: ReturnType<typeof computeStats>, baselineMean: number): QuestionStats {
  return {
    ...stats,
    deltaFromBaseline: baselineMean > 0 ? stats.mean - baselineMean : 0
  };
}

export const SCORE_HEALTH_COLORS = {
  healthy: { bg: "green.50", border: "green.500", _dark: { bg: "green.900" } },
  warning: { bg: "yellow.50", border: "yellow.500", _dark: { bg: "yellow.900" } },
  critical: { bg: "red.50", border: "red.500", _dark: { bg: "red.900" } }
} as const;

export function getHealthColor(
  deltaFromBaseline: number,
  stdDev: number,
  config?: SurveyAnalyticsConfig
): keyof typeof SCORE_HEALTH_COLORS {
  const varianceThreshold = config?.globalSettings?.varianceThreshold ?? 1.5;
  if (deltaFromBaseline < -1 || stdDev > 2) return "critical";
  if (deltaFromBaseline < -0.5 || stdDev > varianceThreshold) return "warning";
  return "healthy";
}

export function extractNumericValue(response: Record<string, unknown>, questionName: string): number | null {
  const val = response[questionName];
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
}

/** Wrap long labels at word boundaries for chart display (max ~42 chars per line) */
export function wrapLabel(text: string, maxCharsPerLine = 42): string[] {
  if (!text || text.length <= maxCharsPerLine) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxCharsPerLine) {
      lines.push(remaining.trim());
      break;
    }
    const chunk = remaining.slice(0, maxCharsPerLine);
    const lastSpace = chunk.lastIndexOf(" ");
    const breakAt = lastSpace > maxCharsPerLine * 0.5 ? lastSpace : maxCharsPerLine;
    lines.push(remaining.slice(0, breakAt).trim());
    remaining = remaining.slice(breakAt).trim();
  }
  return lines;
}

export function extractCheckboxFlagValues(response: Record<string, unknown>, questionName: string): number[] {
  const val = response[questionName];
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) {
    return val.map((v) => Number(v)).filter((n) => !isNaN(n));
  }
  const num = Number(val);
  return isNaN(num) ? [] : [num];
}
