"use client";

import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useState } from "react";
import type {
  AssignmentTestStatistics,
  CommonErrorsResponse,
  SubmissionsToFullMarksResponse,
  ErrorPinsForPatternResponse
} from "@/lib/test-insights/types";

// Type helper for RPC calls - these functions are defined in migration but not yet in generated types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRpc = any;

/**
 * Hook to fetch test statistics for an assignment
 */
export function useTestStatistics(assignment_id: number | null | undefined) {
  const [data, setData] = useState<AssignmentTestStatistics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchStatistics = useCallback(async () => {
    if (!assignment_id) {
      setData(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: result, error: rpcError } = await (supabase.rpc as AnyRpc)("get_test_statistics_for_assignment", {
        p_assignment_id: assignment_id
      });

      if (rpcError) throw rpcError;
      setData(result as AssignmentTestStatistics);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch test statistics"));
    } finally {
      setIsLoading(false);
    }
  }, [assignment_id]);

  useEffect(() => {
    fetchStatistics();
  }, [fetchStatistics]);

  return {
    data,
    isLoading,
    error,
    refetch: fetchStatistics
  };
}

/**
 * Hook to fetch common errors with optional filtering
 */
export function useCommonErrors(
  assignment_id: number | null | undefined,
  testName: string | null = null,
  testPart: string | null = null,
  minOccurrences: number = 2,
  limit: number = 50
) {
  const [data, setData] = useState<CommonErrorsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchErrors = useCallback(async () => {
    if (!assignment_id) {
      setData(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: result, error: rpcError } = await (supabase.rpc as AnyRpc)(
        "get_common_test_errors_for_assignment",
        {
          p_assignment_id: assignment_id,
          p_test_name: testName,
          p_test_part: testPart,
          p_min_occurrences: minOccurrences,
          p_limit: limit
        }
      );

      if (rpcError) throw rpcError;
      setData(result as CommonErrorsResponse);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch common errors"));
    } finally {
      setIsLoading(false);
    }
  }, [assignment_id, testName, testPart, minOccurrences, limit]);

  useEffect(() => {
    fetchErrors();
  }, [fetchErrors]);

  return {
    data,
    isLoading,
    error,
    refetch: fetchErrors
  };
}

/**
 * Hook to fetch submissions to full marks statistics
 */
export function useSubmissionsToFullMarks(assignment_id: number | null | undefined) {
  const [data, setData] = useState<SubmissionsToFullMarksResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    if (!assignment_id) {
      setData(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: result, error: rpcError } = await (supabase.rpc as AnyRpc)("get_submissions_to_full_marks", {
        p_assignment_id: assignment_id
      });

      if (rpcError) throw rpcError;
      setData(result as SubmissionsToFullMarksResponse);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch submissions to full marks data"));
    } finally {
      setIsLoading(false);
    }
  }, [assignment_id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    data,
    isLoading,
    error,
    refetch: fetchData
  };
}

/**
 * Hook to find error pins that match a specific error pattern
 */
export function useErrorPinsForPattern(
  assignment_id: number | null | undefined,
  testName: string | null,
  errorOutput: string | null
) {
  const [data, setData] = useState<ErrorPinsForPatternResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    if (!assignment_id || !testName || !errorOutput) {
      setData(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: result, error: rpcError } = await (supabase.rpc as AnyRpc)("get_error_pins_for_error_pattern", {
        p_assignment_id: assignment_id,
        p_test_name: testName,
        p_error_output: errorOutput
      });

      if (rpcError) throw rpcError;
      setData(result as ErrorPinsForPatternResponse);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch matching error pins"));
    } finally {
      setIsLoading(false);
    }
  }, [assignment_id, testName, errorOutput]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return {
    data,
    isLoading,
    error,
    refetch: fetchData
  };
}
