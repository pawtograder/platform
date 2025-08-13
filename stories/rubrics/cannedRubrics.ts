export type SimpleCheckOption = {
  label: string;
  points: number;
  description?: string;
};

export type SimpleCheck = {
  id: number;
  name: string;
  description?: string;
  points: number;
  is_annotation: boolean;
  annotation_target?: "file" | "artifact";
  file?: string;
  artifact?: string;
  is_required?: boolean;
  is_comment_required?: boolean;
  max_annotations?: number;
  student_visibility?: "always" | "if_applied" | "if_released" | "never";
  options?: SimpleCheckOption[];
};

export type SimpleCriteria = {
  id: number;
  name: string;
  description?: string;
  is_additive: boolean;
  total_points: number;
  min_checks_per_submission?: number;
  max_checks_per_submission?: number;
  checks: SimpleCheck[];
};

export type SimplePart = {
  id: number;
  name: string;
  description?: string;
  criteria: SimpleCriteria[];
};

export type SimpleRubric = {
  id: number;
  name: string;
  description?: string;
  parts: SimplePart[];
};

export const additiveVsSubtractive: SimpleRubric = {
  id: 1,
  name: "Additive vs Subtractive",
  parts: [
    {
      id: 10,
      name: "Functionality",
      criteria: [
        {
          id: 100,
          name: "Passing tests (additive)",
          is_additive: true,
          total_points: 20,
          checks: [
            { id: 1, name: "Public API works", points: 5, is_annotation: false },
            { id: 2, name: "Edge cases handled", points: 5, is_annotation: false }
          ]
        },
        {
          id: 101,
          name: "Style deductions (subtractive)",
          is_additive: false,
          total_points: 10,
          checks: [
            { id: 3, name: "Magic numbers", points: 1, is_annotation: true, annotation_target: "file" },
            { id: 4, name: "Redundant code", points: 2, is_annotation: true, annotation_target: "file" }
          ]
        }
      ]
    }
  ]
};

export const optionsExample: SimpleRubric = {
  id: 2,
  name: "Options Example",
  parts: [
    {
      id: 20,
      name: "API Correctness",
      criteria: [
        {
          id: 200,
          name: "HTTP response quality",
          is_additive: true,
          total_points: 10,
          checks: [
            {
              id: 5,
              name: "Response completeness",
              points: 0,
              is_annotation: false,
              is_required: true,
              options: [
                { label: "Complete and correct", points: 5 },
                { label: "Mostly complete", points: 3 },
                { label: "Incomplete", points: 1 }
              ]
            }
          ]
        }
      ]
    }
  ]
};

export const visibilityExample: SimpleRubric = {
  id: 3,
  name: "Visibility",
  parts: [
    {
      id: 30,
      name: "Feedback",
      criteria: [
        {
          id: 300,
          name: "Public notes",
          is_additive: true,
          total_points: 0,
          checks: [{ id: 6, name: "General praise", points: 0, is_annotation: false, student_visibility: "always" }]
        },
        {
          id: 301,
          name: "Internal notes",
          is_additive: true,
          total_points: 0,
          checks: [{ id: 7, name: "For staff only", points: 0, is_annotation: false, student_visibility: "never" }]
        },
        {
          id: 302,
          name: "Released only",
          is_additive: true,
          total_points: 0,
          checks: [
            { id: 8, name: "Visible when released", points: 0, is_annotation: false, student_visibility: "if_released" }
          ]
        },
        {
          id: 303,
          name: "Only if applied",
          is_additive: true,
          total_points: 0,
          checks: [
            { id: 9, name: "Shown when applied", points: 0, is_annotation: false, student_visibility: "if_applied" }
          ]
        }
      ]
    }
  ]
};