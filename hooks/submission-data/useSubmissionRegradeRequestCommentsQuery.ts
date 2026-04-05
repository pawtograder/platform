"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useSubmissionDataContext } from "./useSubmissionDataContext";
import type { RegradeRequestComment } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches submission_regrade_request_comments for the current submission with scoped per-submission RT.
 * Replaces: SubmissionController.submission_regrade_request_comments TableController
 */
export function useSubmissionRegradeRequestCommentsQuery() {
  const { submissionId, courseId, supabase, classRtc } = useSubmissionDataContext();

  return useSupabaseRealtimeQuery<"submission_regrade_request_comments", RegradeRequestComment>({
    queryKey: ["submission", submissionId, "regrade_request_comments"],
    table: "submission_regrade_request_comments",
    queryFn: () => supabase.from("submission_regrade_request_comments").select("*").eq("submission_id", submissionId),
    classRtc,
    supabase,
    scope: "scoped"
  });
}
