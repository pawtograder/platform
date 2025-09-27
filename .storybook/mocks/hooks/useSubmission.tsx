import React, { createContext, useContext } from "react";
import type { SubmissionWithFilesGraderResultsOutputTestsAndRubric } from "../../../../utils/supabase/DatabaseTypes";

const sampleSubmission: SubmissionWithFilesGraderResultsOutputTestsAndRubric = {
  id: 1,
  class_id: 1,
  assignment_id: 1,
  profile_id: "profile_1",
  assignment_group_id: null,
  ordinal: 1,
  is_active: true,
  is_not_graded: false,
  repository: "org/repo",
  sha: "abcdef1",
  released: new Date().toISOString(),
  grading_review_id: 1,
  assignments: {
    id: 1,
    class_id: 1,
    total_points: 100,
    autograder_points: 50,
    title: "Assignment 1",
    grading_rubric_id: 1,
    rubrics: {
      id: 1,
      name: "Grading Rubric",
      rubric_criteria: []
    } as any
  } as any,
  submission_files: [
    { id: 11, class_id: 1, submission_id: 1, name: "Main.java", contents: "public class Main{}" } as any
  ],
  submission_artifacts: [],
  grader_results: { score: 40, max_score: 50, grader_result_tests: [], grader_result_output: [] } as any
};

type CtxType = {
  submissionController: any;
};
const defaultValue: CtxType = {
  submissionController: {
    submission: sampleSubmission,
    submission_comments: {
      list: (cb: any) => ({ unsubscribe: () => {}, data: [] }),
      getById: () => ({ data: undefined }),
      update: async () => ({}),
      create: async () => ({})
    },
    submission_file_comments: {
      list: (cb: any) => ({ unsubscribe: () => {}, data: [] }),
      getById: () => ({ data: undefined }),
      update: async () => ({}),
      create: async () => ({}),
      delete: async () => ({})
    },
    submission_artifact_comments: {
      list: (cb: any) => ({ unsubscribe: () => {}, data: [] }),
      getById: () => ({ data: undefined }),
      update: async () => ({}),
      create: async () => ({}),
      delete: async () => ({})
    },
    submission_reviews: {
      rows: [{ id: 1, rubric_id: 1, released: true }],
      list: (cb: any) => ({ unsubscribe: () => {}, data: [{ id: 1, rubric_id: 1, released: true }] }),
      getById: (_id: number) => ({ data: { id: 1, rubric_id: 1, released: true } }),
      update: async () => ({})
    }
  }
};
const Ctx = createContext<CtxType>(defaultValue);

export function SubmissionProvider({ children }: { children: React.ReactNode; submission_id?: number }) {
  return <Ctx.Provider value={defaultValue}>{children}</Ctx.Provider>;
}

export function useSubmission() {
  return useContext(Ctx).submissionController.submission as any;
}

export function useSubmissionMaybe() {
  return useSubmission();
}

export function useSubmissionController() {
  return useContext(Ctx).submissionController as any;
}

export function useSubmissionFileComments() {
  return [] as any[];
}

export function useSubmissionComments() {
  return [] as any[];
}

export function useSubmissionArtifactComments() {
  return [] as any[];
}

export function useReviewAssignment() {
  return { reviewAssignment: undefined, isLoading: false } as any;
}

export function useSubmissionReviewOrGradingReview() {
  return { id: 1, released: true, rubric_id: 1 } as any;
}

export function useWritableSubmissionReviews() {
  return [{ id: 1, rubric_id: 1 }] as any;
}
