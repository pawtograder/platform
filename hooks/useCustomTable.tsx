import { createClient } from "@/utils/supabase/client";
import { Database } from "@/utils/supabase/SupabaseTypes";
import {
  ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  TableOptions
} from "@tanstack/react-table";
import { useCallback, useEffect, useState } from "react";

export interface ServerFilter {
  field: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in";
  value: string | number | boolean | string[] | number[];
}

export interface ServerOrderBy {
  field: string;
  direction: "asc" | "desc";
}
export interface UseCustomTableProps<TData> {
  columns: ColumnDef<TData>[];
  resource: keyof Database["public"]["Tables"];
  serverFilters?: ServerFilter[];
  serverOrderBys?: ServerOrderBy[];
  select?: string;
  initialState?: Partial<TableOptions<TData>["initialState"]>;
}

/**
 * Custom table hook that combines TanStack Table with Supabase for optimal performance
 *
 * This hook provides:
 * - Server-side filtering via Supabase (efficient data fetching)
 * - Client-side filtering, sorting, and pagination via TanStack Table (responsive UX)
 * - Automatic data refetching when server filters change
 *
 * @example
 * ```tsx
 * // ✅ CORRECT: Memoized dependencies
 * const serverFilters = useMemo(() => [
 *   { field: "class_id", operator: "eq", value: courseId }
 * ], [courseId]);
 *
 * const columns = useMemo<ColumnDef<UserRole>[]>(() => [
 *   { id: "name", accessorKey: "name", header: "Name" },
 *   // ... other columns
 * ], []);
 *
 * const { getRowModel, getHeaderGroups, refetch } = useCustomTable({
 *   columns,
 *   resource: "user_roles",
 *   serverFilters,
 *   select: "*,profiles(*),users(*)"
 * });
 * ```
 *
 * @example
 * ```tsx
 * // ❌ WRONG: Non-memoized arrays cause infinite re-fetching
 * const { getRowModel } = useCustomTable({
 *   columns: [{ id: "name", accessorKey: "name" }], // ❌ New array every render
 *   serverFilters: [{ field: "id", operator: "eq", value: id }], // ❌ New array every render
 *   resource: "users"
 * });
 * ```
 *
 * ## Performance Considerations
 *
 * ### Server Filters
 * - Applied to Supabase query to limit data fetched from database
 * - Changes trigger new API calls, so keep filters stable with useMemo
 * - Best for constraints that significantly reduce dataset size
 *
 * ### Client Filters
 * - Applied to already-fetched data via TanStack Table
 * - No API calls, instant filtering for great UX
 * - Best for user-initiated filtering (search, dropdowns, etc.)
 *
 * @param props - Configuration object for the table
 * @returns TanStack Table instance plus data loading state and refetch function
 */
export function useCustomTable<TData>({
  columns,
  resource,
  serverFilters = [],
  serverOrderBys = [],
  select = "*",
  initialState = {}
}: UseCustomTableProps<TData>) {
  const [data, setData] = useState<TData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const supabase = createClient();
      let query = supabase.from(resource).select(select);

      // Apply server filters
      serverFilters.forEach((filter) => {
        switch (filter.operator) {
          case "eq":
            query = query.eq(filter.field, filter.value);
            break;
          case "neq":
            query = query.neq(filter.field, filter.value);
            break;
          case "gt":
            query = query.gt(filter.field, filter.value);
            break;
          case "gte":
            query = query.gte(filter.field, filter.value);
            break;
          case "lt":
            query = query.lt(filter.field, filter.value);
            break;
          case "lte":
            query = query.lte(filter.field, filter.value);
            break;
          case "like":
            query = query.like(filter.field, String(filter.value));
            break;
          case "ilike":
            query = query.ilike(filter.field, String(filter.value));
            break;
          case "in":
            query = query.in(filter.field, Array.isArray(filter.value) ? filter.value : [filter.value]);
            break;
        }
      });

      // Apply server order bys
      serverOrderBys.forEach((orderBy) => {
        query = query.order(orderBy.field, orderBy.direction === "asc" ? { ascending: true } : { ascending: false });
      });

      const { data: result, error: queryError } = await query.limit(1000);

      if (queryError) {
        throw queryError;
      }

      setData((result || []) as TData[]);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("An unknown error occurred"));
    } finally {
      setIsLoading(false);
    }
  }, [resource, serverFilters, select, serverOrderBys]);

  // Re-fetch data when server filters, resource, or select clause changes
  // The useCallback dependencies ensure fetchData is recreated only when necessary
  // This is why serverFilters should be memoized - to prevent unnecessary re-fetching
  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: false,
    manualFiltering: false,
    manualSorting: false,
    filterFromLeafRows: true,
    initialState: {
      pagination: {
        pageIndex: 0,
        pageSize: 50
      },
      ...initialState
    }
  });

  return {
    // Spread all TanStack Table methods and properties
    ...table,
    // Additional properties for data management
    /** The raw data array returned from Supabase */
    data,
    /** Loading state for the current fetch operation */
    isLoading,
    /** Any error that occurred during fetching */
    error,
    /** Function to manually trigger a data refetch */
    refetch: fetchData
  };
}
