"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useSubmissionDataContext } from "./useSubmissionDataContext";

/**
 * Insert mutation for submission_regrade_request_comments.
 */
export function useSubmissionRegradeRequestCommentInsert() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_regrade_request_comments",
    queryKey: ["submission", submissionId, "regrade_request_comments"],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for submission_regrade_request_comments.
 */
export function useSubmissionRegradeRequestCommentUpdate() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_regrade_request_comments",
    queryKey: ["submission", submissionId, "regrade_request_comments"],
    mutationType: "update",
    supabase
  });
}
