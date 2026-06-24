/**
 * Verifies the YAML shape the CLI rubric exporter emits for the `references`
 * block on a rubric check.
 *
 * The Deno-side helper that builds the YAML lives in
 * `supabase/functions/cli/utils/rubricReferences.ts` and cannot be imported
 * into Jest. The algorithm is intentionally a mirror of
 * `lib/rubric/references.ts:serializeReferences`, which this test exercises
 * end-to-end on a minimal in-memory assignment snapshot. If you change the
 * disambiguation rule in one, change both — see the JSDoc in the Deno helper.
 */

import { serializeReferences } from "@/lib/rubric/references";
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

describe("CLI rubric export — references block shape", () => {
  // Two rubrics across two rounds, one outgoing reference grading → self-review.
  const selfReviewCheck = makeCheck(101, "Item A");
  const gradingCheck = makeCheck(201, "Item B");
  const selfReview = makeRubric(1, "self-review", "PartOne", "CritOne", [selfReviewCheck]);
  const grading = makeRubric(2, "grading-review", "PartTwo", "CritTwo", [gradingCheck]);

  it("emits the name-keyed references block when names are unambiguous", () => {
    const yaml = serializeReferences([{ referenced_rubric_check_id: 101 }], [selfReview, grading]);
    expect(yaml).toEqual([
      {
        review_round: "self-review",
        part: "PartOne",
        criterion: "CritOne",
        check: "Item A"
      }
    ]);
  });

  it("falls back to numeric id when the target name path is ambiguous", () => {
    const dupCheck = makeCheck(102, "Item A"); // same name as 101 in same path
    const ambiguousRubric: HydratedRubric = {
      ...selfReview,
      rubric_parts: [
        {
          ...selfReview.rubric_parts[0],
          rubric_criteria: [
            {
              ...selfReview.rubric_parts[0].rubric_criteria[0],
              rubric_checks: [selfReviewCheck, dupCheck]
            }
          ]
        }
      ]
    };
    const yaml = serializeReferences([{ referenced_rubric_check_id: 102 }], [ambiguousRubric, grading]);
    expect(yaml).toEqual([{ id: 102 }]);
  });

  it("omits references entirely when a check has none (caller responsibility)", () => {
    // The CLI exporter does not emit `references:` at all when the array is empty.
    // The serializer simply returns []; emitting the field is the caller's job.
    const yaml = serializeReferences([], [selfReview, grading]);
    expect(yaml).toEqual([]);
  });

  it("falls back to numeric id when the target check is not in the indexed rubrics", () => {
    const yaml = serializeReferences([{ referenced_rubric_check_id: 9999 }], [selfReview, grading]);
    expect(yaml).toEqual([{ id: 9999 }]);
  });
});
