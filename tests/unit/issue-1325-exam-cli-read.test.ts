/**
 * @jest-environment node
 */

/**
 * #1325: `pawtograder exams questions` and `exams scans status`.
 *
 * `questions` is how an operator finds the rubric check id to give `submissions comments import`
 * for each exam question, so a wrong order, a check from the wrong rubric, or a dropped question
 * sends grades to the wrong place without any error. `status` has to say when an upload is short,
 * because enqueue_exam_process_batch refuses such a batch.
 */

import {
  questionCheckRows,
  summarizeBatch,
  type ExamQuestionRow,
  type ExamRubricCheckRow
} from "@/supabase/functions/cli/utils/examScans";

const GRADING = 10;
const SELF_REVIEW = 11;

function q(id: number, parent_id: number | null, ordinal: number, label: string, level = parent_id ? 2 : 1) {
  return { id, parent_id, level, ordinal, label, points: 1, answer_type: null } satisfies ExamQuestionRow;
}

function check(id: number, exam_question_id: number, rubric_id = GRADING): ExamRubricCheckRow {
  return { id, name: `check ${id}`, points: 1, rubric_id, exam_question_id };
}

describe("questionCheckRows", () => {
  it("lists questions in tree order by ordinal, not by id", () => {
    const questions = [q(5, null, 1, "Q2"), q(1, null, 0, "Q1"), q(7, 1, 1, "b"), q(3, 1, 0, "a"), q(9, 5, 0, "a")];
    expect(questionCheckRows(questions, [], GRADING).map((r) => r.path)).toEqual([
      "Q1",
      "Q1 > a",
      "Q1 > b",
      "Q2",
      "Q2 > a"
    ]);
  });

  it("takes checks from the grading rubric only", () => {
    const rows = questionCheckRows([q(1, null, 0, "Q1")], [check(100, 1, SELF_REVIEW), check(101, 1)], GRADING);
    expect(rows[0].rubric_checks.map((c) => c.id)).toEqual([101]);
  });

  it("keeps a question with no check, with an empty list", () => {
    const rows = questionCheckRows([q(1, null, 0, "Q1"), q(2, 1, 0, "a")], [check(200, 2)], GRADING);
    expect(rows.map((r) => [r.path, r.rubric_checks.map((c) => c.id)])).toEqual([
      ["Q1", []],
      ["Q1 > a", [200]]
    ]);
  });
});

describe("summarizeBatch", () => {
  const batch = { status: "uploaded", error: null, total_pages: 4, pages_per_exam: 2 };

  it.each([
    [4, true],
    [3, false],
    [0, false]
  ])("with %i of 4 pages stored, upload_complete is %s", (stored, complete) => {
    expect(summarizeBatch(batch, stored, []).upload_complete).toBe(complete);
  });
});
