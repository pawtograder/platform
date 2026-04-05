"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useSubmissionDataContext } from "./useSubmissionDataContext";
import type { SubmissionComments } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches submission_comments for the current submission with scoped per-submission RT.
 * Replaces: SubmissionController.submission_comments TableController
 */
export function useSubmissionCommentsQuery() {
  const { submissionId, courseId, supabase, classRtc } = useSubmissionDataContext();

  return useSupabaseRealtimeQuery<"submission_comments", SubmissionComments>({
    queryKey: ["submission", submissionId, "comments"],
    table: "submission_comments",
    queryFn: () => supabase.from("submission_comments").select("*").eq("submission_id", submissionId),
    classRtc,
    supabase,
    scope: "scoped"
  });
}
