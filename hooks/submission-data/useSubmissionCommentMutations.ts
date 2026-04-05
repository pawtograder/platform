"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useSubmissionDataContext } from "./useSubmissionDataContext";

/**
 * Insert mutation for submission_comments.
 * Optimistically adds a row and invalidates the cache on settle.
 */
export function useSubmissionCommentInsert() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_comments",
    queryKey: ["submission", submissionId, "comments"],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for submission_comments.
 */
export function useSubmissionCommentUpdate() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_comments",
    queryKey: ["submission", submissionId, "comments"],
    mutationType: "update",
    supabase
  });
}

/**
 * Delete mutation for submission_comments.
 */
export function useSubmissionCommentDelete() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_comments",
    queryKey: ["submission", submissionId, "comments"],
    mutationType: "delete",
    supabase
  });
}
