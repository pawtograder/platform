"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useSubmissionDataContext } from "./useSubmissionDataContext";

/**
 * Insert mutation for submission_artifact_comments.
 * Optimistically adds a row and invalidates the cache on settle.
 */
export function useSubmissionArtifactCommentInsert() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_artifact_comments",
    queryKey: ["submission", submissionId, "artifact_comments"],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for submission_artifact_comments.
 */
export function useSubmissionArtifactCommentUpdate() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_artifact_comments",
    queryKey: ["submission", submissionId, "artifact_comments"],
    mutationType: "update",
    supabase
  });
}

/**
 * Delete mutation for submission_artifact_comments.
 */
export function useSubmissionArtifactCommentDelete() {
  const { submissionId, supabase } = useSubmissionDataContext();
  return useSupabaseRealtimeMutation({
    table: "submission_artifact_comments",
    queryKey: ["submission", submissionId, "artifact_comments"],
    mutationType: "delete",
    supabase
  });
}
