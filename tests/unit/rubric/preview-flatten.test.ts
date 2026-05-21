import { flattenHydratedRubric } from "@/lib/PreviewAssignmentController";
import type {
  HydratedRubric,
  HydratedRubricCheck,
  HydratedRubricCriteria,
  HydratedRubricPart
} from "@/utils/supabase/DatabaseTypes";

function makeCheck(overrides: Partial<HydratedRubricCheck> = {}): HydratedRubricCheck {
  return {
    id: -1,
    name: "check",
    description: null,
    ordinal: 0,
    rubric_id: 0,
    assignment_id: 0,
    class_id: 0,
    created_at: "",
    data: null,
    rubric_criteria_id: 0,
    file: null,
    artifact: null,
    group: null,
    is_annotation: false,
    is_comment_required: false,
    is_required: false,
    max_annotations: null,
    points: 0,
    annotation_target: null,
    student_visibility: "always",
    kpi_category: null,
    ...overrides
  } as HydratedRubricCheck;
}

function makeCriteria(overrides: Partial<HydratedRubricCriteria> = {}): HydratedRubricCriteria {
  return {
    id: -1,
    name: "crit",
    description: null,
    ordinal: 0,
    rubric_id: 0,
    rubric_part_id: 0,
    assignment_id: 0,
    class_id: 0,
    created_at: "",
    data: null,
    is_additive: false,
    is_deduction_only: false,
    total_points: 0,
    max_checks_per_submission: null,
    min_checks_per_submission: null,
    rubric_checks: [makeCheck()],
    ...overrides
  } as HydratedRubricCriteria;
}

function makePart(overrides: Partial<HydratedRubricPart> = {}): HydratedRubricPart {
  return {
    id: -1,
    name: "part",
    description: null,
    ordinal: 0,
    rubric_id: 0,
    assignment_id: 0,
    class_id: 0,
    created_at: "",
    data: null,
    is_individual_grading: false,
    is_assign_to_student: false,
    rubric_criteria: [makeCriteria()],
    ...overrides
  } as HydratedRubricPart;
}

function makeRubric(parts: HydratedRubricPart[]): HydratedRubric {
  return {
    id: 1,
    name: "r",
    description: null,
    assignment_id: 1,
    class_id: 1,
    is_private: false,
    review_round: "grading-review",
    created_at: "",
    cap_score_to_assignment_points: false,
    rubric_parts: parts
  } as HydratedRubric;
}

describe("flattenHydratedRubric — duplicate / sentinel ID handling (issue #198)", () => {
  it("assigns unique synthetic ids to multiple new parts that share id=-1", () => {
    const hydrated = makeRubric([
      makePart({ id: -1, name: "A" }),
      makePart({ id: -1, name: "B" }),
      makePart({ id: -1, name: "C" })
    ]);

    const { parts } = flattenHydratedRubric(hydrated);

    expect(parts).toHaveLength(3);
    const ids = parts.map((p) => p.id);
    expect(new Set(ids).size).toBe(3);
    // Sentinel inputs must not survive — every id should be strictly negative & unique.
    for (const id of ids) {
      expect(id).toBeLessThan(0);
    }
    expect(parts.map((p) => p.name)).toEqual(["A", "B", "C"]);
  });

  it("assigns unique synthetic ids when criteria within a part share duplicate ids", () => {
    const hydrated = makeRubric([
      makePart({
        id: 100,
        rubric_criteria: [
          makeCriteria({ id: 7, name: "x" }),
          makeCriteria({ id: 7, name: "y" }), // duplicate of first criteria
          makeCriteria({ id: -1, name: "z" })
        ]
      })
    ]);

    const { parts, criteria } = flattenHydratedRubric(hydrated);

    expect(criteria).toHaveLength(3);
    const ids = criteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(3);
    // The first occurrence of a positive id is preserved.
    expect(criteria[0].id).toBe(7);
    expect(criteria[1].id).toBeLessThan(0);
    expect(criteria[2].id).toBeLessThan(0);
    // Foreign keys must point at the (remapped) parent.
    const partId = parts[0].id;
    for (const c of criteria) {
      expect(c.rubric_part_id).toBe(partId);
    }
  });

  it("rewrites check.rubric_criteria_id to match the remapped criteria id", () => {
    const hydrated = makeRubric([
      makePart({
        id: -1,
        rubric_criteria: [
          makeCriteria({
            id: -1,
            rubric_checks: [makeCheck({ id: -1, name: "ck1" }), makeCheck({ id: -1, name: "ck2" })]
          }),
          makeCriteria({
            id: -1,
            rubric_checks: [makeCheck({ id: -1, name: "ck3" })]
          })
        ]
      })
    ]);

    const { criteria, checks } = flattenHydratedRubric(hydrated);

    expect(checks).toHaveLength(3);
    // All checks unique.
    expect(new Set(checks.map((c) => c.id)).size).toBe(3);
    // First two checks belong to first criteria; third to the second.
    expect(checks[0].rubric_criteria_id).toBe(criteria[0].id);
    expect(checks[1].rubric_criteria_id).toBe(criteria[0].id);
    expect(checks[2].rubric_criteria_id).toBe(criteria[1].id);
    expect(criteria[0].id).not.toBe(criteria[1].id);
  });

  it("preserves real positive ids unchanged when they are unique", () => {
    const hydrated = makeRubric([
      makePart({
        id: 10,
        rubric_criteria: [
          makeCriteria({
            id: 20,
            rubric_checks: [makeCheck({ id: 30 })]
          })
        ]
      })
    ]);

    const { parts, criteria, checks } = flattenHydratedRubric(hydrated);

    expect(parts[0].id).toBe(10);
    expect(criteria[0].id).toBe(20);
    expect(criteria[0].rubric_part_id).toBe(10);
    expect(checks[0].id).toBe(30);
    expect(checks[0].rubric_criteria_id).toBe(20);
  });

  it("treats id=0 as a sentinel and replaces it with a unique synthetic id", () => {
    const hydrated = makeRubric([makePart({ id: 0, name: "A" }), makePart({ id: 0, name: "B" })]);

    const { parts } = flattenHydratedRubric(hydrated);

    expect(new Set(parts.map((p) => p.id)).size).toBe(2);
    for (const p of parts) {
      expect(p.id).toBeLessThan(0);
    }
  });
});
