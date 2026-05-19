import {
  YamlChecksToHydratedChecks,
  YamlCriteriaToHydratedCriteria,
  YamlPartsToHydratedParts,
  YamlRubricToHydratedRubric
} from "@/lib/rubric/parse";
import { YmlRubricChecksType, YmlRubricCriteriaType, YmlRubricPartType } from "@/utils/supabase/DatabaseTypes";
import { loadFixtureAsYaml } from "./fixtures";

function makeCheck(overrides: Partial<YmlRubricChecksType> = {}): YmlRubricChecksType {
  return {
    name: "Check",
    points: 1,
    is_annotation: false,
    is_required: false,
    is_comment_required: false,
    ...overrides
  };
}

function makeCriteria(overrides: Partial<YmlRubricCriteriaType> = {}): YmlRubricCriteriaType {
  return {
    name: "Crit",
    is_deduction_only: false,
    checks: [makeCheck()],
    ...overrides
  };
}

function makePart(overrides: Partial<YmlRubricPartType> = {}): YmlRubricPartType {
  return {
    name: "Part",
    criteria: [makeCriteria()],
    ...overrides
  };
}

describe("YamlChecksToHydratedChecks", () => {
  it("assigns ordinal from array index", () => {
    const hydrated = YamlChecksToHydratedChecks([makeCheck({ name: "a" }), makeCheck({ name: "b" })]);
    expect(hydrated[0].ordinal).toBe(0);
    expect(hydrated[1].ordinal).toBe(1);
  });

  it("rejects empty checks array", () => {
    expect(() => YamlChecksToHydratedChecks([])).toThrow("Criteria must have at least one check");
  });

  it("defaults id to -1 when missing", () => {
    const [hydrated] = YamlChecksToHydratedChecks([makeCheck()]);
    expect(hydrated.id).toBe(-1);
  });

  it("preserves provided id, points, is_annotation, max_annotations", () => {
    const [hydrated] = YamlChecksToHydratedChecks([
      makeCheck({ id: 42, points: 5, is_annotation: true, max_annotations: 3, is_comment_required: true })
    ]);
    expect(hydrated).toMatchObject({
      id: 42,
      points: 5,
      is_annotation: true,
      max_annotations: 3,
      is_comment_required: true
    });
  });

  it("defaults student_visibility to 'always' when omitted", () => {
    const [hydrated] = YamlChecksToHydratedChecks([makeCheck()]);
    expect(hydrated.student_visibility).toBe("always");
  });

  it("rounds null vs undefined for optional string fields", () => {
    const [hydrated] = YamlChecksToHydratedChecks([makeCheck()]);
    expect(hydrated.description).toBeNull();
    expect(hydrated.file).toBeNull();
    expect(hydrated.artifact).toBeNull();
    expect(hydrated.max_annotations).toBeNull();
    expect(hydrated.annotation_target).toBeNull();
  });
});

describe("YamlCriteriaToHydratedCriteria", () => {
  it("sets ordinal by index and links rubric_part_id", () => {
    const hydrated = YamlCriteriaToHydratedCriteria(7, [makeCriteria(), makeCriteria()]);
    expect(hydrated[0].ordinal).toBe(0);
    expect(hydrated[1].ordinal).toBe(1);
    expect(hydrated[0].rubric_part_id).toBe(7);
  });

  it("defaults is_additive, is_deduction_only, total_points", () => {
    const [hydrated] = YamlCriteriaToHydratedCriteria(1, [makeCriteria()]);
    expect(hydrated.is_additive).toBe(false);
    expect(hydrated.is_deduction_only).toBe(false);
    expect(hydrated.total_points).toBe(0);
  });
});

describe("YamlPartsToHydratedParts", () => {
  it("rejects duplicate part ids", () => {
    expect(() => YamlPartsToHydratedParts([makePart({ id: 1 }), makePart({ id: 1 })])).toThrow(/Duplicate part ids/);
  });

  it("rejects duplicate criteria ids across parts", () => {
    expect(() =>
      YamlPartsToHydratedParts([
        makePart({ criteria: [makeCriteria({ id: 5 })] }),
        makePart({ criteria: [makeCriteria({ id: 5 })] })
      ])
    ).toThrow(/Duplicate criteria ids/);
  });

  it("rejects duplicate check ids across criteria", () => {
    expect(() =>
      YamlPartsToHydratedParts([
        makePart({
          criteria: [makeCriteria({ checks: [makeCheck({ id: 9 })] }), makeCriteria({ checks: [makeCheck({ id: 9 })] })]
        })
      ])
    ).toThrow(/Duplicate check ids/);
  });

  it("rejects is_individual_grading + is_assign_to_student combo", () => {
    expect(() =>
      YamlPartsToHydratedParts([makePart({ name: "Combo", is_individual_grading: true, is_assign_to_student: true })])
    ).toThrow(/cannot have both is_individual_grading and is_assign_to_student/);
  });

  it("allows distinct part/criteria/check ids", () => {
    const result = YamlPartsToHydratedParts([
      makePart({ id: 1, criteria: [makeCriteria({ id: 10, checks: [makeCheck({ id: 100 })] })] }),
      makePart({ id: 2, criteria: [makeCriteria({ id: 20, checks: [makeCheck({ id: 200 })] })] })
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].ordinal).toBe(0);
    expect(result[1].ordinal).toBe(1);
  });

  it("defaults is_individual_grading and is_assign_to_student to false", () => {
    const [part] = YamlPartsToHydratedParts([makePart()]);
    expect(part.is_individual_grading).toBe(false);
    expect(part.is_assign_to_student).toBe(false);
  });
});

describe("YamlRubricToHydratedRubric", () => {
  it("builds a hydrated rubric with empty parts", () => {
    const hydrated = YamlRubricToHydratedRubric(
      { name: "Empty", parts: [] },
      { assignment_id: 5, is_private: false, review_round: "self-review" }
    );
    expect(hydrated.rubric_parts).toEqual([]);
    expect(hydrated.assignment_id).toBe(5);
    expect(hydrated.is_private).toBe(false);
    expect(hydrated.review_round).toBe("self-review");
    expect(hydrated.cap_score_to_assignment_points).toBe(false);
  });

  it("populates each CSV fixture into a hydrated structure", () => {
    for (const name of [
      "multi_option_check",
      "deduction_only",
      "met_partial",
      "individual_grading",
      "assign_to_student"
    ] as const) {
      const yaml = loadFixtureAsYaml(name);
      const hydrated = YamlRubricToHydratedRubric(yaml, {
        assignment_id: 1,
        is_private: false,
        review_round: "grading-review"
      });
      expect(hydrated.name).toBe(yaml.name);
      expect(hydrated.rubric_parts.length).toBe(yaml.parts.length);
    }
  });
});
