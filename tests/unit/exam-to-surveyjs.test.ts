/**
 * @jest-environment node
 */

import {
  examQuestionIdFromField,
  examTreeToSurveyJson,
  quizFieldName,
  type StudentQuizQuestion
} from "@/lib/exam/examToSurveyJs";

describe("quiz field name round-trip", () => {
  it("maps an id to a field and back", () => {
    expect(quizFieldName(42)).toBe("q_42");
    expect(examQuestionIdFromField("q_42")).toBe(42);
  });
  it("returns null for non-quiz field names", () => {
    expect(examQuestionIdFromField("panel_3")).toBeNull();
    expect(examQuestionIdFromField("h_3")).toBeNull();
  });
});

describe("examTreeToSurveyJson", () => {
  const tree: StudentQuizQuestion[] = [
    { id: 1, parent_id: null, level: 1, ordinal: 0, label: "Part A", prompt: null, answer_type: null, choices: null },
    {
      id: 2,
      parent_id: 1,
      level: 2,
      ordinal: 0,
      label: "Pick one",
      prompt: "Choose the capital",
      answer_type: "multiple_choice",
      choices: ["London", "Paris"]
    },
    { id: 3, parent_id: 1, level: 2, ordinal: 1, label: "T/F", prompt: null, answer_type: "true_false", choices: null },
    { id: 4, parent_id: 1, level: 2, ordinal: 2, label: "Value", prompt: null, answer_type: "numeric", choices: null },
    { id: 5, parent_id: 1, level: 2, ordinal: 3, label: "Essay", prompt: null, answer_type: "free_text", choices: null }
  ];

  it("maps answer types to SurveyJS question types", () => {
    const json = examTreeToSurveyJson(tree) as { pages: Array<{ elements: Array<Record<string, unknown>> }> };
    const elements = json.pages.flatMap((p) => p.elements);
    const byName = new Map(elements.map((e) => [e.name as string, e]));
    expect(byName.get("q_2")?.type).toBe("radiogroup");
    expect(byName.get("q_2")?.choices).toEqual(["London", "Paris"]);
    expect(byName.get("q_3")?.type).toBe("boolean");
    expect(byName.get("q_4")?.type).toBe("text");
    expect(byName.get("q_4")?.inputType).toBe("number");
    expect(byName.get("q_5")?.type).toBe("comment");
  });

  it("never emits an answer key (input only has the question shape)", () => {
    const serialized = JSON.stringify(examTreeToSurveyJson(tree));
    expect(serialized).not.toContain("correct_answer");
    expect(serialized).not.toContain("grading_tolerance");
  });

  it("puts a level-1 part on its own page", () => {
    const json = examTreeToSurveyJson(tree) as { pages: Array<{ title?: string }> };
    expect(json.pages.length).toBe(1);
    expect(json.pages[0].title).toBe("Part A");
  });

  it("handles a flat list of leaf questions (no grouping)", () => {
    const flat: StudentQuizQuestion[] = [
      {
        id: 10,
        parent_id: null,
        level: 1,
        ordinal: 0,
        label: "Q1",
        prompt: null,
        answer_type: "numeric",
        choices: null
      }
    ];
    const json = examTreeToSurveyJson(flat) as { pages: Array<{ elements: Array<Record<string, unknown>> }> };
    expect(json.pages[0].elements[0].name).toBe("q_10");
    expect(json.pages[0].elements[0].type).toBe("text");
  });
});
