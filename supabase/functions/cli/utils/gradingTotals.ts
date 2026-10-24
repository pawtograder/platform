/**
 * Which hand-grading total belongs to a given student.
 *
 * Mirrors `lib/getDisplayedGradingTotalForStudent.ts`, which the instructor
 * submissions table uses, and the gradebook's dependency order:
 * `per_student_grading_totals`, then the legacy `individual_scores`, then the
 * shared `total_score`.
 *
 * This matters for rubrics with `is_individual_grading` or
 * `is_assign_to_student` parts: there, `total_score` on the review is a shared
 * value, and reporting it for every group member overstates or understates
 * individual students. Duplicated rather than imported because `@/*` does not
 * resolve in Deno.
 */

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

export function gradingTotalForStudent(
  row: {
    total_score: number | null;
    per_student_grading_totals?: unknown;
    individual_scores?: unknown;
  },
  privateProfileId: string | null | undefined
): number | null {
  if (!privateProfileId) {
    return typeof row.total_score === "number" && Number.isFinite(row.total_score) ? row.total_score : null;
  }
  const fromTotals = numericFromMap(row.per_student_grading_totals, privateProfileId);
  if (fromTotals !== null) return fromTotals;
  const fromIndividual = numericFromMap(row.individual_scores, privateProfileId);
  if (fromIndividual !== null) return fromIndividual;
  return typeof row.total_score === "number" && Number.isFinite(row.total_score) ? row.total_score : null;
}
