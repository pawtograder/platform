import { EXAM_ANSWER_TYPES, normalizeAnswerType } from "@/lib/exam/answerTypes";

describe("normalizeAnswerType", () => {
  it("keeps every type the database check allows", () => {
    for (const t of EXAM_ANSWER_TYPES) expect(normalizeAnswerType(t)).toBe(t);
  });

  it("maps an extracted type the database rejects to free_text", () => {
    expect(normalizeAnswerType("composite")).toBe("free_text");
    expect(normalizeAnswerType("Multiple_Choice")).toBe("free_text");
  });

  it("maps a missing or non-string type to free_text", () => {
    expect(normalizeAnswerType(undefined)).toBe("free_text");
    expect(normalizeAnswerType(null)).toBe("free_text");
    expect(normalizeAnswerType(3)).toBe("free_text");
  });
});
