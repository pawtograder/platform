// The answer types exam_questions_answer_type_check accepts. Template extraction asks Gemini for an
// answer_type and can get back anything (it returned "composite" for a section with sub-questions),
// so every value headed for the database goes through normalizeAnswerType first.

export const EXAM_ANSWER_TYPES = ["free_text", "multiple_choice", "numeric", "true_false", "short_answer"] as const;

export type ExamAnswerType = (typeof EXAM_ANSWER_TYPES)[number];

/** An unknown or missing answer type becomes "free_text", the default for a question added by hand. */
export function normalizeAnswerType(value: unknown): ExamAnswerType {
  return typeof value === "string" && (EXAM_ANSWER_TYPES as readonly string[]).includes(value)
    ? (value as ExamAnswerType)
    : "free_text";
}
