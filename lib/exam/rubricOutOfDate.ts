export type ExamQuestionPoints = { id: number; parent_id: number | null; points: number | null };
export type GeneratedCheckPoints = { exam_question_id: number; points: number };

/**
 * Whether "Build rubric from exam" would change the rubric's checks (#1190). exam_sync_rubric_from_questions
 * gives every leaf question (one with no children) a check worth coalesce(points, 0), so the rubric is out of
 * date when a leaf has no check yet or its check is worth something else. A question that gained children
 * shows up through its new children, which have no checks yet. A rubric with no generated checks was never
 * built from the exam, so it isn't "out of date".
 *
 * Only meaningful before there are submissions: after that the sync stops refreshing points, and a
 * different value can be a grader's deliberate edit.
 */
export function examRubricOutOfDate(questions: ExamQuestionPoints[], checks: GeneratedCheckPoints[]): boolean {
  if (checks.length === 0) return false;
  const parentIds = new Set(questions.map((q) => q.parent_id).filter((id) => id !== null));
  const checkPoints = new Map(checks.map((c) => [c.exam_question_id, Number(c.points)]));
  // A leaf with no check yet reads as undefined, which never equals its points.
  return questions.some((q) => !parentIds.has(q.id) && checkPoints.get(q.id) !== Number(q.points ?? 0));
}
