import { getDisplayedGradingTotalForStudent } from "@/lib/getDisplayedGradingTotalForStudent";

describe("getDisplayedGradingTotalForStudent", () => {
  const pid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("returns null when review or profile id is missing", () => {
    expect(getDisplayedGradingTotalForStudent(null, pid)).toBeNull();
    expect(getDisplayedGradingTotalForStudent({ total_score: 5 }, null)).toBeNull();
    expect(getDisplayedGradingTotalForStudent({ total_score: 5 }, undefined)).toBeNull();
  });

  it("prefers per_student_grading_totals over individual_scores and total_score", () => {
    expect(
      getDisplayedGradingTotalForStudent(
        {
          total_score: 99,
          per_student_grading_totals: { [pid]: 42, other: 1 },
          individual_scores: { [pid]: 7 }
        },
        pid
      )
    ).toBe(42);
  });

  it("falls back to individual_scores when per-student map has no key", () => {
    expect(
      getDisplayedGradingTotalForStudent(
        {
          total_score: 99,
          per_student_grading_totals: { other: 1 },
          individual_scores: { [pid]: 8 }
        },
        pid
      )
    ).toBe(8);
  });

  it("falls back to total_score", () => {
    expect(
      getDisplayedGradingTotalForStudent(
        {
          total_score: 50,
          per_student_grading_totals: {},
          individual_scores: {}
        },
        pid
      )
    ).toBe(50);
  });

  it("parses numeric strings in json maps", () => {
    expect(
      getDisplayedGradingTotalForStudent(
        {
          total_score: 1,
          per_student_grading_totals: { [pid]: "12.5" as unknown as number }
        },
        pid
      )
    ).toBe(12.5);
  });
});
