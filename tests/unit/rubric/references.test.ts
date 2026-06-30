import { resolveReferences, serializeReferences } from "@/lib/rubric/references";
import { HydratedRubric, HydratedRubricCheck } from "@/utils/supabase/DatabaseTypes";

function makeCheck(id: number, name: string): HydratedRubricCheck {
  return {
    id,
    name,
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
    points: 1,
    annotation_target: null,
    student_visibility: "always",
    kpi_category: null
  };
}

function makeRubric(
  id: number,
  reviewRound: HydratedRubric["review_round"],
  partName: string,
  critName: string,
  checks: HydratedRubricCheck[]
): HydratedRubric {
  return {
    id,
    class_id: 0,
    created_at: "",
    name: `Rubric ${id}`,
    description: null,
    assignment_id: 1,
    is_private: false,
    review_round: reviewRound,
    cap_score_to_assignment_points: false,
    hide_unless_assigned: false,
    rubric_parts: [
      {
        id: id * 10,
        name: partName,
        description: null,
        ordinal: 0,
        rubric_id: id,
        class_id: 0,
        created_at: "",
        assignment_id: 1,
        is_individual_grading: false,
        is_assign_to_student: false,
        rubric_criteria: [
          {
            id: id * 100,
            name: critName,
            description: null,
            is_deduction_only: false,
            ordinal: 0,
            rubric_id: id,
            assignment_id: 1,
            class_id: 0,
            created_at: "",
            data: null,
            rubric_part_id: id * 10,
            is_additive: false,
            total_points: 0,
            max_checks_per_submission: null,
            min_checks_per_submission: null,
            rubric_checks: checks
          }
        ]
      }
    ]
  };
}

describe("resolveReferences", () => {
  // Three small rubrics across three review rounds. Generic names only.
  const selfReview = makeRubric(1, "self-review", "Alpha", "Beta", [makeCheck(101, "Foo")]);
  const meta = makeRubric(3, "meta-grading-review", "Gamma", "Delta", [
    makeCheck(301, "Bar"),
    makeCheck(302, "Bar") // duplicate name within same criterion
  ]);

  it("resolves a name-keyed cross-round reference", () => {
    const { resolved, errors } = resolveReferences(
      [{ review_round: "self-review", part: "Alpha", criterion: "Beta", check: "Foo" }],
      { otherRubrics: [selfReview, meta], currentReviewRound: "grading-review" }
    );
    expect(errors).toEqual([]);
    expect(resolved).toEqual([{ referenced_rubric_check_id: 101 }]);
  });

  it("returns an error on ambiguous name → caller can fall back to id form", () => {
    const { resolved, errors } = resolveReferences(
      [{ review_round: "meta-grading-review", part: "Gamma", criterion: "Delta", check: "Bar" }],
      { otherRubrics: [meta], currentReviewRound: "grading-review" }
    );
    expect(resolved).toEqual([]);
    expect(errors.join("\n")).toMatch(/ambiguous/i);
  });

  it("resolves by numeric id when name is ambiguous", () => {
    const { resolved, errors } = resolveReferences([{ id: 302 }], {
      otherRubrics: [meta],
      currentReviewRound: "grading-review"
    });
    expect(errors).toEqual([]);
    expect(resolved).toEqual([{ referenced_rubric_check_id: 302 }]);
  });

  it("emits an error when no target matches", () => {
    const { resolved, errors } = resolveReferences(
      [{ review_round: "self-review", part: "Missing", criterion: "Beta", check: "Foo" }],
      { otherRubrics: [selfReview], currentReviewRound: "grading-review" }
    );
    expect(resolved).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/did not resolve/i);
  });

  it("emits an error when target is in the same review round", () => {
    const sameRoundOther = makeRubric(99, "grading-review", "Other", "Other", [makeCheck(990, "Sibling")]);
    const { resolved, errors } = resolveReferences(
      [{ review_round: "grading-review", part: "Other", criterion: "Other", check: "Sibling" }],
      { otherRubrics: [sameRoundOther], currentReviewRound: "grading-review" }
    );
    expect(resolved).toEqual([]);
    expect(errors.join("\n")).toMatch(/cross-round/i);
  });

  it("attaches existing DB row id when reference already exists", () => {
    const { resolved } = resolveReferences(
      [{ review_round: "self-review", part: "Alpha", criterion: "Beta", check: "Foo" }],
      {
        otherRubrics: [selfReview],
        currentReviewRound: "grading-review",
        existingReferences: [{ id: 555, referenced_rubric_check_id: 101 }]
      }
    );
    expect(resolved).toEqual([{ referenced_rubric_check_id: 101, id: 555 }]);
  });
});

describe("serializeReferences", () => {
  const selfReview = makeRubric(1, "self-review", "Alpha", "Beta", [makeCheck(101, "Foo")]);
  const meta = makeRubric(3, "meta-grading-review", "Gamma", "Delta", [makeCheck(301, "Bar"), makeCheck(302, "Bar")]);

  it("emits the name-keyed form when unambiguous", () => {
    const yaml = serializeReferences([{ referenced_rubric_check_id: 101 }], [selfReview, meta]);
    expect(yaml).toEqual([{ review_round: "self-review", part: "Alpha", criterion: "Beta", check: "Foo" }]);
  });

  it("falls back to id form when names are ambiguous across the target", () => {
    // Both 301 and 302 share the same (round, part, criterion, name) — must emit id.
    const yaml = serializeReferences([{ referenced_rubric_check_id: 302 }], [meta]);
    expect(yaml).toEqual([{ id: 302 }]);
  });

  it("falls back to id form when target check is not in the supplied rubrics", () => {
    const yaml = serializeReferences([{ referenced_rubric_check_id: 9999 }], [selfReview]);
    expect(yaml).toEqual([{ id: 9999 }]);
  });

  it("round-trips a name → id-only → name path when the target re-resolves unambiguously", () => {
    // Start with id-only YAML; resolve; re-serialize. Expect named form back.
    const { resolved } = resolveReferences([{ id: 101 }], {
      otherRubrics: [selfReview],
      currentReviewRound: "grading-review"
    });
    const yaml = serializeReferences(resolved, [selfReview]);
    expect(yaml).toEqual([{ review_round: "self-review", part: "Alpha", criterion: "Beta", check: "Foo" }]);
  });
});
