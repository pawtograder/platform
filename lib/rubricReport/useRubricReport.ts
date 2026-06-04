"use client";

import { createClient } from "@/utils/supabase/client";
import type { Json } from "@/utils/supabase/SupabaseTypes";
import { useCallback, useEffect, useState } from "react";
import { validateRubricFilter, type RubricFilter } from "./filterSchema";

export type RubricCheckStat = {
  rubric_check_id: number;
  applied_count: number;
  options: { option_index: number; count: number }[];
};

export type RubricReportData = {
  cohort_total: number;
  checks: RubricCheckStat[];
};

export type UseRubricReportResult = {
  data: RubricReportData | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
};

/**
 * Fetch rubric-check application statistics for an assignment, optionally scoped by a
 * filter AST. The filter is validated client-side before sending (the RPC re-validates
 * server-side). Pass a stable `filter` reference (e.g. from state) to avoid refetch loops.
 */
export function useRubricReport(
  assignmentId: number | undefined,
  filter: RubricFilter | null,
  reviewRound: string = "grading-review"
): UseRubricReportResult {
  const [data, setData] = useState<RubricReportData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    if (!assignmentId) return;

    let validated: RubricFilter | null = null;
    if (filter !== null) {
      const result = validateRubricFilter(filter);
      if (!result.ok) {
        setError(result.error);
        setData(null);
        return;
      }
      validated = result.value;
    }

    setIsLoading(true);
    setError(null);
    const supabase = createClient();
    const { data: result, error: rpcError } = await supabase.rpc("get_rubric_check_application_stats", {
      p_assignment_id: assignmentId,
      p_filter: validated === null ? undefined : (validated as unknown as Json),
      p_review_round: reviewRound
    });

    if (rpcError) {
      setError(rpcError.message);
      setData(null);
    } else {
      setData(result as unknown as RubricReportData);
    }
    setIsLoading(false);
  }, [assignmentId, filter, reviewRound]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  return { data, isLoading, error, refetch: fetchStats };
}

/**
 * Fetch rubric stats once per section/lab value for the section-comparison view.
 * `sections` is a list of `{ key, filter }` where filter is a section/lab leaf predicate.
 * Returns a map keyed by `key`. Pass a stable `sections` reference.
 */
export function useRubricReportBySection(
  assignmentId: number | undefined,
  sections: { key: string; filter: RubricFilter }[],
  reviewRound: string = "grading-review"
): { byKey: Record<string, RubricReportData>; isLoading: boolean; error: string | null } {
  const [byKey, setByKey] = useState<Record<string, RubricReportData>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Identity-stable dependency: the sections only matter by their keys + filters.
  const sectionsKey = JSON.stringify(sections);

  useEffect(() => {
    if (!assignmentId || sections.length === 0) {
      setByKey({});
      return;
    }
    let cancelled = false;
    const run = async () => {
      setIsLoading(true);
      setError(null);
      const supabase = createClient();
      try {
        const entries = await Promise.all(
          sections.map(async ({ key, filter }) => {
            const { data, error: rpcError } = await supabase.rpc("get_rubric_check_application_stats", {
              p_assignment_id: assignmentId,
              p_filter: filter as unknown as Json,
              p_review_round: reviewRound
            });
            if (rpcError) throw new Error(rpcError.message);
            return [key, data as unknown as RubricReportData] as const;
          })
        );
        if (!cancelled) setByKey(Object.fromEntries(entries));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load section comparison");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignmentId, sectionsKey, reviewRound]);

  return { byKey, isLoading, error };
}
