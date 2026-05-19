import { HydratedRubricCheck, HydratedRubricCriteria } from "@/utils/supabase/DatabaseTypes";

// Templates emit placeholder ids (-1). Save-time normalization in the page assigns
// real negative ids unique within the rubric; the diff-against-baseline pipeline
// treats id<=0 as "create new" so the values here just need to not collide with
// real DB ids.
const PLACEHOLDER_ID = -1;

function baseCheck(overrides: Partial<HydratedRubricCheck>): HydratedRubricCheck {
  return {
    id: PLACEHOLDER_ID,
    name: "New check",
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
  };
}

function baseCriteria(overrides: Partial<HydratedRubricCriteria>): HydratedRubricCriteria {
  return {
    id: PLACEHOLDER_ID,
    name: "New criterion",
    description: null,
    is_deduction_only: false,
    ordinal: 0,
    rubric_id: 0,
    assignment_id: 0,
    class_id: 0,
    created_at: "",
    data: null,
    rubric_part_id: 0,
    is_additive: true,
    total_points: 0,
    max_checks_per_submission: null,
    min_checks_per_submission: null,
    rubric_checks: [],
    ...overrides
  };
}

export function emptyCheckbox(): HydratedRubricCriteria {
  return baseCriteria({
    name: "New criterion",
    is_additive: true,
    total_points: 1,
    rubric_checks: [baseCheck({ name: "New check", points: 1 })]
  });
}

export function metPartialNotMet(): HydratedRubricCriteria {
  return baseCriteria({
    name: "Met / partial / not met",
    is_additive: false,
    total_points: 2,
    max_checks_per_submission: 1,
    min_checks_per_submission: 1,
    rubric_checks: [
      baseCheck({ name: "Met", points: 2, ordinal: 0 }),
      baseCheck({ name: "Partially met", points: 1, ordinal: 1 }),
      baseCheck({ name: "Not met", points: 0, ordinal: 2 })
    ]
  });
}

export function multiOption(): HydratedRubricCriteria {
  return baseCriteria({
    name: "Multi-option check",
    is_additive: true,
    total_points: 4,
    rubric_checks: [
      baseCheck({
        name: "Select one option",
        points: 4,
        is_required: true,
        data: {
          options: [
            { label: "Satisfactory", points: 4 },
            { label: "Marginal", points: 2 },
            { label: "Unacceptable", points: 0 }
          ]
        }
      })
    ]
  });
}

export function deductionOnlyAnnotation(): HydratedRubricCriteria {
  return baseCriteria({
    name: "Deduction-only annotations",
    is_additive: false,
    is_deduction_only: true,
    total_points: 10,
    rubric_checks: [
      baseCheck({
        name: "Style violation",
        points: 2,
        is_annotation: true,
        is_comment_required: true,
        max_annotations: 5,
        annotation_target: "file",
        student_visibility: "if_applied"
      })
    ]
  });
}

export const CRITERIA_TEMPLATES = {
  blank: emptyCheckbox,
  metPartialNotMet,
  multiOption,
  deductionOnlyAnnotation
} as const;

export type CriteriaTemplateKey = keyof typeof CRITERIA_TEMPLATES;
