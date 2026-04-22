/**
 * Hand-grading total to show a student for a submission review.
 * Matches gradebook dependency resolution: per_student_grading_totals, then individual_scores, then total_score.
 */
export type SubmissionReviewGradingDisplayFields = {
  total_score: number | null;
  per_student_grading_totals?: unknown;
  individual_scores?: unknown;
};

function numericFromMap(map: unknown, profileId: string): number | null {
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const raw = (map as Record<string, unknown>)[profileId];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw !== "") {
    const n = Number(raw);
    if (!Number.isNaN(n) && Number.isFinite(n)) return n;
  }
  return null;
}

export function getDisplayedGradingTotalForStudent(
  review: SubmissionReviewGradingDisplayFields | null | undefined,
  privateProfileId: string | null | undefined
): number | null {
  if (!review || !privateProfileId) return null;
  const fromTotals = numericFromMap(review.per_student_grading_totals, privateProfileId);
  if (fromTotals !== null) return fromTotals;
  const fromIndividual = numericFromMap(review.individual_scores, privateProfileId);
  if (fromIndividual !== null) return fromIndividual;
  const ts = review.total_score;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  return null;
}
