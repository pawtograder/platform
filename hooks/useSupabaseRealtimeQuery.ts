"use client";

import { useQuery } from "@tanstack/react-query";
import { useRealtimeBridge } from "@/lib/cross-tab/useRealtimeBridge";
import { useLeaderContext } from "@/lib/cross-tab/LeaderProvider";
import type { PawtograderRealTimeController } from "@/lib/PawtograderRealTimeController";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type DatabaseTableTypes = Database["public"]["Tables"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UseSupabaseRealtimeQueryConfig<
  TTable extends keyof DatabaseTableTypes,
  TData = any,
  TSelected = TData[]
> = {
  /** Unique key for TanStack Query cache */
  queryKey: readonly unknown[];
  /** Supabase table name */
  table: TTable;
  /** Async function that returns the data (typically supabase.from(table).select(...)) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queryFn: () => PromiseLike<{ data: any; error: any }>;
  /** Realtime controller for receiving broadcast events */
  classRtc: PawtograderRealTimeController | null;
  /** Supabase client for refetching ID-only broadcasts */
  supabase: SupabaseClient<Database>;
  /** Filter function to accept/reject realtime rows */
  realtimeFilter?: (row: Record<string, unknown>) => boolean;
  /** Select clause for single-row refetch on RT events (e.g., '*, profiles(*)') */
  selectForRefetch?: string;
  /** TanStack Query select transform */
  select?: (data: TData[]) => TSelected;
  /** Debounce ms for RT event batching (default: 500) */
  debounceMs?: number;
  /** 'class' = leader-only RT, 'scoped' = all tabs */
  scope?: "class" | "scoped";
  /** Whether to enable the query */
  enabled?: boolean;
  /** Initial data from SSR */
  initialData?: TData[];
  /** Time in ms that data is considered fresh */
  staleTime?: number;
  /** Time in ms that unused data is kept in cache */
  gcTime?: number;
};

/**
 * Drop-in replacement for the TableController + useTableControllerTableValues pattern.
 *
 * Combines TanStack Query for data fetching/caching with the realtime bridge
 * for cross-tab synchronised Supabase Realtime updates.
 *
 * Usage:
 * ```ts
 * const { data, isLoading, error } = useSupabaseRealtimeQuery({
 *   queryKey: ['course', courseId, 'profiles'],
 *   table: 'profiles',
 *   queryFn: () => supabase.from('profiles').select('*').eq('class_id', courseId),
 *   classRtc,
 *   supabase,
 *   scope: 'class',
 * });
 * ```
 */
export function useSupabaseRealtimeQuery<
  TTable extends keyof DatabaseTableTypes,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TData = any,
  TSelected = TData[]
>(config: UseSupabaseRealtimeQueryConfig<TTable, TData, TSelected>) {
  const {
    queryKey,
    table,
    queryFn,
    classRtc,
    supabase,
    realtimeFilter,
    selectForRefetch,
    select,
    debounceMs,
    scope = "class",
    enabled = true,
    initialData,
    staleTime,
    gcTime
  } = config;

  const { leader, diffChannel } = useLeaderContext();

  // -------------------------------------------------------------------------
  // TanStack Query — fetch + cache
  // -------------------------------------------------------------------------

  const queryResult = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await queryFn();
      if (error) throw error;
      return data as TData[];
    },
    enabled,
    initialData,
    select,
    staleTime,
    gcTime
  });

  // -------------------------------------------------------------------------
  // Realtime bridge — leader/follower cross-tab sync
  // -------------------------------------------------------------------------

  useRealtimeBridge({
    table: table as string,
    queryKey,
    classRtc,
    supabase,
    realtimeFilter,
    selectForRefetch,
    debounceMs,
    scope,
    enabled,
    leader,
    diffChannel
  });

  return queryResult;
}
