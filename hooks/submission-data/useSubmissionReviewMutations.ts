"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useSubmissionDataContext } from "./useSubmissionDataContext";

/**
 * Update mutation for submission_reviews.
 */
export function useSubmissionReviewUpdate() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_reviews",
    queryKey: ["submission", submissionId, "reviews"],
    mutationType: "update",
    supabase
  });
}
