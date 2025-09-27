import React, { createContext, useContext } from "react";
import type { HydratedRubric, HydratedRubricCriteria, HydratedRubricPart } from "@/utils/supabase/DatabaseTypes";

const sampleRubric: HydratedRubric = {
  id: 1,
  assignment_id: 1,
  name: "Grading Rubric",
  description: "Sample rubric for Storybook",
  review_round: "grading-review" as any,
  rubric_parts: [
    {
      id: 10,
      rubric_id: 1,
      name: "Code Quality",
      description: "",
      ordinal: 1,
      rubric_criteria: [
        {
          id: 100,
          rubric_part_id: 10,
          rubric_id: 1,
          name: "Style",
          description: "Follows style guide",
          ordinal: 1,
          is_additive: true,
          total_points: 10,
          min_checks_per_submission: null,
          max_checks_per_submission: null,
          rubric_checks: [
            {
              id: 1000,
              rubric_criteria_id: 100,
              name: "Good naming",
              description: "Variables and functions are well named",
              points: 2,
              is_annotation: false,
              student_visibility: "always" as any
            } as any,
            {
              id: 1001,
              rubric_criteria_id: 100,
              name: "Inline comments",
              description: "Helpful inline comments",
              points: 1,
              is_annotation: true,
              annotation_target: "file" as any,
              student_visibility: "if_released" as any
            } as any
          ]
        } as HydratedRubricCriteria
      ]
    } as HydratedRubricPart
  ]
} as HydratedRubric;

const Ctx = createContext({
  assignment: {
    id: 1,
    class_id: 1,
    grading_rubric_id: 1,
    total_points: 100,
    autograder_points: 50
  },
  rubrics: [sampleRubric],
  rubricCheckById: new Map<number, any>([
    [1000, sampleRubric.rubric_parts[0].rubric_criteria[0].rubric_checks[0]],
    [1001, sampleRubric.rubric_parts[0].rubric_criteria[0].rubric_checks[1]]
  ]),
  rubricCriteriaById: new Map<number, any>([[100, sampleRubric.rubric_parts[0].rubric_criteria[0]]]),
  reviewAssignments: { rows: [] },
  regradeRequests: { rows: [] },
  submissions: { rows: [] },
  assignmentGroups: { rows: [] },
  isReady: true,
  getReviewAssignmentRubricPartsController: () => ({ list: (cb: any) => ({ unsubscribe: () => {}, data: [] }) }),
  releaseReviewAssignmentRubricPartsController: (_id: number) => {}
});

export function AssignmentProvider({ children }: { children: React.ReactNode }) {
  return <Ctx.Provider value={useContext(Ctx)}>{children}</Ctx.Provider>;
}

export function useAssignmentController() {
  return useContext(Ctx) as any;
}

export function useRubrics() {
  return useContext(Ctx).rubrics as HydratedRubric[];
}

export function useRubricById(id?: number | null) {
  if (!id) return undefined;
  return useRubrics().find((r) => r.id === id);
}

export function useReviewAssignmentRubricParts() {
  return [] as any[];
}

export function useMyReviewAssignments() {
  return [] as any[];
}

export function useReviewAssignment() {
  return undefined as any;
}
