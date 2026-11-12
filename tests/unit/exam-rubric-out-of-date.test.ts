/**
 * @jest-environment node
 */

import { examRubricOutOfDate, type ExamQuestionPoints, type GeneratedCheckPoints } from "@/lib/exam/rubricOutOfDate";

// Part 1 has two leaf items worth 5 and 3, the shape "Build rubric from exam" generates a check for each of.
const part: ExamQuestionPoints = { id: 1, parent_id: null, points: 0 };
const item1: ExamQuestionPoints = { id: 2, parent_id: 1, points: 5 };
const item2: ExamQuestionPoints = { id: 3, parent_id: 1, points: 3 };
const builtChecks: GeneratedCheckPoints[] = [
  { exam_question_id: 2, points: 5 },
  { exam_question_id: 3, points: 3 }
];

describe("examRubricOutOfDate", () => {
  it.each<[string, ExamQuestionPoints[], GeneratedCheckPoints[]]>([
    // Catches a notice that shows right after a build, or that asks the parent (part 1) for a check.
    ["every leaf's check matches its points", [part, item1, item2], builtChecks],
    // Catches a false alarm: the sync writes coalesce(points, 0), so a null question gets a 0-point check.
    [
      "a question with no points has a 0-point check",
      [part, item1, item2, { id: 4, parent_id: 1, points: null }],
      [...builtChecks, { exam_question_id: 4, points: 0 }]
    ],
    // Catches telling an instructor the rubric changed "since it was built" when it never was. Save structure
    // builds an empty rubric itself, and a hand-written rubric gets the toast hint instead.
    ["the rubric was never built from the exam", [part, item1, item2], []]
  ])("is up to date when %s", (_name, questions, checks) => {
    expect(examRubricOutOfDate(questions, checks)).toBe(false);
  });

  it.each<[string, ExamQuestionPoints[], GeneratedCheckPoints[]]>([
    // The case #1190 is about: points changed after the rubric was built.
    ["a question's points changed after the build", [part, { ...item1, points: 10 }, item2], builtChecks],
    // Catches only looking at nested questions: a flat exam's top-level questions are leaves too.
    [
      "a top-level question with no children changed points",
      [{ id: 6, parent_id: null, points: 4 }],
      [{ exam_question_id: 6, points: 2 }]
    ],
    // Catches only comparing checks that exist: a question added after the build has none yet.
    [
      "a leaf question was added after the build",
      [part, item1, item2, { id: 4, parent_id: 1, points: 2 }],
      builtChecks
    ],
    // Catches treating an old leaf check as covering its new children: item 1 gained a sub-item.
    [
      "a leaf question gained children after the build",
      [part, item1, item2, { id: 5, parent_id: 2, points: 5 }],
      builtChecks
    ]
  ])("is out of date when %s", (_name, questions, checks) => {
    expect(examRubricOutOfDate(questions, checks)).toBe(true);
  });
});
