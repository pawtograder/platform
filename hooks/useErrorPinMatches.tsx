"use client";

import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useMemo, useState } from "react";

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
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch error pin matches for a submission.
 * Calls the get_error_pin_matches_for_submission RPC which uses lazy caching.
 *
 * @param submission_id - The submission ID to fetch matches for
 * @returns Object with matches (keyed by grader_result_test_id), loading state, error, and refetch function
 */
export function useErrorPinMatches(submission_id: number | null | undefined): UseErrorPinMatchesReturn {
  const [data, setData] = useState<ErrorPinMatch[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchMatches = useCallback(async () => {
    if (!submission_id) {
      setData(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: result, error: rpcError } = await supabase.rpc("get_error_pin_matches_for_submission", {
        p_submission_id: submission_id
      });

      if (rpcError) throw rpcError;
      setData(result as ErrorPinMatch[] | null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch error pin matches"));
    } finally {
      setIsLoading(false);
    }
  }, [submission_id]);

  useEffect(() => {
    fetchMatches();
  }, [fetchMatches]);

  // Group matches by grader_result_test_id for easy lookup
  const matches = useMemo(() => {
    const matchMap = new Map<number | null, ErrorPinMatch[]>();
    if (data) {
      for (const match of data) {
        const testId = match.grader_result_test_id;
        if (!matchMap.has(testId)) {
          matchMap.set(testId, []);
        }
        matchMap.get(testId)!.push(match);
      }
    }
    return matchMap;
  }, [data]);

  return {
    matches,
    isLoading,
    error,
    refetch: fetchMatches
  };
}
