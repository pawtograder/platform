"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type DatabaseTableTypes = Database["public"]["Tables"];

export type MutationType = "insert" | "update" | "delete";

// ---------------------------------------------------------------------------
// Mutation variable types — one per operation kind
// ---------------------------------------------------------------------------

export type InsertVariables<TTable extends keyof DatabaseTableTypes> = DatabaseTableTypes[TTable]["Insert"];

export type UpdateVariables<TTable extends keyof DatabaseTableTypes> = {
  id: number | string;
  values: Partial<DatabaseTableTypes[TTable]["Update"]>;
};

export type DeleteVariables = {
  id: number | string;
};

/**
 * Discriminated union so callers get the right variable type per mutation kind.
 */
export type MutationVariables<
  TTable extends keyof DatabaseTableTypes,
  TMutation extends MutationType
> = TMutation extends "insert"
  ? InsertVariables<TTable>
  : TMutation extends "update"
    ? UpdateVariables<TTable>
    : DeleteVariables;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type UseSupabaseRealtimeMutationConfig<
  TTable extends keyof DatabaseTableTypes,
  TMutation extends MutationType
> = {
  table: TTable;
  queryKey: readonly unknown[];
  mutationType: TMutation;
  supabase: SupabaseClient<Database>;
  /** Additional query keys to invalidate on success */
  invalidateKeys?: readonly (readonly unknown[])[];
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Generic mutation hook wrapping `useMutation` with optimistic updates.
 *
 * Handles insert / update / delete against a Supabase table and keeps the
 * TanStack Query cache in sync via optimistic updates with automatic rollback
 * on error.
 *
 * Usage:
 * ```ts
 * const insertTag = useSupabaseRealtimeMutation({
 *   table: 'tags',
 *   queryKey: ['course', courseId, 'tags'],
 *   mutationType: 'insert',
 *   supabase,
 * });
 *
 * insertTag.mutate({ name: 'bug', class_id: courseId });
 * ```
 */
export function useSupabaseRealtimeMutation<TTable extends keyof DatabaseTableTypes, TMutation extends MutationType>(
  config: UseSupabaseRealtimeMutationConfig<TTable, TMutation>
) {
  const { table, queryKey, mutationType, supabase, invalidateKeys } = config;
  const queryClient = useQueryClient();

  type Variables = MutationVariables<TTable, TMutation>;

  return useMutation<
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any, // TData — the Supabase response
    Error,
    Variables,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    { previous: any } // TContext for rollback
  >({
    mutationFn: async (variables: Variables) => {
      // Use an untyped reference to avoid "excessively deep" TS errors
      // from Supabase's deeply nested generic chains.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = supabase as any;

      if (mutationType === "insert") {
        const { data, error } = await db.from(table).insert(variables).select().single();
        if (error) throw error;
        return data;
      }

      if (mutationType === "update") {
        const { id, values } = variables as UpdateVariables<TTable>;
        const { data, error } = await db.from(table).update(values).eq("id", id).select().single();
        if (error) throw error;
        return data;
      }

      // delete
      const { id } = variables as DeleteVariables;
      const { error } = await db.from(table).delete().eq("id", id);
      if (error) throw error;
      return { id };
    },

    onMutate: async (variables: Variables) => {
      // Cancel outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const previous = queryClient.getQueryData<any[]>(queryKey);

      if (mutationType === "insert") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        queryClient.setQueryData<any[]>(queryKey, (old) => {
          const current = old ?? [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tempRow = { ...(variables as any), id: -Date.now() };
          return [...current, tempRow];
        });
      } else if (mutationType === "update") {
        const { id, values } = variables as UpdateVariables<TTable>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        queryClient.setQueryData<any[]>(queryKey, (old) => {
          if (!old) return old;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return old.map((item: any) => (item.id === id ? { ...item, ...values } : item));
        });
      } else {
        // delete
        const { id } = variables as DeleteVariables;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        queryClient.setQueryData<any[]>(queryKey, (old) => {
          if (!old) return old;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return old.filter((item: any) => item.id !== id);
        });
      }

      return { previous };
    },

    onError: (_error, _variables, context) => {
      // Rollback to previous cache state
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },

    onSettled: () => {
      // Always invalidate to get fresh server state
      queryClient.invalidateQueries({ queryKey });
      if (invalidateKeys) {
        for (const key of invalidateKeys) {
          queryClient.invalidateQueries({ queryKey: key });
        }
      }
    }
  });
}
