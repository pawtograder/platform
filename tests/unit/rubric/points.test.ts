import {
  computeRubricMaxPoints,
  computeRubricPointsBreakdown,
  hasSplitGradingParts,
  maxPointsForCriterion
} from "@/lib/rubric/points";
import { HydratedRubric, HydratedRubricCriteria, HydratedRubricPart } from "@/utils/supabase/DatabaseTypes";

function check(points: number) {
  return { points } as HydratedRubricCriteria["rubric_checks"][number];
}

function criterion(
  overrides: Partial<HydratedRubricCriteria> & { rubric_checks?: { points: number }[] } = {}
): HydratedRubricCriteria {
  return {
    id: -1,
    name: "Crit",
    description: null,
    ordinal: 0,
    rubric_id: 0,
    assignment_id: 0,
    class_id: 0,
    created_at: "",
    data: undefined,
    rubric_part_id: 0,
    is_additive: true,
    is_deduction_only: false,
    total_points: 0,
    max_checks_per_submission: null,
    min_checks_per_submission: null,
    rubric_checks: [],
    ...overrides
  } as HydratedRubricCriteria;
}

function part(
  overrides: Partial<HydratedRubricPart> & { rubric_criteria?: HydratedRubricCriteria[] } = {}
): HydratedRubricPart {
  return {
    id: -1,
    name: "Part",
    description: null,
    ordinal: 0,
    rubric_id: 0,
    class_id: 0,
    created_at: "",
    data: undefined,
    assignment_id: 0,
    is_individual_grading: false,
    is_assign_to_student: false,
    rubric_criteria: [],
    ...overrides
  } as HydratedRubricPart;
}

function rubric(parts: HydratedRubricPart[]): HydratedRubric {
  return {
    id: 0,
    name: "R",
    description: null,
    assignment_id: 0,
    class_id: 0,
    is_private: false,
    review_round: "grading-review",
    created_at: "",
    cap_score_to_assignment_points: false,
    rubric_parts: parts
  };
}

describe("maxPointsForCriterion", () => {
  it("additive: capped at total_points", () => {
    expect(
      maxPointsForCriterion(criterion({ is_additive: true, total_points: 4, rubric_checks: [check(3), check(3)] }))
    ).toBe(4);
  });

  it("additive: limited by sum of check points when below total_points", () => {
    expect(
      maxPointsForCriterion(criterion({ is_additive: true, total_points: 10, rubric_checks: [check(2), check(3)] }))
    ).toBe(5);
  });

  it("non-additive: returns total_points regardless of check points", () => {
    expect(
      maxPointsForCriterion(
        criterion({ is_additive: false, is_deduction_only: false, total_points: 7, rubric_checks: [check(1)] })
      )
    ).toBe(7);
  });

  it("deduction-only: returns 0 even with positive check points", () => {
    expect(
      maxPointsForCriterion(
        criterion({ is_additive: false, is_deduction_only: true, total_points: 10, rubric_checks: [check(2), check(5)] })
      )
    ).toBe(0);
  });

  it("handles missing total_points / check points safely", () => {
    expect(
      maxPointsForCriterion({
        is_additive: true,
        is_deduction_only: false,
        total_points: null as unknown as number,
        rubric_checks: [{ points: null as unknown as number }]
      })
    ).toBe(0);
  });
});

describe("computeRubricMaxPoints", () => {
  it("sums standard parts straightforwardly", () => {
    const r = rubric([
      part({ rubric_criteria: [criterion({ total_points: 5, rubric_checks: [check(5)] })] }),
      part({ rubric_criteria: [criterion({ is_additive: false, total_points: 10 })] })
    ]);
    expect(computeRubricMaxPoints(r)).toBe(15);
  });

  it("counts is_individual_grading parts once (each student earns independently)", () => {
    const r = rubric([
      part({ rubric_criteria: [criterion({ total_points: 5, rubric_checks: [check(5)] })] }),
      part({
        is_individual_grading: true,
        rubric_criteria: [criterion({ total_points: 3, rubric_checks: [check(3)] })]
      })
    ]);
    expect(computeRubricMaxPoints(r)).toBe(8);
  });

  it("uses max-of (not sum) for is_assign_to_student parts", () => {
    const r = rubric([
      part({ rubric_criteria: [criterion({ total_points: 10, rubric_checks: [check(10)] })] }),
      part({
        is_assign_to_student: true,
        rubric_criteria: [criterion({ total_points: 5, rubric_checks: [check(5)] })]
      }),
      part({
        is_assign_to_student: true,
        rubric_criteria: [criterion({ total_points: 5, rubric_checks: [check(5)] })]
      })
    ]);
    // standard 10 + max(5, 5) = 15 (NOT 10 + 5 + 5 = 20)
    expect(computeRubricMaxPoints(r)).toBe(15);
  });

  it("ignores deduction-only criteria in the max (they can only lose points)", () => {
    const r = rubric([
      part({
        rubric_criteria: [
          criterion({ total_points: 10, rubric_checks: [check(10)] }),
          criterion({ is_additive: false, is_deduction_only: true, total_points: 5, rubric_checks: [check(2)] })
        ]
      })
    ]);
    expect(computeRubricMaxPoints(r)).toBe(10);
  });
});

describe("computeRubricPointsBreakdown — assign-to-student diagnostics", () => {
  it("reports a pool total separate from per-student contribution", () => {
    const r = rubric([
      part({ rubric_criteria: [criterion({ total_points: 20, rubric_checks: [check(20)] })] }),
      part({
        is_assign_to_student: true,
        name: "Reflection A",
        rubric_criteria: [criterion({ total_points: 5, rubric_checks: [check(5)] })]
      }),
      part({
        is_assign_to_student: true,
        name: "Reflection B",
        rubric_criteria: [criterion({ total_points: 5, rubric_checks: [check(5)] })]
      }),
      part({
        is_assign_to_student: true,
        name: "Reflection C",
        rubric_criteria: [criterion({ total_points: 5, rubric_checks: [check(5)] })]
      })
    ]);
    const b = computeRubricPointsBreakdown(r);
    expect(b.standard).toBe(20);
    expect(b.assignToStudentPerStudent).toBe(5);
    expect(b.assignToStudentTotal).toBe(15);
    expect(b.assignToStudentParts).toHaveLength(3);
    expect(b.assignToStudentUnbalanced).toBe(false);
    expect(b.total).toBe(25);
  });

  it("flags unbalanced when assign-to-student parts have differing maxes", () => {
    const r = rubric([
      part({
        is_assign_to_student: true,
        name: "Heavy",
        rubric_criteria: [criterion({ total_points: 10, rubric_checks: [check(10)] })]
      }),
      part({
        is_assign_to_student: true,
        name: "Light",
        rubric_criteria: [criterion({ total_points: 4, rubric_checks: [check(4)] })]
      })
    ]);
    const b = computeRubricPointsBreakdown(r);
    expect(b.assignToStudentUnbalanced).toBe(true);
    expect(b.assignToStudentPerStudent).toBe(10);
    expect(b.assignToStudentTotal).toBe(14);
    expect(b.total).toBe(10);
  });

  it("does not flag a single assign-to-student part as unbalanced", () => {
    const r = rubric([
      part({
        is_assign_to_student: true,
        rubric_criteria: [criterion({ total_points: 6, rubric_checks: [check(6)] })]
      })
    ]);
    expect(computeRubricPointsBreakdown(r).assignToStudentUnbalanced).toBe(false);
  });
});

describe("hasSplitGradingParts", () => {
  it("detects individual_grading", () => {
    const r = rubric([part({ is_individual_grading: true })]);
    expect(hasSplitGradingParts(r)).toBe(true);
  });

  it("detects assign_to_student", () => {
    const r = rubric([part({ is_assign_to_student: true })]);
    expect(hasSplitGradingParts(r)).toBe(true);
  });

  it("returns false when only standard parts are present", () => {
    const r = rubric([part({})]);
    expect(hasSplitGradingParts(r)).toBe(false);
  });
});
