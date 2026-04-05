"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useSubmissionDataContext } from "./useSubmissionDataContext";
import type { SubmissionFileComment } from "@/utils/supabase/DatabaseTypes";

/**
 * Fetches submission_file_comments for the current submission with scoped per-submission RT.
 * Replaces: SubmissionController.submission_file_comments TableController
 */
export function useSubmissionFileCommentsQuery() {
  const { submissionId, courseId, supabase, classRtc } = useSubmissionDataContext();

  return useSupabaseRealtimeQuery<"submission_file_comments", SubmissionFileComment>({
    queryKey: ["submission", submissionId, "file_comments"],
    table: "submission_file_comments",
    queryFn: () => supabase.from("submission_file_comments").select("*").eq("submission_id", submissionId),
    classRtc,
    supabase,
    scope: "scoped"
  });
}
