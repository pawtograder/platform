"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/utils/supabase/client";

export interface ErrorPinMatch {
  error_pin_id: number;
  discussion_thread_id: number;
  grader_result_test_id: number | null;
  thread_subject: string;
}

interface UseErrorPinMatchesReturn {
  matches: Map<number | null, ErrorPinMatch[]>;
  isLoading: boolean;
  error: Error | null;
}

/**
 * Hook to fetch error pin matches for a submission.
 * Calls the get_error_pin_matches_for_submission RPC which uses lazy caching.
 * 
 * @param submission_id - The submission ID to fetch matches for
 * @returns Object with matches (keyed by grader_result_test_id), loading state, and error
 */
export function useErrorPinMatches(submission_id: number | null | undefined): UseErrorPinMatchesReturn {
  const { data, isLoading, error } = useQuery({
    queryKey: ["error_pin_matches", submission_id],
    queryFn: async () => {
      if (!submission_id) return null;
      
      const supabase = createClient();
      const { data: result, error: rpcError } = await supabase.rpc("get_error_pin_matches_for_submission", {
        p_submission_id: submission_id
      });

      if (rpcError) throw rpcError;
      return result as ErrorPinMatch[] | null;
    },
    enabled: !!submission_id,
    staleTime: 5 * 60 * 1000, // 5 minutes - matches are cached in DB
  });

  // Group matches by grader_result_test_id for easy lookup
  const matches = new Map<number | null, ErrorPinMatch[]>();
  if (data) {
    for (const match of data) {
      const testId = match.grader_result_test_id;
      if (!matches.has(testId)) {
        matches.set(testId, []);
      }
      matches.get(testId)!.push(match);
    }
  }

  return {
    matches,
    isLoading,
    error: error as Error | null
  };
}
