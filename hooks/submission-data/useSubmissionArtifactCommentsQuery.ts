"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useSubmissionDataContext } from "./useSubmissionDataContext";
import type { SubmissionArtifactComment } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches submission_artifact_comments for the current submission with scoped per-submission RT.
 * Replaces: SubmissionController.submission_artifact_comments TableController
 */
export function useSubmissionArtifactCommentsQuery() {
  const { submissionId, courseId, supabase, classRtc } = useSubmissionDataContext();

  return useSupabaseRealtimeQuery<"submission_artifact_comments", SubmissionArtifactComment>({
    queryKey: ["submission", submissionId, "artifact_comments"],
    table: "submission_artifact_comments",
    queryFn: () => supabase.from("submission_artifact_comments").select("*").eq("submission_id", submissionId),
    classRtc,
    supabase,
    scope: "scoped"
  });
}
