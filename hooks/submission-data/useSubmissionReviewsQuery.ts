"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useSubmissionDataContext } from "./useSubmissionDataContext";
import type { SubmissionReview } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches submission_reviews for the current submission with scoped per-submission RT.
 * Replaces: SubmissionController.submission_reviews TableController
 */
export function useSubmissionReviewsQuery() {
  const { submissionId, courseId, supabase, classRtc } = useSubmissionDataContext();

  return useSupabaseRealtimeQuery<"submission_reviews", SubmissionReview>({
    queryKey: ["submission", submissionId, "reviews"],
    table: "submission_reviews",
    queryFn: () => supabase.from("submission_reviews").select("*").eq("submission_id", submissionId),
    classRtc,
    supabase,
    scope: "scoped"
  });
}
