"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useSubmissionDataContext } from "./useSubmissionDataContext";

/**
 * Insert mutation for submission_file_comments.
 * Optimistically adds a row and invalidates the cache on settle.
 */
export function useSubmissionFileCommentInsert() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_file_comments",
    queryKey: ["submission", submissionId, "file_comments"],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for submission_file_comments.
 */
export function useSubmissionFileCommentUpdate() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_file_comments",
    queryKey: ["submission", submissionId, "file_comments"],
    mutationType: "update",
    supabase
  });
}

/**
 * Delete mutation for submission_file_comments.
 */
export function useSubmissionFileCommentDelete() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_file_comments",
    queryKey: ["submission", submissionId, "file_comments"],
    mutationType: "delete",
    supabase
  });
}
