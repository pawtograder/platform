"use client";

import { createClient } from "@/utils/supabase/client";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * Hook to fetch test statistics for an assignment.
 * Includes request-id guard to prevent race conditions from rapid parameter changes.
 */
export function useTestStatistics(assignment_id: number | null | undefined) {
  const [data, setData] = useState<AssignmentTestStatistics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetchStatistics = useCallback(async () => {
    if (!assignment_id || !Number.isFinite(assignment_id)) {
      setData(null);
      return;
    }

    const currentRequestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: result, error: rpcError } = await (supabase.rpc as AnyRpc)("get_test_statistics_for_assignment", {
        p_assignment_id: assignment_id
      });

      // Only update state if this is still the latest request
      if (currentRequestId !== requestIdRef.current) return;

      if (rpcError) throw rpcError;
      setData(result as AssignmentTestStatistics);
    } catch (err) {
      if (currentRequestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err : new Error("Failed to fetch test statistics"));
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setIsLoading(false);
      }
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
 * Hook to fetch common errors with optional filtering.
 * Includes request-id guard to prevent race conditions from rapid parameter changes.
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
  const requestIdRef = useRef(0);

  const fetchErrors = useCallback(async () => {
    if (!assignment_id || !Number.isFinite(assignment_id)) {
      setData(null);
      return;
    }

    const currentRequestId = ++requestIdRef.current;
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

      if (currentRequestId !== requestIdRef.current) return;

      if (rpcError) throw rpcError;
      setData(result as CommonErrorsResponse);
    } catch (err) {
      if (currentRequestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err : new Error("Failed to fetch common errors"));
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setIsLoading(false);
      }
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
 * Hook to fetch submissions to full marks statistics.
 * Includes request-id guard to prevent race conditions from rapid parameter changes.
 */
export function useSubmissionsToFullMarks(assignment_id: number | null | undefined) {
  const [data, setData] = useState<SubmissionsToFullMarksResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    if (!assignment_id || !Number.isFinite(assignment_id)) {
      setData(null);
      return;
    }

    const currentRequestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: result, error: rpcError } = await (supabase.rpc as AnyRpc)("get_submissions_to_full_marks", {
        p_assignment_id: assignment_id
      });

      if (currentRequestId !== requestIdRef.current) return;

      if (rpcError) throw rpcError;
      setData(result as SubmissionsToFullMarksResponse);
    } catch (err) {
      if (currentRequestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err : new Error("Failed to fetch submissions to full marks data"));
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setIsLoading(false);
      }
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
 * Hook to find error pins that match a specific error pattern.
 * Includes request-id guard to prevent race conditions from rapid parameter changes.
 * Note: If errorOutput is empty, it will still attempt to find pins based on test_name.
 */
export function useErrorPinsForPattern(
  assignment_id: number | null | undefined,
  testName: string | null,
  errorOutput: string | null
) {
  const [data, setData] = useState<ErrorPinsForPatternResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  const fetchData = useCallback(async () => {
    // Require assignment_id and testName, but allow empty errorOutput (will match by test_name)
    if (!assignment_id || !Number.isFinite(assignment_id) || !testName) {
      setData(null);
      return;
    }

    const currentRequestId = ++requestIdRef.current;
    setIsLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: result, error: rpcError } = await (supabase.rpc as AnyRpc)("get_error_pins_for_error_pattern", {
        p_assignment_id: assignment_id,
        p_test_name: testName,
        p_error_output: errorOutput || "" // Use empty string if null
      });

      if (currentRequestId !== requestIdRef.current) return;

      if (rpcError) throw rpcError;
      setData(result as ErrorPinsForPatternResponse);
    } catch (err) {
      if (currentRequestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err : new Error("Failed to fetch matching error pins"));
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setIsLoading(false);
      }
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
