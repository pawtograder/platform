import { sanitizeHydratedRubricPoints, normalizePointValue } from "@/lib/rubric/pointsSanitize";
import type { HydratedRubric } from "@/utils/supabase/DatabaseTypes";

describe("normalizePointValue", () => {
  it("leaves non-negative values unchanged", () => {
    expect(normalizePointValue(5)).toEqual({ points: 5, wasNegative: false });
  });

  it("converts negative values to absolute value", () => {
    expect(normalizePointValue(-3)).toEqual({ points: 3, wasNegative: true });
  });
});

describe("sanitizeHydratedRubricPoints", () => {
  it("fixes negative check, option, and criterion total_points", () => {
    const rubric = {
      id: 1,
      name: "Test",
      description: null,
      assignment_id: 1,
      class_id: 1,
      is_private: false,
      review_round: "grading-review" as const,
      cap_score_to_assignment_points: false,
      hide_unless_assigned: false,
      created_at: "",
      rubric_parts: [
        {
          id: 1,
          name: "Part",
          description: null,
          ordinal: 0,
          rubric_id: 1,
          class_id: 1,
          created_at: "",
          data: undefined,
          assignment_id: 1,
          is_individual_grading: false,
          is_assign_to_student: false,
          rubric_criteria: [
            {
              id: 1,
              name: "Crit",
              description: null,
              ordinal: 0,
              rubric_id: 1,
              class_id: 1,
              created_at: "",
              data: undefined,
              rubric_part_id: 1,
              assignment_id: 1,
              is_additive: true,
              is_deduction_only: false,
              total_points: -10,
              max_checks_per_submission: null,
              min_checks_per_submission: null,
              rubric_checks: [
                {
                  id: 1,
                  name: "Check",
                  description: null,
                  ordinal: 0,
                  rubric_id: 1,
                  class_id: 1,
                  created_at: "",
                  data: {
                    options: [
                      { label: "A", points: -2 },
                      { label: "B", points: 1 }
                    ]
                  },
                  rubric_criteria_id: 1,
                  assignment_id: 1,
                  file: null,
                  artifact: null,
                  group: null,
                  is_annotation: false,
                  is_comment_required: false,
                  is_required: false,
                  max_annotations: null,
                  points: -5,
                  annotation_target: null,
                  student_visibility: "always",
                  kpi_category: null
                }
              ]
            }
          ]
        }
      ]
    } satisfies HydratedRubric;

    const { rubric: sanitized, warnings } = sanitizeHydratedRubricPoints(rubric);

    expect(sanitized.rubric_parts[0].rubric_criteria[0].total_points).toBe(10);
    expect(sanitized.rubric_parts[0].rubric_criteria[0].rubric_checks[0].points).toBe(5);
    expect(sanitized.rubric_parts[0].rubric_criteria[0].rubric_checks[0].data).toEqual({
      options: [
        { label: "A", points: 2 },
        { label: "B", points: 1 }
      ]
    });
    expect(warnings).toHaveLength(3);
  });
});
