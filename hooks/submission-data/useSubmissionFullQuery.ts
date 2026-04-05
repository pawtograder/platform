"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useSubmissionDataContext } from "./useSubmissionDataContext";

const SUBMISSION_FULL_SELECT = `
  *,
  submission_files(*),
  grader_results!grader_results_submission_id_fkey(*, grader_result_tests(*), grader_result_output(*)),
  submission_artifacts(*)
`.trim();

/**
 * Fetches the full submission with joined files, grader results, and artifacts.
 * Uses .single() since we query by primary key.
 * Replaces: SubmissionControllerCreator useShow() call
 */
export function useSubmissionFullQuery() {
  const { submissionId, supabase, classRtc } = useSubmissionDataContext();

  return useSupabaseRealtimeQuery<"submissions">({
    queryKey: ["submission", submissionId, "full"],
    table: "submissions",
    queryFn: () => supabase.from("submissions").select(SUBMISSION_FULL_SELECT).eq("id", submissionId).single(),
    classRtc,
    supabase,
    scope: "scoped",
    selectForRefetch: SUBMISSION_FULL_SELECT
  });
}
