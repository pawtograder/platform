export type ExamQuestionPoints = {
  id: number;
  parent_id: number | null;
  points: number | null;
  answer_type: string | null;
  correct_answer: unknown;
};
export type GeneratedCheckPoints = { exam_question_id: number; points: number };

// The answer types quiz_autograde scores. Must match the list in exam_sync_rubric_from_questions.
const AUTO_SCORED_TYPES = new Set(["multiple_choice", "true_false", "numeric"]);

/**
 * Whether "Build rubric from exam" would change the rubric's checks (#1190). exam_sync_rubric_from_questions
 * gives every leaf question (one with no children) a check worth coalesce(points, 0), so the rubric is out of
 * date when a leaf has no check yet or its check is worth something else. A question that gained children
 * shows up through its new children, which have no checks yet. A rubric with no generated checks was never
 * built from the exam, so it isn't "out of date".
 *
 * The sync skips leaves the autograder scores: on an in-app exam, an objective question with an answer key.
 * Those never get a check, so they are skipped here too.
 *
 * Only meaningful before there are submissions: after that the sync stops refreshing points, and a
 * different value can be a grader's deliberate edit.
 */
export function examRubricOutOfDate(
  questions: ExamQuestionPoints[],
  checks: GeneratedCheckPoints[],
  inApp: boolean
): boolean {
  if (checks.length === 0) return false;
  const parentIds = new Set(questions.map((q) => q.parent_id).filter((id) => id !== null));
  const checkPoints = new Map(checks.map((c) => [c.exam_question_id, Number(c.points)]));
  const autoScored = (q: ExamQuestionPoints) =>
    inApp && q.answer_type !== null && AUTO_SCORED_TYPES.has(q.answer_type) && q.correct_answer != null;
  // A leaf with no check yet reads as undefined, which never equals its points.
  return questions.some(
    (q) => !parentIds.has(q.id) && !autoScored(q) && checkPoints.get(q.id) !== Number(q.points ?? 0)
  );
}
