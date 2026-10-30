import { ExamRubricCheckDataType, RubricChecksDataType, YmlRubricChecksType } from "@/utils/supabase/DatabaseTypes";
import type { Json } from "@/utils/supabase/SupabaseTypes";

function throwIfNotWholeNumber(examQuestionId: unknown) {
  if (examQuestionId !== undefined && !Number.isInteger(examQuestionId)) {
    throw new Error("exam_question_id must be a whole number");
  }
}

export function rubricCheckDataOrThrow(
  check: YmlRubricChecksType
): RubricChecksDataType | ExamRubricCheckDataType | undefined {
  if (!check.data) {
    return undefined;
  }

  if (
    typeof check.data === "object" &&
    check.data !== null &&
    "options" in check.data &&
    Array.isArray((check.data as { options?: unknown }).options)
  ) {
    const specificData = check.data as RubricChecksDataType;
    throwIfNotWholeNumber(specificData.exam_question_id);

    if (specificData.options?.length === 1) {
      throw new Error("Checks may not have only one option - they must have at least two options, or can have none");
    }
    for (const option of specificData.options) {
      if (option.points === undefined || option.points === null) {
        throw new Error("Option points are required");
      }
      if (!option.label) {
        throw new Error("Option label is required");
      }
    }
    return specificData;
  } else if (typeof check.data === "object" && check.data !== null && !("options" in check.data)) {
    const { exam_question_id } = check.data as ExamRubricCheckDataType;
    throwIfNotWholeNumber(exam_question_id);
    return exam_question_id === undefined ? undefined : { exam_question_id };
  }

  return undefined;
}

/**
 * New data for a check edited in the GUI, keeping exam_question_id if the check had one. Without
 * it, editing a generated exam check's options would cut it off from its question.
 */
export function keepExamQuestionId(prev: Json | null | undefined, next: RubricChecksDataType | null): Json | null {
  const examQuestionId = prev && typeof prev === "object" && !Array.isArray(prev) ? prev.exam_question_id : undefined;
  if (typeof examQuestionId !== "number") return next;
  return next ? { ...next, exam_question_id: examQuestionId } : { exam_question_id: examQuestionId };
}
