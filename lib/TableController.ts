import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { OfficeHoursBroadcastMessage } from "@/utils/supabase/DatabaseTypes";
import { UnstableGetResult as GetResult, PostgrestFilterBuilder } from "@supabase/postgrest-js";
import { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClassRealTimeController, ConnectionStatus } from "./ClassRealTimeController";
import { OfficeHoursRealTimeController } from "./OfficeHoursRealTimeController";

type DatabaseTableTypes = Database["public"]["Tables"];
type TablesThatHaveAnIDField = {
  [K in keyof DatabaseTableTypes]: DatabaseTableTypes[K]["Row"] extends { id: number | string } ? K : never;
}[keyof DatabaseTableTypes];

type ExtractIdType<T extends TablesThatHaveAnIDField> = DatabaseTableTypes[T]["Row"]["id"];

/**
 * Hook that returns all values from a TableController that match a predicate.
 * Automatically subscribes to real-time updates for each matching item.
 * Uses memoization to prevent unnecessary re-renders.
 *
 * @example
 * ```tsx
 * // Get all unread discussion threads for a user
 * const unreadThreads = useListTableControllerValues(
 *   controller.discussionThreadReadStatus,
 *   useCallback((data) => data.read_at === null && data.user_id === currentUserId, [currentUserId])
 * );
 *
 * // Get all assignments due in the next week
 * const upcomingAssignments = useListTableControllerValues(
 *   controller.assignments,
 *   useCallback((assignment) => {
 *     const dueDate = new Date(assignment.due_at);
 *     const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
 *     return dueDate <= nextWeek;
 *   }, [])
 * );
 * ```
 */
export function useListTableControllerValues<
  T extends TablesThatHaveAnIDField,
  Query extends string = "*",
  IDType = ExtractIdType<T>,
  ResultType = GetResult<
    Database["public"],
    Database["public"]["Tables"][T]["Row"],
    T,
    Database["public"]["Tables"][T]["Relationships"],
    Query
  >
>(
  controller: TableController<T, Query, IDType, ResultType>,
  predicate: (row: PossiblyTentativeResult<ResultType>) => boolean
) {
  const [matchingIds, setMatchingIds] = useState<Set<ExtractIdType<T>>>(new Set());
  const [values, setValues] = useState<Map<ExtractIdType<T>, PossiblyTentativeResult<ResultType>>>(new Map());

  // Keep track of individual ID subscriptions
  const subscriptionsRef = useRef<Map<ExtractIdType<T>, () => void>>(new Map());

  // Effect to subscribe to the list and detect matching items
  useEffect(() => {
    const { unsubscribe } = controller.list((data) => {
      // Find all rows that match the predicate
      const matchingRows = data.filter((row) => predicate(row as PossiblyTentativeResult<ResultType>));
      const newMatchingIds = new Set(matchingRows.map((row) => (row as { id: ExtractIdType<T> }).id));

      // Update matching IDs
      setMatchingIds(newMatchingIds);

      // Update values map with current matching rows
      setValues((prevValues) => {
        const newValues = new Map(prevValues);

        // Add/update all matching rows
        matchingRows.forEach((row) => {
          const id = (row as { id: ExtractIdType<T> }).id;
          newValues.set(id, row as PossiblyTentativeResult<ResultType>);
        });

        // Remove rows that no longer match
        for (const [id] of prevValues) {
          if (!newMatchingIds.has(id)) {
            newValues.delete(id);
          }
        }

        return newValues;
      });
    });

    return unsubscribe;
  }, [controller, predicate]);

  // Effect to manage individual ID subscriptions
  useEffect(() => {
    const subscriptions = subscriptionsRef.current;

    // Subscribe to new IDs
    for (const id of matchingIds) {
      if (!subscriptions.has(id)) {
        const { unsubscribe } = controller.getById(id as IDType, (data) => {
          if (data) {
            // Only update if the row still matches the predicate
            if (predicate(data)) {
              setValues((prevValues) => {
                const newValues = new Map(prevValues);
                newValues.set(id, data);
                return newValues;
              });
            } else {
              // Row no longer matches, remove it
              setValues((prevValues) => {
                const newValues = new Map(prevValues);
                newValues.delete(id);
                return newValues;
              });
              setMatchingIds((prevIds) => {
                const newIds = new Set(prevIds);
                newIds.delete(id);
                return newIds;
              });
            }
          } else {
            // Row was deleted, remove it
            setValues((prevValues) => {
              const newValues = new Map(prevValues);
              newValues.delete(id);
              return newValues;
            });
            setMatchingIds((prevIds) => {
              const newIds = new Set(prevIds);
              newIds.delete(id);
              return newIds;
            });
          }
        });

        subscriptions.set(id, unsubscribe);
      }
    }

    // Unsubscribe from IDs that are no longer matching
    for (const [id, unsubscribe] of subscriptions) {
      if (!matchingIds.has(id)) {
        unsubscribe();
        subscriptions.delete(id);
      }
    }

    // Cleanup on unmount
    return () => {
      for (const [, unsubscribe] of subscriptions) {
        unsubscribe();
      }
      subscriptions.clear();
    };
  }, [controller, matchingIds, predicate]);

  // Memoize the final result to avoid unnecessary re-renders
  const result = useMemo(() => {
    return Array.from(values.values());
  }, [values]);

  return result;
}

export function useFindTableControllerValue<
  T extends TablesThatHaveAnIDField,
  Query extends string = "*",
  IDType = ExtractIdType<T>,
  ResultType = GetResult<
    Database["public"],
    Database["public"]["Tables"][T]["Row"],
    T,
    Database["public"]["Tables"][T]["Relationships"],
    Query
  >
>(
  controller: TableController<T, Query, IDType, ResultType>,
  predicate: (row: PossiblyTentativeResult<ResultType>) => boolean
) {
  const [id, setID] = useState<ExtractIdType<T> | undefined>(undefined);
  const [value, setValue] = useState<PossiblyTentativeResult<ResultType> | undefined | null>(undefined);

  useEffect(() => {
    // Reset state when controller or predicate changes
    setID(undefined);
    setValue(undefined);

    let unsubscribe: (() => void) | undefined;
    let cleanedUp = false;

    function findValueAndSubscribe() {
      if (cleanedUp) return;

      const { data, unsubscribe: listUnsubscribe } = controller.list((data) => {
        if (cleanedUp) return;

        const row = data.find((row) => predicate(row as PossiblyTentativeResult<ResultType>));
        if (row && typeof row === "object" && row !== null && "id" in row) {
          setID((row as { id: ExtractIdType<T> }).id);
          setValue(row as PossiblyTentativeResult<ResultType>);
        } else {
          setValue(null);
        }
      });
      const foundItem = data.find((row) => predicate(row as PossiblyTentativeResult<ResultType>));
      if (foundItem) {
        setID((foundItem as unknown as { id: ExtractIdType<T> }).id);
        setValue(foundItem as PossiblyTentativeResult<ResultType>);
      } else {
        setValue(null);
      }
      unsubscribe = listUnsubscribe;
    }

    if (!controller.ready) {
      controller.readyPromise.then(() => {
        if (!cleanedUp) {
          findValueAndSubscribe();
        }
      });
    } else {
      findValueAndSubscribe();
    }

    return () => {
      cleanedUp = true;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [controller, predicate]);

  useEffect(() => {
    if (id) {
      const { unsubscribe } = controller.getById(id as IDType, (data) => {
        setValue(data);
      });
      return unsubscribe;
    }
  }, [controller, id]);

  return value;
}
export function useTableControllerValueById<
  T extends TablesThatHaveAnIDField,
  Query extends string = "*",
  IDType = ExtractIdType<T> | undefined | null,
  ResultType = GetResult<
    Database["public"],
    Database["public"]["Tables"][T]["Row"],
    T,
    Database["public"]["Tables"][T]["Relationships"],
    Query
  >
>(controller: TableController<T, Query, IDType, ResultType>, id: IDType | undefined | null) {
  const [value, setValue] = useState<PossiblyTentativeResult<ResultType> | undefined | null>(() => {
    if (id === undefined) {
      return undefined;
    }
    return controller.getById(id as IDType).data;
  });

  useEffect(() => {
    if (id === undefined) {
      return;
    }
    const { unsubscribe, data } = controller.getById(id as IDType, (data) => {
      setValue(data);
    });
    // Guards against race!
    setValue(data);
    return unsubscribe;
  }, [controller, id]);

  return value;
}
export function useTableControllerTableValues<
  T extends TablesThatHaveAnIDField,
  Query extends string = "*",
  IDType = ExtractIdType<T>,
  ResultType = GetResult<
    Database["public"],
    Database["public"]["Tables"][T]["Row"],
    T,
    Database["public"]["Tables"][T]["Relationships"],
    Query
  >
>(controller: TableController<T, Query, IDType, ResultType>): PossiblyTentativeResult<ResultType>[] {
  const [values, setValues] = useState<PossiblyTentativeResult<ResultType>[]>([]);
  useEffect(() => {
    const { unsubscribe, data } = controller.list((data) => {
      setValues(data.map((row) => row as PossiblyTentativeResult<ResultType>));
    });
    setValues(data.map((row) => row as PossiblyTentativeResult<ResultType>));
    return unsubscribe;
  }, [controller]);
  return values;
}

export type PossiblyTentativeResult<T> = T & {
  __db_pending?: boolean;
};

//TODO: One day we can make this a union type of all the possible tables (without optional fields, type property will refine the type)
export type BroadcastMessage =
  | {
      type: "table_change" | "channel_created" | "system";
      operation?: "INSERT" | "UPDATE" | "DELETE";
      table?: TablesThatHaveAnIDField;
      row_id?: number | string;
      data?: Record<string, unknown>;
      submission_id?: number;
      help_request_id?: number;
      help_queue_id?: number;
      class_id: number;
      student_profile_id?: number;
      target_audience?: "user" | "staff";
      timestamp: string;
    }
  | OfficeHoursBroadcastMessage;
export default class TableController<
  RelationName extends TablesThatHaveAnIDField,
  Query extends string = "*",
  IDType = ExtractIdType<RelationName>,
  ResultOne = GetResult<
    Database["public"],
    Database["public"]["Tables"][RelationName]["Row"],
    RelationName,
    Database["public"]["Tables"][RelationName]["Relationships"],
    Query
  >
> {
  private _rows: PossiblyTentativeResult<ResultOne>[] = [];
  private _client: SupabaseClient;
  private _query: PostgrestFilterBuilder<
    Database["public"],
    Database["public"]["Tables"][RelationName]["Row"],
    ResultOne[],
    RelationName,
    Database["public"]["Tables"][RelationName]["Relationships"]
  >;
  private _ready: boolean = false;
  private _readyPromise: Promise<void>;
  private _table: RelationName;
  private _temporaryIdCounter: number = -1;
  private _classRealTimeController: ClassRealTimeController | null = null;
  private _officeHoursRealTimeController: OfficeHoursRealTimeController | null = null;
  private _realtimeUnsubscribe: (() => void) | null = null;
  private _statusUnsubscribe: (() => void) | null = null;
  private _submissionId: number | null = null;
  private _lastConnectionStatus: ConnectionStatus["overall"] = "connecting";
  private _closed: boolean = false;
  /**
   * Optional select clause to use when fetching a single row (e.g., after realtime events).
   * This enables preserving joined columns for controllers initialized with joined selects.
   */
  private _selectForSingleRow: Query | undefined;
  private _isRefetching: boolean = false;
  private _refetchListeners: ((isRefetching: boolean) => void)[] = [];

  private _listDataListeners: ((
    data: ResultOne[],
    { entered, left }: { entered: ResultOne[]; left: ResultOne[] }
  ) => void)[] = [];
  private _itemDataListeners: Map<IDType, ((data: PossiblyTentativeResult<ResultOne> | undefined) => void)[]> =
    new Map();

  get table() {
    return this._table;
  }

  get ready() {
    return this._ready;
  }
  get readyPromise() {
    return this._readyPromise;
  }
  get isRefetching() {
    return this._isRefetching;
  }

  /**
   * Subscribe to refetch status changes
   * @param listener Callback that receives the current refetch status
   * @returns Unsubscribe function
   */
  subscribeToRefetchStatus(listener: (isRefetching: boolean) => void) {
    this._refetchListeners.push(listener);
    // Immediately call with current status
    listener(this._isRefetching);
    return () => {
      this._refetchListeners = this._refetchListeners.filter((l) => l !== listener);
    };
  }

  async _fetchRow(id: IDType): Promise<ResultOne | undefined> {
    const selectClause = (this._selectForSingleRow as string | undefined) ?? "*";
    const { data, error } = await this._client.from(this._table).select(selectClause).eq("id", id).single();
    if (error) {
      throw error;
    }
    return data as unknown as ResultOne | undefined;
  }

  /**
   * Fetch initial data with pagination
   */
  private async _fetchInitialData(): Promise<ResultOne[]> {
    const rows: ResultOne[] = [];
    let page = 0;
    const pageSize = 1000;
    let nRows: number | undefined;

    // Load initial data, do all of the pages.
    // If nRows is specified, only fetch up to nRows, otherwise fetch all pages until no more data
    while (!this._closed) {
      const rangeStart = page * pageSize;
      let rangeEnd = (page + 1) * pageSize - 1;
      if (typeof nRows === "number") {
        if (rangeStart >= nRows) break;
        rangeEnd = Math.min(rangeEnd, nRows - 1);
      }
      const { data, error } = await this._query.range(rangeStart, rangeEnd);
      if (this._closed) {
        return [];
      }
      if (error) {
        throw error;
      }
      if (!data || data.length === 0) {
        break;
      }
      rows.push(...(data as unknown as ResultOne[]));
      if (data.length < pageSize) {
        break;
      }
      page++;
    }

    return rows;
  }

  /**
   * Refetch all data and notify subscribers of changes
   */
  private async _refetchAllData(): Promise<void> {
    // Set refetch state to true and notify listeners
    this._isRefetching = true;
    this._refetchListeners.forEach((listener) => listener(true));

    try {
      const oldRows = [...this._rows];
      const newData = await this._fetchInitialData();

      // Convert new data to our internal format
      const newRows = newData.map((row) => ({
        ...row,
        __db_pending: false
      })) as PossiblyTentativeResult<ResultOne>[];

      // Update internal state
      this._rows = newRows;

      // Calculate changes for list listeners
      const oldIds = new Set(oldRows.map((r) => (r as ResultOne & { id: IDType }).id));
      const newIds = new Set(newRows.map((r) => (r as ResultOne & { id: IDType }).id));

      const entered = newRows.filter((r) => !oldIds.has((r as ResultOne & { id: IDType }).id)) as ResultOne[];
      const left = oldRows.filter((r) => !newIds.has((r as ResultOne & { id: IDType }).id)) as ResultOne[];

      // Notify list listeners
      this._listDataListeners.forEach((listener) => listener(this._rows, { entered, left }));

      // Notify item listeners for all items
      for (const row of newRows) {
        const id = (row as ResultOne & { id: IDType }).id;
        const listeners = this._itemDataListeners.get(id);
        if (listeners) {
          listeners.forEach((listener) => listener(row));
        }
      }

      // Notify item listeners for removed items
      for (const row of left) {
        const id = (row as ResultOne & { id: IDType }).id;
        const listeners = this._itemDataListeners.get(id);
        if (listeners) {
          listeners.forEach((listener) => listener(undefined));
        }
      }
    } catch (error) {
      console.error(`Failed to refetch data for table ${this._table}:`, error);
    } finally {
      // Set refetch state to false and notify listeners
      this._isRefetching = false;
      this._refetchListeners.forEach((listener) => listener(false));
    }
  }

  /**
   * Public method to refetch all data for this controller's query and notify subscribers.
   * Useful when entries may have been created after the initial fetch but before
   * realtime subscriptions were established by the consumer.
   */
  async refetchAll(): Promise<void> {
    if (this._closed) {
      throw new Error(
        `TableController for table '${this._table}' is closed. Cannot call refetchAll(). This indicates a stale reference is being used.`
      );
    }
    if (this._isRefetching) {
      return;
    }
    await this._refetchAllData();
  }

  /**
   * Handle connection status changes
   */
  private _handleConnectionStatusChange(status: ConnectionStatus): void {
    const wasDisconnected =
      this._lastConnectionStatus === "disconnected" ||
      this._lastConnectionStatus === "partial" ||
      this._lastConnectionStatus === "connecting";
    const isNowConnected = status.overall === "connected";

    if (wasDisconnected && isNowConnected && this._ready) {
      // We've reconnected after being disconnected, refetch all data
      this._refetchAllData();
    }

    this._lastConnectionStatus = status.overall;
  }

  constructor({
    query,
    client,
    table,
    classRealTimeController,
    selectForSingleRow,
    submissionId,
    officeHoursRealTimeController
  }: {
    query: PostgrestFilterBuilder<
      Database["public"],
      Database["public"]["Tables"][RelationName]["Row"],
      ResultOne[],
      RelationName,
      Database["public"]["Tables"][RelationName]["Relationships"]
    >;
    client: SupabaseClient<Database>;
    table: RelationName;
    classRealTimeController?: ClassRealTimeController;
    officeHoursRealTimeController?: OfficeHoursRealTimeController;
    /** Select clause to use for single-row refetches (preserves joins) */
    selectForSingleRow?: Query;
    submissionId?: number;
  }) {
    this._rows = [];
    this._client = client;
    this._query = query;
    this._table = table;
    this._classRealTimeController = classRealTimeController || null;
    this._officeHoursRealTimeController = officeHoursRealTimeController || null;
    this._submissionId = submissionId || null;
    this._selectForSingleRow = selectForSingleRow;

    this._readyPromise = new Promise(async (resolve, reject) => {
      try {
        const messageHandler = (message: BroadcastMessage) => {
          if (this._closed) return;
          // Filter by table name
          if (message.table !== table) {
            return;
          }
          // Handle different message types
          switch (message.operation) {
            case "INSERT":
              this._handleInsert(message);
              break;
            case "UPDATE":
              this._handleUpdate(message);
              break;
            case "DELETE":
              this._handleDelete(message);
              break;
          }
        };

        // Fetch initial data first, respecting cancellation
        if (this._closed) {
          resolve();
          return;
        }
        const initialData = await this._fetchInitialData();
        if (this._closed) {
          resolve();
          return;
        }
        this._rows = initialData.map((row) => ({
          ...row,
          __db_pending: false
        }));

        // Set up realtime subscription if controller is provided
        if (!this._closed && this._classRealTimeController) {
          if (this._submissionId) {
            this._realtimeUnsubscribe = this._classRealTimeController.subscribeToTableForSubmission(
              table,
              this._submissionId,
              messageHandler
            );
          } else {
            this._realtimeUnsubscribe = this._classRealTimeController.subscribeToTable(table, messageHandler);
          }

          // Subscribe to connection status changes for reconnection handling
          this._statusUnsubscribe = this._classRealTimeController.subscribeToStatus((status) => {
            if (this._closed) return;
            this._handleConnectionStatusChange(status);
          });

          // Get initial connection status
          this._lastConnectionStatus = this._classRealTimeController.getConnectionStatus().overall;
        }
        if (!this._closed && this._officeHoursRealTimeController) {
          this._realtimeUnsubscribe = this._officeHoursRealTimeController.subscribeToTable(table, messageHandler);
        }

        if (this._closed) {
          resolve();
          return;
        }

        this._ready = true;
        // Emit a change event
        this._listDataListeners.forEach((listener) => listener(this._rows, { entered: this._rows, left: [] }));
        this._itemDataListeners.forEach((listeners, id) => {
          const row = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
          if (row) {
            listeners.forEach((listener) => listener(row));
          }
          // Don't call listener(undefined) - let the hook keep its initial value if we don't have data yet
        });
        resolve();
      } catch (error) {
        if (!this._closed) {
          reject(error);
        } else {
          resolve();
        }
      }
    });
  }

  close() {
    this._closed = true;
    if (this._realtimeUnsubscribe) {
      this._realtimeUnsubscribe();
    }
    if (this._statusUnsubscribe) {
      this._statusUnsubscribe();
    }
    // Clear all listeners
    this._refetchListeners = [];
    this._listDataListeners = [];
    this._itemDataListeners.clear();
  }

  private _handleInsert(message: BroadcastMessage) {
    if (this._closed) return;
    if (message.data) {
      // Handle full data broadcasts
      const data = message.data as Record<string, unknown>;

      // Check for exact ID match first
      const existingRowById = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === data.id);
      if (existingRowById) {
        // If we have a custom select for single row (joins), refresh the full row to keep joins in sync
        if (this._selectForSingleRow && (this._selectForSingleRow as string) !== "*") {
          this._fetchRow(data.id as IDType).then((fullRow) => {
            if (fullRow) {
              this._updateRow(data.id as IDType, fullRow as ResultOne & { id: IDType }, false);
            }
          });
        }
        return;
      }

      // Check for pending tentative rows that might represent the same data
      // This prevents duplication when optimistic updates are followed by real-time broadcasts
      const pendingRow = this._rows.find((r) => {
        const row = r as PossiblyTentativeResult<ResultOne>;
        return row.__db_pending && this._isPotentialMatch(row, data);
      });

      if (pendingRow) {
        // Update the pending row with the real data instead of adding a duplicate
        const pendingRowWithId = pendingRow as ResultOne & { id: IDType };
        pendingRowWithId.id = data.id as IDType;
        // If we have a custom select (joins), refetch to get full joined row; otherwise use the payload
        if (this._selectForSingleRow && (this._selectForSingleRow as string) !== "*") {
          this._fetchRow(data.id as IDType).then((fullRow) => {
            if (fullRow) {
              this._updateRow(data.id as IDType, fullRow as ResultOne & { id: IDType }, false);
            } else {
              this._updateRow(
                data.id as IDType,
                {
                  ...(data as ResultOne),
                  id: data.id
                } as ResultOne & { id: IDType },
                false
              );
            }
          });
        } else {
          this._updateRow(
            data.id as IDType,
            {
              ...data,
              id: data.id
            } as ResultOne & { id: IDType },
            false
          );
        }
      } else {
        // Re-check to avoid duplicates if another concurrent event already added this row
        const isDuplicate = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === (data.id as IDType));
        // If we have a custom select (joins), refetch to get full joined row; otherwise use the payload
        if (this._selectForSingleRow && (this._selectForSingleRow as string) !== "*") {
          this._fetchRow(data.id as IDType).then((fullRow) => {
            // Re-check to avoid duplicates if another concurrent event already added this row
            if (isDuplicate) {
              return;
            }
            if (fullRow) {
              this._addRow({
                ...(fullRow as ResultOne),
                __db_pending: false
              } as PossiblyTentativeResult<ResultOne>);
            } else {
              this._addRow({
                ...(data as ResultOne),
                __db_pending: false
              } as PossiblyTentativeResult<ResultOne>);
            }
          });
        } else {
          // Re-check to avoid duplicates if another concurrent event already added this row
          if (isDuplicate) {
            return;
          }
          this._addRow({
            ...data,
            __db_pending: false
          } as PossiblyTentativeResult<ResultOne>);
        }
      }
    } else if (message.row_id) {
      // Handle ID-only broadcasts - fetch the data
      if (!this._rows.find((r) => (r as ResultOne & { id: IDType }).id === message.row_id)) {
        this._fetchRow(message.row_id as IDType).then((row) => {
          if (!row) {
            return;
          }
          // One last check to see if we already have it
          if (this._rows.find((r) => (r as ResultOne & { id: IDType }).id === message.row_id)) {
            return;
          }

          // Check for pending tentative rows that might represent the same data
          const pendingRow = this._rows.find((r) => {
            const rowData = r as PossiblyTentativeResult<ResultOne>;
            return rowData.__db_pending && this._isPotentialMatch(rowData, row);
          });

          if (pendingRow) {
            // Update the pending row with the real data instead of adding a duplicate
            const pendingRowWithId = pendingRow as ResultOne & { id: IDType };
            pendingRowWithId.id = message.row_id as IDType;

            this._updateRow(message.row_id as IDType, row as ResultOne & { id: IDType }, false);
          } else {
            // Re-check before add in case another event already inserted it
            if (!this._rows.find((r) => (r as ResultOne & { id: IDType }).id === (message.row_id as IDType))) {
              this._addRow({
                ...row,
                __db_pending: false
              });
            }
          }
        });
      }
    }
  }

  /**
   * Check if a pending tentative row potentially represents the same data as an incoming broadcast.
   * This helps prevent duplicates when optimistic updates are followed by real-time broadcasts.
   */
  private _isPotentialMatch(
    pendingRow: PossiblyTentativeResult<ResultOne>,
    incomingData: Record<string, unknown>
  ): boolean {
    // System fields that should be ignored in comparison
    const systemFields = new Set([
      "id",
      "created_at",
      "updated_at",
      "deleted_at",
      "edited_at",
      "edited_by",
      "__db_pending"
    ]);

    const pendingRowData = pendingRow as Record<string, unknown>;

    // First, check if this row has a negative (temporary) ID, which indicates it's likely an optimistic update
    const pendingId = pendingRowData.id;
    if (typeof pendingId === "number" && pendingId > 0) {
      // If pending row has a positive ID, it's already been updated, so don't match
      return false;
    }

    // Count how many non-system fields match between pending and incoming data
    let matchingFields = 0;
    let totalComparableFields = 0;

    for (const [key, value] of Object.entries(incomingData)) {
      if (systemFields.has(key)) {
        continue;
      }

      totalComparableFields++;

      // Handle null/undefined equivalence
      const pendingValue = pendingRowData[key];
      const incomingValue = value;

      // Consider null and undefined as equivalent
      if ((pendingValue == null && incomingValue == null) || pendingValue === incomingValue) {
        matchingFields++;
      }
      // Handle timestamp comparisons more loosely (within 500 milliseconds)
      else if (key.includes("_at") || key.includes("timestamp")) {
        if (this._isTimestampMatch(pendingValue, incomingValue)) {
          matchingFields++;
        }
      }
    }

    // Consider it a match if at least 90% of fields match and we have at least 3 comparable fields
    // This handles cases where there might be minor differences in computed fields
    const matchRatio = totalComparableFields > 0 ? matchingFields / totalComparableFields : 0;
    return totalComparableFields >= 3 && matchRatio >= 0.9;
  }

  /**
   * Helper to check if two timestamp values are close enough to be considered the same
   */
  private _isTimestampMatch(value1: unknown, value2: unknown): boolean {
    try {
      if (typeof value1 === "string" && typeof value2 === "string") {
        const date1 = new Date(value1);
        const date2 = new Date(value2);
        if (isNaN(date1.getTime()) || isNaN(date2.getTime())) {
          return false;
        }
        // Consider timestamps within 500 milliseconds as matching (handles slight timing differences)
        return Math.abs(date1.getTime() - date2.getTime()) <= 500;
      }
      return false;
    } catch {
      return false;
    }
  }

  private _handleUpdate(message: BroadcastMessage) {
    if (this._closed) return;
    if (message.data) {
      // Handle full data broadcasts
      const data = message.data as Record<string, unknown>;
      const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === data.id);
      const applyUpdate = (rowLike: Record<string, unknown>) => {
        if (existingRow) {
          this._updateRow(
            data.id as IDType,
            { ...(rowLike as ResultOne), id: data.id } as ResultOne & { id: IDType },
            false
          );
        } else {
          this._addRow({
            ...(rowLike as ResultOne),
            __db_pending: false
          } as PossiblyTentativeResult<ResultOne>);
        }
      };

      if (this._selectForSingleRow && (this._selectForSingleRow as string) !== "*") {
        this._fetchRow(data.id as IDType).then((fullRow) => {
          if (fullRow) {
            applyUpdate(fullRow as unknown as Record<string, unknown>);
          } else {
            applyUpdate(data);
          }
        });
      } else {
        applyUpdate(data);
      }
    } else if (message.row_id) {
      // Handle ID-only broadcasts - fetch the data
      this._fetchRow(message.row_id as IDType).then((row) => {
        if (!row) {
          return;
        }
        const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === message.row_id);
        if (existingRow) {
          this._updateRow(message.row_id as IDType, row as ResultOne & { id: IDType }, false);
        } else {
          this._addRow({
            ...row,
            __db_pending: false
          });
        }
      });
    }
  }

  private _handleDelete(message: BroadcastMessage) {
    if (this._closed) return;
    if (message.data) {
      const data = message.data as Record<string, unknown>;
      this._removeRow(data.id as IDType);
    } else if (message.row_id) {
      this._removeRow(message.row_id as IDType);
    }
  }

  private _nonExistantKeys: Set<IDType> = new Set();
  private async _maybeRefetchKey(id: IDType) {
    if (!this._ready) {
      return;
    }
    if (this._nonExistantKeys.has(id)) {
      return;
    }

    this._nonExistantKeys.add(id);

    const row = await this._fetchRow(id);

    if (row) {
      this._addRow({
        ...row,
        __db_pending: false
      });
      this._nonExistantKeys.delete(id);
    }
    return row;
  }

  async getByIdAsync(id: IDType) {
    if (this._closed) {
      throw new Error(
        `TableController for table '${this._table}' is closed. Cannot call getByIdAsync(${id}). This indicates a stale reference is being used.`
      );
    }
    if (id === 0) {
      throw new Error("0 is not a valid ID, ever.");
    }
    const data = this._rows.find(
      (row) => (row as ResultOne & { id: ExtractIdType<RelationName> }).id === id
    ) as PossiblyTentativeResult<ResultOne>;
    if (data) {
      return data;
    }
    return await this._maybeRefetchKey(id);
  }
  getById(id: IDType, listener?: (data: PossiblyTentativeResult<ResultOne> | undefined) => void) {
    if (this._closed) {
      throw new Error(
        `TableController for table '${this._table}' is closed. Cannot call getById(${id}). This indicates a stale reference is being used.`
      );
    }
    if (id === 0) {
      throw new Error("0 is not a valid ID, ever.");
    }
    if (id === undefined) {
      throw new Error("Undefined ID is not a valid ID, ever.");
    }

    // First try to find the data
    let data = this._rows.find(
      (row) => (row as ResultOne & { id: ExtractIdType<RelationName> }).id === id
    ) as PossiblyTentativeResult<ResultOne>;

    // If not found and we haven't tried refetching this key yet, try refetching
    if (!data && !this._nonExistantKeys.has(id)) {
      this._maybeRefetchKey(id);

      // Try to find it again immediately after triggering refetch
      // This handles the case where the data was already loaded but not in _rows due to timing issues
      data = this._rows.find(
        (row) => (row as ResultOne & { id: ExtractIdType<RelationName> }).id === id
      ) as PossiblyTentativeResult<ResultOne>;
    }

    if (!listener) {
      return {
        data,
        unsubscribe: () => {}
      };
    }
    this._itemDataListeners.set(id, [...(this._itemDataListeners.get(id) || []), listener]);
    return {
      data,
      unsubscribe: () => {
        const listeners = this._itemDataListeners.get(id);
        if (listeners) {
          this._itemDataListeners.set(
            id,
            listeners.filter((l) => l !== listener)
          );
        }
      }
    };
  }

  list(listener?: (data: ResultOne[], { entered, left }: { entered: ResultOne[]; left: ResultOne[] }) => void) {
    if (this._closed) {
      throw new Error(
        `TableController for table '${this._table}' is closed. Cannot call list(). This indicates a stale reference is being used.`
      );
    }
    if (!listener) {
      return {
        data: this._rows,
        unsubscribe: () => {}
      };
    }
    this._listDataListeners.push(listener);
    return {
      data: this._rows,
      unsubscribe: () => {
        this._listDataListeners = this._listDataListeners.filter((l) => l !== listener);
      }
    };
  }

  async invalidate(id: IDType) {
    if (this._closed) {
      throw new Error(
        `TableController for table '${this._table}' is closed. Cannot call invalidate(${id}). This indicates a stale reference is being used.`
      );
    }
    const selectClause = (this._selectForSingleRow as string | undefined) ?? "*";
    const { data, error } = await this._client.from(this._table).select(selectClause).eq("id", id).single();
    if (error) {
      throw error;
    }
    if (!data) {
      return;
    }
    const typedData = data as unknown as ResultOne;
    const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
    if (existingRow) {
      this._updateRow(id as IDType, typedData as ResultOne & { id: IDType }, false);
    } else {
      this._addRow({
        ...(typedData as ResultOne),
        __db_pending: false
      } as PossiblyTentativeResult<ResultOne>);
    }
  }

  private _addRow(row: PossiblyTentativeResult<ResultOne>) {
    // Enforce uniqueness by ID. If a row with the same ID already exists, treat this as an update.
    if ("id" in row) {
      const id = (row as { id: IDType }).id;
      const existingIndex = this._rows.findIndex((r) => (r as ResultOne & { id: IDType }).id === id);
      if (existingIndex !== -1) {
        this._updateRow(
          id,
          row as unknown as ResultOne & { id: IDType },
          !!(row as { __db_pending?: boolean }).__db_pending
        );
        return;
      }
    }

    this._rows = [...this._rows, row];

    this._listDataListeners.forEach((listener) => listener(this._rows, { entered: [row], left: [] }));
    if ("id" in row) {
      //Should always be true, fix up types later...
      const listeners = this._itemDataListeners.get(row.id as IDType);
      if (listeners) {
        listeners.forEach((listener) => listener(row));
      }
    }
  }

  private _updateRow(id: IDType, newRow: ResultOne & { id: IDType }, is_pending: boolean = false) {
    const index = this._rows.findIndex((r) => (r as ResultOne & { id: IDType }).id === id);
    if (index === -1) {
      throw new Error("Row not found");
    }
    const oldRow = this._rows[index];
    this._rows[index] = {
      ...this._rows[index],
      ...newRow,
      __db_pending: is_pending
    };

    const itemListeners = this._itemDataListeners.get(id as IDType);

    if (itemListeners) {
      itemListeners.forEach((listener) => listener(this._rows[index]));
    }

    // Create new array reference to ensure React detects the change
    const newRowsArray = [...this._rows];
    this._listDataListeners.forEach((listener) => listener(newRowsArray, { entered: [], left: [] }));

    if (typeof newRow === "object" && "deleted_at" in newRow) {
      if (newRow.deleted_at && (!("deleted_at" in oldRow) || oldRow.deleted_at === null)) {
        const newRowsArrayDeleted = [...this._rows];
        this._listDataListeners.forEach((listener) => listener(newRowsArrayDeleted, { entered: [], left: [] }));
      }
    }
  }

  private _removeRow(id: IDType) {
    const rowToRemove = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
    if (!rowToRemove) {
      return;
    }
    this._rows = this._rows.filter((r) => (r as ResultOne & { id: IDType }).id !== id);
    this._listDataListeners.forEach((listener) =>
      listener(this._rows, { entered: [], left: [rowToRemove as ResultOne] })
    );
    const listeners = this._itemDataListeners.get(id);
    if (listeners) {
      listeners.forEach((listener) => listener(undefined));
    }
  }

  async create(
    row: Omit<ResultOne, "id" | "created_at" | "updated_at" | "deleted_at" | "edited_at" | "edited_by">
  ): Promise<ResultOne> {
    if (this._closed) {
      throw new Error(
        `TableController for table '${this._table}' is closed. Cannot call create(). This indicates a stale reference is being used.`
      );
    }
    const newRow = {
      ...(row as ResultOne),
      created_at: new Date(),
      id: this._temporaryIdCounter--
    };
    const tentativeRow = {
      ...newRow,
      __db_pending: true
    };
    this._addRow(tentativeRow);
    const { data, error } = await this._client.from(this._table).insert(row).select("*").single();
    if (error) {
      this._rows = this._rows.filter((r) => r !== tentativeRow);
      this._removeRow(newRow.id as IDType);
      throw error;
    }

    // Check if the real-time broadcast has already updated this row
    const currentRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === data.id);
    if (currentRow && !(currentRow as PossiblyTentativeResult<ResultOne>).__db_pending) {
      // Row was already updated by real-time broadcast, just return the data
      return data;
    }

    // If the row hasn't been updated by real-time broadcast yet, update it manually
    // This handles cases where real-time might be slow or disabled
    const tentativeRowStillExists = this._rows.find((r) => r === tentativeRow);
    if (tentativeRowStillExists) {
      tentativeRow.id = data.id;
      this._updateRow(data.id, data, false);
    }

    return data;
  }

  async delete(id: ExtractIdType<RelationName>): Promise<void> {
    if (this._closed) {
      throw new Error(
        `TableController for table '${this._table}' is closed. Cannot call delete(${id}). This indicates a stale reference is being used.`
      );
    }
    const existingRow = this._rows.find((r) => (r as ResultOne & { id: ExtractIdType<RelationName> }).id === id);
    if (!existingRow) {
      throw new Error("Row not found");
    }
    if (existingRow.__db_pending) {
      throw new Error("Row is pending");
    }
    this._removeRow(id as IDType);
    const { error } = await this._client
      .from(this._table)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      this._addRow({ ...existingRow, __db_pending: false } as PossiblyTentativeResult<ResultOne>);
      throw error;
    }
    return;
  }
  async update(id: IDType, row: Partial<ResultOne>): Promise<ResultOne> {
    if (this._closed) {
      throw new Error(
        `TableController for table '${this._table}' is closed. Cannot call update(${id}). This indicates a stale reference is being used.`
      );
    }
    const oldRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
    if (!oldRow) {
      throw new Error("Row not found");
    }
    this._updateRow(id, { ...oldRow, ...row, id, __db_pending: true }, true);
    const { data, error } = await this._client.from(this._table).update(row).eq("id", id).select("*").single();
    if (error) {
      this._updateRow(id, oldRow as ResultOne & { id: IDType }, false);
      throw error;
    }
    this._updateRow(id, data, false);
    return data;
  }

  get rows() {
    return this._rows;
  }

  get rowCount() {
    return this._rows.length;
  }
}
