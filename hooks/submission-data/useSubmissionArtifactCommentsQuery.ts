"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useSubmissionDataContextMaybe } from "./useSubmissionDataContext";
import { createClient } from "@/utils/supabase/client";
import type { SubmissionArtifactComment } from "@/utils/supabase/DatabaseTypes";

let _fallbackClient: ReturnType<typeof createClient> | null = null;
function getFallbackClient() {
  if (!_fallbackClient) _fallbackClient = createClient();
  return _fallbackClient;
}

/**
 * Fetches submission_artifact_comments for the current submission with scoped per-submission RT.
 * Safe to call outside SubmissionDataProvider — returns an empty, disabled query.
 */
export function useSubmissionArtifactCommentsQuery() {
  const ctx = useSubmissionDataContextMaybe();
  const submissionId = ctx?.submissionId ?? 0;
  const supabase = ctx?.supabase ?? getFallbackClient();
  const classRtc = ctx?.classRtc ?? null;

  return useSupabaseRealtimeQuery<"submission_artifact_comments", SubmissionArtifactComment>({
    queryKey: ["submission", submissionId, "artifact_comments"],
    table: "submission_artifact_comments",
    queryFn: () => supabase.from("submission_artifact_comments").select("*").eq("submission_id", submissionId),
    classRtc,
    supabase,
    scope: "scoped",
    enabled: !!ctx
  });
}
