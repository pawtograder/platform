// Shared fixture for the rubric-editor preview cards. Not a component (leading
// underscore, no matching card name) — imported by the rubric previews. Cast to
// any at the use site: this carries only the fields the editor components read,
// not the full DB-row types.
export const rubricFixture: any = {
  id: 1,
  name: "Problem Set 4 — Binary Search Trees",
  description: "Grading rubric for the BST assignment. Checks correctness, edge cases, and code quality.",
  review_round: "grading-review",
  cap_score_to_assignment_points: true,
  hide_unless_assigned: false,
  is_private: false,
  class_id: 1,
  assignment_id: 1,
  rubric_parts: [
    {
      id: 10,
      ordinal: 0,
      name: "Correctness",
      description: "Does the implementation produce correct results across the test suite?",
      is_assign_to_student: false,
      is_individual_grading: false,
      rubric_criteria: [
        {
          id: 100,
          ordinal: 0,
          name: "Core operations",
          description: "insert / search / delete behave correctly on the public and hidden tests.",
          total_points: 40,
          min_checks_per_submission: 1,
          max_checks_per_submission: null,
          is_additive: true,
          filter: null,
          rubric_checks: [
            {
              id: 1000,
              ordinal: 0,
              name: "All insert tests pass",
              description: "24/24 insertion tests green.",
              points: 15,
              is_annotation: false,
              is_comment_required: false,
              is_required: true,
              max_annotations: null,
              student_visibility: "always",
              annotation_target: null,
              artifact: null,
              file: null,
              data: { options: [] },
              references: []
            },
            {
              id: 1001,
              ordinal: 1,
              name: "Delete handles all three cases",
              description: "Leaf, one-child, and two-child deletions all correct.",
              points: 25,
              is_annotation: false,
              is_comment_required: false,
              is_required: true,
              max_annotations: null,
              student_visibility: "always",
              annotation_target: null,
              artifact: null,
              file: null,
              data: { options: [] },
              references: []
            }
          ]
        },
        {
          id: 101,
          ordinal: 1,
          name: "Edge cases",
          description: "Empty tree, duplicate keys, and unbalanced inputs.",
          total_points: 20,
          min_checks_per_submission: 0,
          max_checks_per_submission: null,
          is_additive: true,
          filter: null,
          rubric_checks: [
            {
              id: 1010,
              ordinal: 0,
              name: "Handles empty tree",
              description: "No crash on operations against an empty tree.",
              points: 10,
              is_annotation: false,
              is_comment_required: false,
              is_required: false,
              max_annotations: null,
              student_visibility: "always",
              annotation_target: null,
              artifact: null,
              file: null,
              data: { options: [] },
              references: []
            }
          ]
        }
      ]
    },
    {
      id: 11,
      ordinal: 1,
      name: "Code Quality",
      description: "Readability, structure, and documentation — graded by hand.",
      is_assign_to_student: false,
      is_individual_grading: false,
      rubric_criteria: [
        {
          id: 110,
          ordinal: 0,
          name: "Style & documentation",
          description: "Naming, comments, and method decomposition.",
          total_points: 10,
          min_checks_per_submission: 0,
          max_checks_per_submission: null,
          is_additive: false,
          filter: null,
          rubric_checks: [
            {
              id: 1100,
              ordinal: 0,
              name: "Missing Javadoc on public methods",
              description: "Annotate each public method lacking documentation.",
              points: -2,
              is_annotation: true,
              is_comment_required: true,
              is_required: false,
              max_annotations: 5,
              student_visibility: "always",
              annotation_target: "file",
              artifact: null,
              file: null,
              data: { options: [] },
              references: []
            }
          ]
        }
      ]
    }
  ]
};

// A single part / criteria / check, for the sub-component cards.
export const partFixture: any = rubricFixture.rubric_parts[0];
export const criteriaFixture: any = rubricFixture.rubric_parts[0].rubric_criteria[0];
export const checkFixture: any = rubricFixture.rubric_parts[0].rubric_criteria[0].rubric_checks[0];
export const annotationCheckFixture: any = rubricFixture.rubric_parts[1].rubric_criteria[0].rubric_checks[0];
