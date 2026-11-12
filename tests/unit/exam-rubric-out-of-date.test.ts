/**
 * @jest-environment node
 */

import { examRubricOutOfDate, type ExamQuestionPoints, type GeneratedCheckPoints } from "@/lib/exam/rubricOutOfDate";

/** A free-text question unless `extra` says otherwise. */
const q = (
  id: number,
  parent_id: number | null,
  points: number | null,
  extra: Partial<ExamQuestionPoints> = {}
): ExamQuestionPoints => ({ id, parent_id, points, answer_type: "free_text", correct_answer: null, ...extra });

// Part 1 has two leaf items worth 5 and 3, the shape "Build rubric from exam" generates a check for each of.
const part = q(1, null, 0);
const item1 = q(2, 1, 5);
const item2 = q(3, 1, 3);
const builtChecks: GeneratedCheckPoints[] = [
  { exam_question_id: 2, points: 5 },
  { exam_question_id: 3, points: 3 }
];
// An objective leaf with an answer key, added next to the two items. The sync skips it on an in-app exam.
const keyedChoice = q(4, 1, 2, { answer_type: "multiple_choice", correct_answer: "B" });

describe("examRubricOutOfDate", () => {
  it.each<[string, ExamQuestionPoints[], GeneratedCheckPoints[], boolean]>([
    // Catches a notice that shows right after a build, or that asks the parent (part 1) for a check.
    ["every leaf's check matches its points", [part, item1, item2], builtChecks, false],
    // Catches a false alarm: the sync writes coalesce(points, 0), so a null question gets a 0-point check.
    [
      "a question with no points has a 0-point check",
      [part, item1, item2, q(4, 1, null)],
      [...builtChecks, { exam_question_id: 4, points: 0 }],
      false
    ],
    // Catches telling an instructor the rubric changed "since it was built" when it never was. Save structure
    // builds an empty rubric itself, and a hand-written rubric gets the toast hint instead.
    ["the rubric was never built from the exam", [part, item1, item2], [], false],
    // Catches expecting a check the sync never makes: quiz_autograde scores this leaf on an in-app exam.
    ["an in-app objective leaf with an answer key has no check", [part, item1, item2, keyedChoice], builtChecks, true]
  ])("is up to date when %s", (_name, questions, checks, inApp) => {
    expect(examRubricOutOfDate(questions, checks, inApp)).toBe(false);
  });

  it.each<[string, ExamQuestionPoints[], GeneratedCheckPoints[], boolean]>([
    // The case #1190 is about: points changed after the rubric was built.
    ["a question's points changed after the build", [part, { ...item1, points: 10 }, item2], builtChecks, false],
    // Catches only looking at nested questions: a flat exam's top-level questions are leaves too.
    [
      "a top-level question with no children changed points",
      [q(6, null, 4)],
      [{ exam_question_id: 6, points: 2 }],
      false
    ],
    // Catches only comparing checks that exist: a question added after the build has none yet.
    ["a leaf question was added after the build", [part, item1, item2, q(4, 1, 2)], builtChecks, false],
    // Catches treating an old leaf check as covering its new children: item 1 gained a sub-item.
    ["a leaf question gained children after the build", [part, item1, item2, q(5, 2, 5)], builtChecks, false],
    // Catches skipping every objective leaf: with no answer key there's nothing to autograde, so it gets a check.
    [
      "an in-app objective leaf with no answer key has no check",
      [part, item1, item2, { ...keyedChoice, correct_answer: null }],
      builtChecks,
      true
    ],
    // Catches ignoring the delivery mode: a paper exam has no autograder, so the same leaf needs a check.
    ["a paper objective leaf with an answer key has no check", [part, item1, item2, keyedChoice], builtChecks, false]
  ])("is out of date when %s", (_name, questions, checks, inApp) => {
    expect(examRubricOutOfDate(questions, checks, inApp)).toBe(true);
  });
});
