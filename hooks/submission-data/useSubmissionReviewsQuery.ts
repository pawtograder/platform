"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useSubmissionDataContextMaybe } from "./useSubmissionDataContext";
import { createClient } from "@/utils/supabase/client";
import type { SubmissionReview } from "@/utils/supabase/DatabaseTypes";

let _fallbackClient: ReturnType<typeof createClient> | null = null;
function getFallbackClient() {
  if (!_fallbackClient) _fallbackClient = createClient();
  return _fallbackClient;
}

/**
 * Fetches submission_reviews for the current submission with scoped per-submission RT.
 * Safe to call outside SubmissionDataProvider — returns an empty, disabled query.
 */
export function useSubmissionReviewsQuery() {
  const ctx = useSubmissionDataContextMaybe();
  const submissionId = ctx?.submissionId ?? 0;
  const supabase = ctx?.supabase ?? getFallbackClient();
  const classRtc = ctx?.classRtc ?? null;

  return useSupabaseRealtimeQuery<"submission_reviews", SubmissionReview>({
    queryKey: ["submission", submissionId, "reviews"],
    table: "submission_reviews",
    queryFn: () => supabase.from("submission_reviews").select("*").eq("submission_id", submissionId),
    classRtc,
    supabase,
    scope: "scoped",
    enabled: !!ctx
  });
}
