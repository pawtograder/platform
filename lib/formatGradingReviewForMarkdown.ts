/**
 * Markdown lines for instructor submission export: grading scores without a viewer profile.
 * Prefers per_student_grading_totals, then individual_scores, else total_score.
 */

export type GradingReviewForMarkdown = {
  total_score: number | null;
  per_student_grading_totals?: unknown;
  individual_scores?: unknown;
};

function isPlainObjectRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

/** Same numeric coercion as getDisplayedGradingTotalForStudent map values. */
function formatScoreCell(raw: unknown): string {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "string" && raw !== "") {
    const n = Number(raw);
    if (!Number.isNaN(n) && Number.isFinite(n)) return String(n);
    return raw;
  }
  if (raw == null) return "—";
  return String(raw);
}

/**
 * Lines to append immediately after "### Grading Review" and the blank line.
 */
export function formatGradingReviewScoreLines(review: GradingReviewForMarkdown): string[] {
  const lines: string[] = [];

  const pst = review.per_student_grading_totals;
  if (isPlainObjectRecord(pst)) {
    const keys = Object.keys(pst).filter((k) => Object.prototype.hasOwnProperty.call(pst, k));
    if (keys.length > 0) {
      lines.push("- **Hand grading total (per student):**");
      for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
        lines.push(`  - \`${key}\`: ${formatScoreCell(pst[key])}`);
      }
      if (keys.length > 1 && review.total_score != null && Number.isFinite(Number(review.total_score))) {
        lines.push(
          `- **Internal rollup (\`total_score\`):** ${review.total_score} *(aggregates the whole review; not any single member's gradebook line)*`
        );
      }
      return lines;
    }
  }

  const ind = review.individual_scores;
  if (isPlainObjectRecord(ind)) {
    const keys = Object.keys(ind).filter((k) => Object.prototype.hasOwnProperty.call(ind, k));
    if (keys.length > 0) {
      lines.push("- **Individual rubric slice (per student):**");
      for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
        lines.push(`  - \`${key}\`: ${formatScoreCell(ind[key])}`);
      }
      return lines;
    }
  }

  lines.push(`- **Total Score:** ${review.total_score ?? "Not graded"}`);
  return lines;
}
