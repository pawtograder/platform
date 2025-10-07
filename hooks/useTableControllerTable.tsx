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
import TableController, { PossiblyTentativeResult } from "@/lib/TableController";
import { Database } from "@/supabase/functions/_shared/SupabaseTypes";

type DatabaseTableTypes = Database["public"]["Tables"];
type TablesThatHaveAnIDField = {
  [K in keyof DatabaseTableTypes]: DatabaseTableTypes[K]["Row"] extends { id: number | string } ? K : never;
}[keyof DatabaseTableTypes];

export interface UseTableControllerTableProps<
  RelationName extends TablesThatHaveAnIDField,
  Query extends string = "*",
  IDType = DatabaseTableTypes[RelationName]["Row"]["id"],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TData = any
> {
  columns: ColumnDef<TData>[];
  tableController?: TableController<RelationName, Query, IDType, TData>;
  initialState?: Partial<TableOptions<TData>["initialState"]>;
  enableRowSelection?: boolean;
}

/**
 * Custom table hook that combines TanStack Table with TableController for real-time updates
 *
 * This hook provides:
 * - Real-time data updates via TableController subscriptions
 * - Client-side filtering, sorting, and pagination via TanStack Table
 * - Automatic state management when rows are added, updated, or removed
 * - Loading states and error handling
 *
 * @example
 * ```tsx
 * // ✅ CORRECT: Memoized dependencies
 * const columns = useMemo<ColumnDef<UserRole>[]>(() => [
 *   { id: "name", accessorKey: "name", header: "Name" },
 *   // ... other columns
 * ], []);
 *
 * const { getRowModel, getHeaderGroups, isLoading } = useTableControllerTable({
 *   columns,
 *   tableController: myTableController
 * });
 * ```
 *
 * ## Features
 *
 * ### Real-time Updates
 * - Automatically subscribes to TableController changes
 * - Updates table when rows are inserted, updated, or deleted
 * - Handles tentative states for optimistic updates
 *
 * ### Performance
 * - No manual refetching needed - updates happen automatically
 * - Efficient subscription management with automatic cleanup
 * - Client-side filtering and sorting for responsive UX
 *
 * @param props - Configuration object for the table
 * @returns TanStack Table instance plus data loading state and manual refetch function
 */
export function useTableControllerTable<
  RelationName extends TablesThatHaveAnIDField,
  Query extends string = "*",
  IDType = DatabaseTableTypes[RelationName]["Row"]["id"],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  TData = any
>({
  columns,
  tableController,
  initialState = {},
  enableRowSelection = false
}: UseTableControllerTableProps<RelationName, Query, IDType, TData>) {
  const [data, setData] = useState<PossiblyTentativeResult<TData>[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Subscribe to TableController list changes (for items entering/leaving)
  useEffect(() => {
    if (!tableController) return;
    let unsubscribe: (() => void) | undefined;

    const initializeData = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Wait for TableController to be ready
        await tableController.readyPromise;

        // Subscribe to list changes (when items are added or removed)
        const subscription = tableController.list((newData) => {
          setData(newData as PossiblyTentativeResult<TData>[]);
        });

        unsubscribe = subscription.unsubscribe;

        // Set initial data
        setData(subscription.data as PossiblyTentativeResult<TData>[]);
        setIsLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Failed to initialize TableController"));
        setIsLoading(false);
      }
    };

    initializeData();

    // Cleanup subscription on unmount or when tableController changes
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [tableController]);

  // Subscribe to item-level updates for each row in the table
  useEffect(() => {
    if (!tableController || data.length === 0) return;

    const unsubscribers: (() => void)[] = [];

    // Subscribe to each individual item for granular updates
    for (const row of data) {
      const rowWithId = row as TData & { id: IDType };
      if (rowWithId.id !== undefined && rowWithId.id !== null) {
        try {
          const { unsubscribe } = tableController.getById(rowWithId.id, (updatedRow) => {
            if (updatedRow) {
              // Update only this specific row in the data array
              setData((currentData) => {
                const index = currentData.findIndex(
                  (item) => (item as TData & { id: IDType }).id === rowWithId.id
                );
                if (index !== -1) {
                  const newData = [...currentData];
                  newData[index] = updatedRow as PossiblyTentativeResult<TData>;
                  return newData;
                }
                return currentData;
              });
            }
          });
          unsubscribers.push(unsubscribe);
        } catch {
          // Skip invalid IDs (e.g., temporary negative IDs from optimistic updates)
          // These will be handled when the real data arrives
        }
      }
    }

    // Cleanup all item subscriptions when data changes or component unmounts
    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, [tableController, data]);

  // Manual refetch function - triggers a full refetch from the database
  const refetch = useCallback(async () => {
    if (!tableController) return;
    try {
      setError(null);
      setIsLoading(true);
      
      // Call refetchAll to fetch the latest data from the database
      // The list subscription will automatically update our data state
      await tableController.refetchAll();
      
      setIsLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to refetch data"));
      setIsLoading(false);
    }
  }, [tableController]);

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
    enableRowSelection,
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
    /** The raw data array with tentative state indicators */
    data,
    /** Loading state for the current fetch operation */
    isLoading,
    /** Any error that occurred during initialization or updates */
    error,
    /** Function to manually trigger a data refetch */
    refetch,
    /** The underlying TableController instance for direct access if needed */
    tableController
  };
}
