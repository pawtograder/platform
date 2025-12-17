import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { OfficeHoursBroadcastMessage } from "@/utils/supabase/DatabaseTypes";
import { UnstableGetResult as GetResult, PostgrestFilterBuilder } from "@supabase/postgrest-js";
import { SupabaseClient } from "@supabase/supabase-js";
import { useEffect, useMemo, useRef, useState } from "react";
import { ClassRealTimeController } from "./ClassRealTimeController";
import { PawtograderRealTimeController, ConnectionStatus, ChannelStatus } from "./PawtograderRealTimeController";
import * as Sentry from "@sentry/nextjs";

type DatabaseTableTypes = Database["public"]["Tables"];
export type TablesThatHaveAnIDField = {
  [K in keyof DatabaseTableTypes]: DatabaseTableTypes[K]["Row"] extends { id: number | string } ? K : never;
}[keyof DatabaseTableTypes];

type ExtractIdType<T extends TablesThatHaveAnIDField> = DatabaseTableTypes[T]["Row"]["id"];

/**
 * Channel types that broadcast table changes.
 * Each channel type corresponds to a realtime broadcast channel pattern in the database:
 * - staff: class:$class_id:staff (instructors/graders for a class)
 * - user: class:$class_id:user:$profile_id (individual user in a class)
 * - students: class:$class_id:students (all students in a class)
 * - submission_graders: submission:$submission_id:graders (graders for a specific submission)
 * - submission_user: submission:$submission_id:profile_id:$profile_id (student for a specific submission)
 * - help_queue: help_queue:$help_queue_id (specific help queue)
 * - help_request: help_request:$help_request_id (specific help request)
 * - discussion_thread_root: discussion_thread:$root_id (specific discussion thread root)
 */
type ChannelType =
  | "staff"
  | "user"
  | "students"
  | "submission_graders"
  | "submission_user"
  | "help_queue"
  | "help_request"
  | "help_request_staff"
  | "help_queues"
  | "class_staff"
  | "discussion_thread_root";

/**
 * Tables that have an updated_at column and support incremental refetching.
 * Tables in this set can use the updated_at watermark optimization for efficient reconnection refetches.
 * Tables NOT in this set will skip refetch on reconnection unless enableAutoRefetch flag is explicitly set.
 */
const TABLES_WITH_UPDATED_AT = new Set<TablesThatHaveAnIDField>([
  "notifications",
  "discussion_topics",
  "discussion_thread_likes",
  "assignments",
  "assignment_due_date_exceptions",
  "discussion_thread_read_status",
  "discussion_thread_watchers",
  "discussion_threads",
  "gradebook_column_students",
  "gradebook_columns",
  "help_queue_assignments",
  "help_queues",
  "help_request_feedback",
  "help_request_file_references",
  "help_request_message_read_receipts",
  "help_request_messages",
  "help_request_moderation",
  "help_request_students",
  "help_request_templates",
  "help_requests",
  "lab_section_meetings",
  "lab_sections",
  "notification_preferences",
  "profiles",
  "repositories",
  "review_assignment_rubric_parts",
  "review_assignments",
  "student_deadline_extensions",
  "student_help_activity",
  "student_karma_notes",
  "submission_artifact_comments",
  "submission_comments",
  "submission_file_comments",
  "submission_regrade_request_comments",
  "submission_regrade_requests",
  "submission_reviews",
  "tags",
  "user_roles",
  "workflow_runs"
]);

/**
 * Map of tables to the channel types that broadcast their changes.
 * This allows TableController to only refetch when relevant channels reconnect,
 * preventing unnecessary refetches when unrelated channels (e.g., submission channels)
 * reconnect while viewing data from other tables (e.g., user_roles).
 *
 * Based on the database trigger functions in schema.sql:
 * - broadcast_course_table_change_unified: staff/students channels
 * - broadcast_submission_data_change: submission_graders/submission_user channels
 * - broadcast_help_request_data_change: help_request channel
 * - broadcast_help_queue_data_change: help_queue channel
 * - etc.
 *
 * Tables with empty arrays ([]) have NO realtime broadcasts - they are relatively static
 * and must be explicitly fetched. These should NOT refetch on reconnection since no
 * broadcasts were missed during disconnection. This data architecture should be improved in the future.
 */
const TABLE_TO_CHANNEL_MAP: Partial<Record<TablesThatHaveAnIDField, ChannelType[]>> = {
  // Static tables with no realtime broadcasts - future work might add that!
  submissions: [],
  assignments: [],
  assignment_groups: [],
  assignment_groups_members: [],
  classes: [],
  notifications: [], // Only triggers email queue, no realtime broadcasts
  // Tables broadcast via class:$class_id:staff channel
  assignment_due_date_exceptions: ["staff"],
  lab_section_leaders: ["staff"],
  lab_section_meetings: ["staff", "students"],
  lab_sections: ["staff", "students"],
  student_deadline_extensions: ["staff"],
  tags: ["staff"],
  user_roles: ["staff"],
  discussion_threads: ["staff", "students", "discussion_thread_root"],
  discussion_topics: ["staff", "students"],
  gradebook_columns: ["staff", "students"],
  gradebook_column_students: ["staff", "user"], // Also to individual users when not private
  help_queue_assignments: ["help_queue"],
  help_queues: ["help_queue"],
  help_request_moderation: ["help_request"],
  help_request_templates: ["help_request"],
  student_karma_notes: ["help_request"],
  help_requests: ["staff", "help_queue", "help_request"],
  submission_regrade_requests: ["staff", "user"],
  review_assignments: ["staff", "user"],
  review_assignment_rubric_parts: ["staff", "user"],
  profiles: ["staff", "students"],

  // Tables broadcast only to individual users
  discussion_thread_read_status: ["user"],
  discussion_thread_watchers: ["user"],
  discussion_thread_likes: ["user"],

  // Tables broadcast via submission-specific channels
  submission_artifact_comments: ["submission_graders", "submission_user"],
  submission_comments: ["submission_graders", "submission_user"],
  submission_file_comments: ["submission_graders", "submission_user"],
  submission_reviews: ["submission_graders", "submission_user"],
  submission_regrade_request_comments: ["submission_graders", "submission_user"],

  // Help request related tables
  help_request_feedback: ["help_request"],
  help_request_file_references: ["help_request"],
  help_request_message_read_receipts: ["help_request"],
  help_request_messages: ["help_request"],
  help_request_students: ["help_request"],
  student_help_activity: ["help_request"],

  // Discord integration tables (staff-only, broadcast on staff channel)
  discord_channels: ["staff"],
  discord_messages: ["staff"],

  // Live polls related tables
  live_polls: ["staff", "students"], // Poll status broadcasts to all
  live_poll_responses: ["staff"], // Response data only to staff

  // Survey related tables
  surveys: ["staff"], // Survey metadata (staff-only management)
  survey_responses: ["staff"], // Response data only to staff
  survey_assignments: ["staff"] // Assignment data only to staff
};

/**
 * Type-safe filter for real-time event filtering.
 * Supports basic equality filters that match PostgrestFilterBuilder patterns.
 */
export type RealtimeFilter<T extends TablesThatHaveAnIDField> = {
  [K in keyof DatabaseTableTypes[T]["Row"]]?: DatabaseTableTypes[T]["Row"][K] | DatabaseTableTypes[T]["Row"][K][];
};

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
  controller: TableController<T, Query, IDType, ResultType> | undefined,
  predicate: (row: PossiblyTentativeResult<ResultType>) => boolean
) {
  const [matchingIds, setMatchingIds] = useState<Set<ExtractIdType<T>>>(() => {
    const ret = new Set<ExtractIdType<T>>();
    for (const row of controller?.list().data ?? []) {
      if (predicate(row as PossiblyTentativeResult<ResultType>)) {
        ret.add((row as unknown as { id: ExtractIdType<T> }).id);
      }
    }
    return ret;
  });
  const [values, setValues] = useState<Map<ExtractIdType<T>, PossiblyTentativeResult<ResultType>>>(() => {
    const ret = new Map<ExtractIdType<T>, PossiblyTentativeResult<ResultType>>();
    for (const row of controller?.list().data ?? []) {
      if (predicate(row as PossiblyTentativeResult<ResultType>)) {
        ret.set((row as unknown as { id: ExtractIdType<T> }).id, row as PossiblyTentativeResult<ResultType>);
      }
    }
    return ret;
  });

  // Keep track of individual ID subscriptions
  const subscriptionsRef = useRef<Map<ExtractIdType<T>, () => void>>(new Map());

  // Effect to subscribe to the list and detect matching items
  useEffect(() => {
    if (!controller) return;
    const handleDataUpdate = (data: ResultType[]) => {
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
    };

    const { unsubscribe, data } = controller.list(handleDataUpdate);

    // Handle initial data
    handleDataUpdate(data);

    return unsubscribe;
  }, [controller, predicate]);

  // Effect to manage individual ID subscriptions
  useEffect(() => {
    if (!controller) return;
    const subscriptions = subscriptionsRef.current;

    // Subscribe to new IDs
    for (const id of matchingIds) {
      if (!subscriptions.has(id)) {
        const { unsubscribe } = controller.getById(id as IDType, (data) => {
          if (data) {
            // Only update if the row still matches the predicate
            if (predicate(data)) {
              setValues((prevValues) => {
                // Don't create new Map if data hasn't changed (prevents unnecessary re-renders)
                const existing = prevValues?.get(id);
                if (existing === data) {
                  return prevValues;
                }
                const newValues = new Map(prevValues || []);
                newValues.set(id, data);
                return newValues;
              });
            } else {
              // Row no longer matches, remove it
              setValues((prevValues) => {
                if (!prevValues) return prevValues;
                const newValues = new Map(prevValues);
                newValues.delete(id);
                return newValues;
              });
              setMatchingIds((prevIds) => {
                if (!prevIds) return prevIds;
                const newIds = new Set(prevIds);
                newIds.delete(id);
                return newIds;
              });
            }
          } else {
            // Row was deleted, remove it
            setValues((prevValues) => {
              if (!prevValues) return prevValues;
              const newValues = new Map(prevValues);
              newValues.delete(id);
              return newValues;
            });
            setMatchingIds((prevIds) => {
              if (!prevIds) return prevIds;
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
    if (id === undefined || id === null || id === "") {
      return undefined;
    }
    return controller.getById(id as IDType).data;
  });

  useEffect(() => {
    if (id === undefined || id === null || id === "") {
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
export function useIsTableControllerReady<T extends TablesThatHaveAnIDField>(controller?: TableController<T>): boolean {
  const [ready, setReady] = useState(controller?.ready ?? false);
  useEffect(() => {
    if (!controller) {
      setReady(false);
      return;
    }
    let cleanedUp = false;
    // Reset state when controller changes
    setReady(controller.ready);

    controller.readyPromise
      .then(() => {
        if (!cleanedUp) {
          setReady(true);
        }
      })
      .catch((err) => {
        if (!cleanedUp) {
          setReady(false);
          // Optionally log the error
          Sentry.captureException(err);
        }
      });

    return () => {
      cleanedUp = true;
    };
  }, [controller]);
  return ready;
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
>(controller?: TableController<T, Query, IDType, ResultType>): PossiblyTentativeResult<ResultType>[] {
  const [values, setValues] = useState<PossiblyTentativeResult<ResultType>[]>(() => {
    if (!controller) return [];
    return controller.list().data.map((row) => row as PossiblyTentativeResult<ResultType>);
  });
  useEffect(() => {
    if (!controller) return;
    const { unsubscribe, data } = controller.list((data) => {
      // Update for any list change (membership or item updates)
      setValues(data.map((row) => row as PossiblyTentativeResult<ResultType>));
    });

    // Set initial data (all items are considered "entered" on first load)
    setValues(data.map((row) => row as PossiblyTentativeResult<ResultType>));
    return unsubscribe;
  }, [controller]);
  return values;
}

export type PossiblyTentativeResult<T> = T & {
  __db_pending?: boolean;
};

//TODO: One day we can make this a union type of all the possible tables (without optional fields, type property will refine the type)
export type GradebookRowRecalcStateBroadcastMessage = {
  type: "gradebook_row_recalc_state";
  operation: "INSERT" | "UPDATE" | "DELETE";
  table: "gradebook_row_recalc_state";
  class_id: number;
  row_id: null;
  data: null;
  timestamp: string;
  affected_count: number;
  affected_rows: Array<{
    student_id: string;
    dirty: boolean;
    is_recalculating: boolean;
  }>; // Array of affected rows with their state (only private rows included)
  requires_refetch: false; // Always false since we include the data
};

export type BroadcastMessage =
  | {
      type: "table_change" | "channel_created" | "system" | "staff_data_change";
      operation?: "INSERT" | "UPDATE" | "DELETE" | "BULK_UPDATE";
      table?: TablesThatHaveAnIDField | "gradebook_row_recalc_state"; // Include gradebook_row_recalc_state which doesn't have an id field
      row_id?: number | string;
      row_ids?: (number | string)[]; // Array of IDs for bulk operations
      data?: Record<string, unknown>;
      submission_id?: number;
      help_request_id?: number;
      help_queue_id?: number;
      class_id: number;
      student_profile_id?: number;
      target_audience?: "user" | "staff";
      timestamp: string;
      affected_count?: number; // Number of rows affected in bulk operation
      requires_refetch?: boolean; // If true, trigger full refetch instead of refetching by IDs
    }
  | GradebookRowRecalcStateBroadcastMessage
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
  // Static bookkeeping: track number of active controllers by table type
  private static _controllerCounts: Map<string, number> = new Map();

  /**
   * Get the current count of active TableControllers for each table type.
   * Useful for debugging memory leaks.
   */
  static getControllerCounts(): Record<string, number> {
    return Object.fromEntries(TableController._controllerCounts);
  }

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
  private _additionalRealTimeControllers: PawtograderRealTimeController[] = [];
  private _classRealtimeUnsubscribe: (() => void) | null = null;
  private _additionalRealtimeUnsubscribes: (() => void)[] = [];
  private _classStatusUnsubscribe: (() => void) | null = null;
  private _additionalStatusUnsubscribes: (() => void)[] = [];
  private _submissionId: number | null = null;
  private _lastChannelStates: Map<string, string> = new Map(); // Track individual channel states
  private _channelsCompletedInitialConnection: Set<string> = new Set(); // Track which channels have completed their first connection
  private _connectionStatusDebounceTimer: NodeJS.Timeout | null = null;
  private _lastFetchTimestamp: number = 0;
  private _closed: boolean = false;
  private _realtimeFilter: RealtimeFilter<RelationName> | null = null;
  /**
   * Optional select clause to use when fetching a single row (e.g., after realtime events).
   * This enables preserving joined columns for controllers initialized with joined selects.
   */
  private _selectForSingleRow: Query | undefined;
  private _isRefetching: boolean = false;
  private _refetchListeners: ((isRefetching: boolean) => void)[] = [];
  private _debounceInterval: number;
  private _listDataListeners: ((
    data: ResultOne[],
    { entered, left }: { entered: ResultOne[]; left: ResultOne[] }
  ) => void)[] = [];
  private _itemDataListeners: Map<IDType, ((data: PossiblyTentativeResult<ResultOne> | undefined) => void)[]> =
    new Map();
  // Batching state for debounced operations - single queue to maintain order
  private _pendingOperations: BroadcastMessage[] = [];
  private _debounceTimeout: NodeJS.Timeout | null = null;
  private _isProcessingBatch: boolean = false;
  /** Tracks the maximum updated_at timestamp (ms) of rows currently loaded. Used for incremental refetches. */
  private _maxUpdatedAtMs: number | null = null;
  /**
   * Controls whether this table should auto-refetch on reconnection.
   * If undefined (default), auto-refetch is enabled only if table has updated_at column.
   * If true, always refetch on reconnection.
   * If false, never refetch on reconnection.
   */
  private _enableAutoRefetch: boolean | undefined;

  private _autoFetchMissingRows: boolean = true;
  /** Debug ID for tracking controller instances in logs */
  readonly _debugID: string = Math.random().toString(36).substring(2, 15);

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

  private async waitForRefetchToComplete(): Promise<void> {
    await this.readyPromise;
    if (this._isRefetching) {
      return new Promise((resolve) => {
        this._refetchListeners.push(() => resolve());
      });
    }
    return Promise.resolve();
  }

  /** Extract updated_at from a row-like object as epoch ms; returns null if not present/parsable */
  private _extractUpdatedAtMs(rowLike: unknown): number | null {
    try {
      if (!rowLike || typeof rowLike !== "object") return null;
      const value = (rowLike as Record<string, unknown>)["updated_at"];
      if (!value) return null;
      if (typeof value === "string") {
        const t = new Date(value).getTime();
        return isNaN(t) ? null : t;
      }
      if (value instanceof Date) {
        const t = (value as Date).getTime();
        return isNaN(t) ? null : t;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Update max updated_at marker from a row-like object */
  private _bumpMaxUpdatedAtFrom(rowLike: unknown): void {
    const ts = this._extractUpdatedAtMs(rowLike);
    if (ts != null) {
      this._maxUpdatedAtMs = this._maxUpdatedAtMs == null ? ts + 100 : Math.max(this._maxUpdatedAtMs, ts + 100);
    }
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
    const { data, error } = await this._client.from(this._table).select(selectClause).eq("id", id).maybeSingle();
    if (error) {
      throw error;
    }
    return data as unknown as ResultOne | undefined;
  }

  /**
   * Allow subclasses to enqueue a broadcast message for debounced processing.
   * Performs basic validation and table-name matching before queueing.
   */
  protected enqueueBroadcast(message: BroadcastMessage): void {
    if (this._closed) return;
    // Filter by table name if provided
    if (message.table && message.table !== this._table) {
      return;
    }
    if (
      !message.operation ||
      (message.operation !== "INSERT" &&
        message.operation !== "UPDATE" &&
        message.operation !== "DELETE" &&
        message.operation !== "BULK_UPDATE")
    ) {
      return;
    }

    // Handle bulk operations (BULK_UPDATE or large INSERT/DELETE) immediately
    // These already represent batched operations from statement-level triggers
    if (
      message.operation === "BULK_UPDATE" ||
      ("requires_refetch" in message &&
        message.requires_refetch &&
        "affected_count" in message &&
        message.affected_count &&
        message.affected_count >= 50)
    ) {
      this._handleBulkUpdate(message);
      return;
    }

    this._pendingOperations.push(message);
    this._scheduleBatchedOperations();
  }

  /**
   * Schedule batched operations to be processed after debounce interval
   */
  private _scheduleBatchedOperations(): void {
    if (this._debounceTimeout) {
      clearTimeout(this._debounceTimeout);
    }

    this._debounceTimeout = setTimeout(
      async () => {
        await this._processBatchedOperations();
      },
      this._debounceInterval + Math.random() * 1000 * 5
    ); // Add some jitter to prevent thundering herd
  }

  /**
   * Process all pending batched operations in chronological order
   */
  private async _processBatchedOperations(): Promise<void> {
    if (this._closed) return;

    // Prevent concurrent batch processing
    if (this._isProcessingBatch) {
      // If we're already processing, reschedule this batch for later
      if (this._pendingOperations.length > 0) {
        this._scheduleBatchedOperations();
      }
      return;
    }

    if (this._pendingOperations.length === 0) {
      this._debounceTimeout = null;
      return;
    }

    // Set processing flag and take snapshot of pending operations
    this._isProcessingBatch = true;
    const operations = [...this._pendingOperations];
    this._pendingOperations = [];
    this._debounceTimeout = null;

    // Group consecutive operations of the same type to enable batching
    // while preserving overall chronological order
    const batches: { type: "INSERT" | "UPDATE" | "DELETE"; messages: BroadcastMessage[] }[] = [];
    let currentBatch: { type: "INSERT" | "UPDATE" | "DELETE"; messages: BroadcastMessage[] } | null = null;

    for (const operation of operations) {
      if (
        !operation.operation ||
        (operation.operation !== "INSERT" &&
          operation.operation !== "UPDATE" &&
          operation.operation !== "DELETE" &&
          operation.operation !== "BULK_UPDATE")
      ) {
        continue;
      }

      // BULK_UPDATE messages are handled separately and should not be in the batch queue
      if (operation.operation === "BULK_UPDATE") {
        continue;
      }

      if (!currentBatch || currentBatch.type !== operation.operation) {
        // Start a new batch
        currentBatch = { type: operation.operation, messages: [operation] };
        batches.push(currentBatch);
      } else {
        // Add to current batch
        currentBatch.messages.push(operation);
      }
    }

    // Process batches in chronological order, awaiting each batch to complete
    // before moving to the next to prevent race conditions
    for (const batch of batches) {
      try {
        switch (batch.type) {
          case "INSERT":
            await this._handleInsertBatch(batch.messages);
            break;
          case "UPDATE":
            await this._handleUpdateBatch(batch.messages);
            break;
          case "DELETE":
            await this._handleDeleteBatch(batch.messages);
            break;
        }
      } catch (error) {
        // Log error but continue processing remaining batches
        Sentry.captureException(error);
      }
    }

    // Clear processing flag
    this._isProcessingBatch = false;

    // If more operations arrived while we were processing, schedule another batch
    if (this._pendingOperations.length > 0) {
      this._scheduleBatchedOperations();
    }
  }

  /**
   * Refetch multiple rows by their IDs using IN queries with batching
   */
  private async _refetchRowsByIds(ids: IDType[]): Promise<Map<IDType, ResultOne>> {
    const results = new Map<IDType, ResultOne>();
    const batchSize = 100;
    const selectClause = (this._selectForSingleRow as string | undefined) ?? "*";

    // Process IDs in batches of 100
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);

      try {
        const { data, error } = await this._client.from(this._table).select(selectClause).in("id", batch);

        if (error) {
          Sentry.captureException(error);
          continue;
        }

        if (data) {
          for (const row of data) {
            const typedRow = row as unknown as ResultOne;
            const id = (typedRow as ResultOne & { id: IDType }).id;
            results.set(id, typedRow);
          }
        }
      } catch (error) {
        Sentry.captureException(error);
      }
    }

    return results;
  }

  /**
   * Incremental refetch using updated_at watermark if available.
   * Falls back to no-op if watermark is not set or table lacks updated_at.
   */
  private async _refetchSinceMaxUpdatedAt(): Promise<void> {
    if (this._closed) return;
    if (this._maxUpdatedAtMs == null) {
      return; // No watermark yet
    }

    this._isRefetching = true;
    this._refetchListeners.forEach((listener) => listener(true));

    const sinceIso = new Date(this._maxUpdatedAtMs).toISOString();

    const ourQuery = new PostgrestFilterBuilder(this._query)
      .gt("updated_at", sinceIso)
      .order("updated_at", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true });

    try {
      let page = 0;
      const pageSize = 1000;
      const changedRows: ResultOne[] = [];

      // Fetch in pages ordered by updated_at to advance watermark monotonically
      // This still drastically reduces transferred data compared to a full refetch.
      for (;;) {
        const rangeStart = page * pageSize;
        const rangeEnd = (page + 1) * pageSize - 1;

        const { data, error } = await ourQuery.range(rangeStart, rangeEnd);

        if (this._closed) return;
        if (error) {
          // If the table has no updated_at or filter failed, abort incremental silently
          throw error;
        }
        if (!data || data.length === 0) {
          break;
        }
        changedRows.push(...(data as unknown as ResultOne[]));
        if (data.length < pageSize) {
          break;
        }
        page++;
      }

      if (changedRows.length === 0) {
        return;
      }

      const entered: ResultOne[] = [];
      const left: ResultOne[] = [];

      // Build quick lookup for current rows by id
      const currentById = new Map<IDType, PossiblyTentativeResult<ResultOne>>(
        this._rows.map((r) => [(r as unknown as ResultOne & { id: IDType }).id as IDType, r])
      );

      for (const row of changedRows) {
        const id = (row as unknown as ResultOne & { id: IDType }).id;
        const matchesFilter = this._matchesRealtimeFilter(row as unknown as Record<string, unknown>);
        const existing = currentById.get(id);

        // Advance watermark as we see rows; ensures subsequent calls continue where we left off
        this._bumpMaxUpdatedAtFrom(row as unknown as Record<string, unknown>);

        if (existing && !matchesFilter) {
          // No longer matches → remove
          this._removeRow(id);
          left.push(existing as unknown as ResultOne);
          currentById.delete(id);
        } else if (existing && matchesFilter) {
          // Update in place
          this._updateRow(id, row as ResultOne & { id: IDType }, false);
          currentById.set(id, row as unknown as PossiblyTentativeResult<ResultOne>);
        } else if (!existing && matchesFilter) {
          // Newly matching / newly created
          this._addRow({ ...(row as ResultOne), __db_pending: false } as PossiblyTentativeResult<ResultOne>);
          entered.push(row);
          currentById.set(id, row as unknown as PossiblyTentativeResult<ResultOne>);
        }
        // else (!existing && !matchesFilter) → ignore
      }

      // Notify list listeners only once for entered/left bundles when there were membership changes
      if (entered.length > 0 || left.length > 0) {
        this._listDataListeners.forEach((listener) =>
          listener(this._rows as unknown as ResultOne[], { entered, left })
        );
      }
    } catch (error) {
      // If incremental fails (e.g., due to missing column), fall back to full refetch on next attempt
      Sentry.captureException(error);
      this._maxUpdatedAtMs = null;
    } finally {
      this._isRefetching = false;
      this._refetchListeners.forEach((listener) => listener(false));
    }
  }

  /**
   * Fetch initial data with pagination
   */
  private async _fetchInitialData(loadEntireTable: boolean): Promise<ResultOne[]> {
    const rows: ResultOne[] = [];
    let page = 0;
    const pageSize = 1000;
    let nRows: number | undefined;

    // Always add ORDER BY id to ensure deterministic pagination
    // This prevents rows from being skipped or duplicated across page boundaries
    // when PostgreSQL returns results in non-deterministic order
    // PostgREST query builders are immutable, so this doesn't affect the original query
    const orderedQuery = this._query.order("id", { ascending: true });

    if (loadEntireTable) {
      // Load initial data, do all of the pages.
      // If nRows is specified, only fetch up to nRows, otherwise fetch all pages until no more data
      while (!this._closed) {
        const rangeStart = page * pageSize;
        let rangeEnd = (page + 1) * pageSize - 1;
        if (typeof nRows === "number") {
          if (rangeStart >= nRows) break;
          rangeEnd = Math.min(rangeEnd, nRows - 1);
        }
        const { data, error } = await orderedQuery.range(rangeStart, rangeEnd);
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
    } else {
      const { data, error } = await orderedQuery;
      if (error) {
        throw error;
      }
      if (!data || data.length === 0) {
        return [];
      }
      rows.push(...(data as unknown as ResultOne[]));
    }

    this._lastFetchTimestamp = Date.now();
    return rows;
  }

  /**
   * Refetch all data and notify subscribers of changes (full refresh)
   */
  private async _refetchAllDataFull(): Promise<void> {
    // Set refetch state to true and notify listeners
    this._isRefetching = true;
    this._refetchListeners.forEach((listener) => listener(true));

    try {
      const oldRows = [...this._rows];
      const newData = await this._fetchInitialData(true);

      // Convert new data to our internal format
      const newRows = newData.map((row) => ({
        ...row,
        __db_pending: false
      })) as PossiblyTentativeResult<ResultOne>[];

      // Calculate changes for list listeners
      const oldIds = new Set(oldRows.map((r) => (r as ResultOne & { id: IDType }).id));
      const newIds = new Set(newRows.map((r) => (r as ResultOne & { id: IDType }).id));

      const entered = newRows.filter((r) => !oldIds.has((r as ResultOne & { id: IDType }).id)) as ResultOne[];
      const left = oldRows.filter((r) => !newIds.has((r as ResultOne & { id: IDType }).id)) as ResultOne[];
      // If membership (by id) has not changed, avoid replacing the array and avoid list notifications.
      if (entered.length === 0 && left.length === 0) {
        const nextById = new Map<IDType, PossiblyTentativeResult<ResultOne>>(
          newRows.map((r) => [(r as ResultOne & { id: IDType }).id, r])
        );

        // Update existing rows in place and notify item listeners
        let anyChanges = false;
        for (let i = 0; i < this._rows.length; i++) {
          const current = this._rows[i] as unknown as ResultOne & { id: IDType };
          const updated = nextById.get(current.id);
          if (updated) {
            // Only notify if deeply different
            if (!this._deepEqualObjects(current, updated)) {
              this._rows[i] = updated as PossiblyTentativeResult<ResultOne>;
              const listeners = this._itemDataListeners.get(current.id);
              if (listeners) {
                listeners.forEach((listener) => listener(this._rows[i]));
              }
              anyChanges = true;
            }
          }
        }
        if (anyChanges) {
          // Optimization opportunity: we should fix it so that no subscriber depends on this behavior
          this._rows = newRows;
          this._listDataListeners.forEach((listener) => listener(this._rows, { entered, left }));
        }
      } else {
        // Membership changed: replace rows and notify list + item listeners accordingly
        this._rows = newRows;

        // Notify list listeners
        this._listDataListeners.forEach((listener) => listener(this._rows, { entered, left }));

        // Notify item listeners only for newly entered or changed items
        const oldById = new Map<IDType, PossiblyTentativeResult<ResultOne>>(
          oldRows.map((r) => [(r as ResultOne & { id: IDType }).id, r as PossiblyTentativeResult<ResultOne>])
        );
        const enteredIdSet = new Set<IDType>(entered.map((r) => (r as ResultOne & { id: IDType }).id));

        for (const row of newRows) {
          const id = (row as ResultOne & { id: IDType }).id;
          const listeners = this._itemDataListeners.get(id);
          if (!listeners) continue;
          if (enteredIdSet.has(id)) {
            listeners.forEach((listener) => listener(row));
            continue;
          }
          const previous = oldById.get(id);
          if (!this._deepEqualObjects(previous as unknown, row as unknown)) {
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
      }
    } catch (error) {
      Sentry.captureException(error);
    } finally {
      // Set refetch state to false and notify listeners
      this._isRefetching = false;
      this._refetchListeners.forEach((listener) => listener(false));
    }
  }

  /**
   * Unified refetch that prefers incremental-by-updated_at when available; otherwise full refresh
   */
  private async _refetchAllData(): Promise<void> {
    if (this._isRefetching) {
      return;
    }
    this._lastFetchTimestamp = Date.now();
    if (this._maxUpdatedAtMs != null) {
      await this._refetchSinceMaxUpdatedAt();
      return;
    }
    await this._refetchAllDataFull();
  }

  private _lastRefetchAllTime = 0;
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
    if (Date.now() - this._lastRefetchAllTime < 3000) {
      throw new Error("Refetch all called too frequently");
    }
    this._lastRefetchAllTime = Date.now();

    await this._refetchAllData();
  }

  /**
   * Public method to refetch specific rows by their IDs and update the controller state.
   * Uses batched IN queries to efficiently fetch multiple rows at once.
   * @param ids Array of row IDs to refetch
   */
  async refetchByIds(ids: IDType[]): Promise<void> {
    if (this._closed) {
      throw new Error(
        `TableController for table '${this._table}' is closed. Cannot call refetchByIds(). This indicates a stale reference is being used.`
      );
    }
    if (ids.length === 0) {
      return;
    }

    const refetchedRows = await this._refetchRowsByIds(ids);

    // Update existing rows and add new ones
    for (const [id, row] of refetchedRows) {
      const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);

      if (existingRow) {
        this._updateRow(id, row as ResultOne & { id: IDType }, false);
      } else {
        // Check if the fetched row matches our realtime filter
        if (this._matchesRealtimeFilter(row as unknown as Record<string, unknown>)) {
          this._addRow({
            ...row,
            __db_pending: false
          });
        }
      }
    }
  }

  /**
   * Get the list of relevant channel types for this table
   */
  private _getRelevantChannelTypes(): ChannelType[] {
    return TABLE_TO_CHANNEL_MAP[this._table] || [];
  }

  /**
   * Check if a channel status is relevant for this table
   */
  private _isChannelRelevantForTable(channelStatus: ChannelStatus): boolean {
    const relevantTypes = this._getRelevantChannelTypes();

    // If table explicitly has no broadcasts (empty array in map), no channels are relevant
    if (this._table in TABLE_TO_CHANNEL_MAP && relevantTypes.length === 0) {
      return false;
    }

    // If table is not in map at all, consider all channels relevant (conservative approach)
    if (!(this._table in TABLE_TO_CHANNEL_MAP)) {
      return true;
    }

    // Check if this channel type is relevant for our table
    if (!relevantTypes.includes(channelStatus.type as ChannelType)) {
      return false;
    }

    // For submission-specific channels, verify the submission ID matches if we're tracking a submission
    if (
      this._submissionId &&
      (channelStatus.type === "submission_graders" || channelStatus.type === "submission_user")
    ) {
      return channelStatus.submissionId === this._submissionId;
    }

    return true;
  }

  /**
   * Check if all relevant channels are currently in a connected state
   */
  private _areRelevantChannelsConnected(): boolean {
    for (const [, state] of this._lastChannelStates) {
      if (state !== "joined") {
        return false;
      }
    }
    return this._lastChannelStates.size > 0; // Must have at least one channel tracked
  }

  /**
   * Handle connection status changes (debounced to avoid thrashing during channel oscillations)
   * Only refetches when channels relevant to this table's data reconnect
   * Does NOT refetch on initial connection, only on subsequent reconnections
   */
  private _handleConnectionStatusChange(status: ConnectionStatus): void {
    // Track which relevant channels have reconnected
    const relevantReconnections: string[] = [];

    for (const channel of status.channels) {
      if (!this._isChannelRelevantForTable(channel)) {
        continue; // Skip channels not relevant to this table
      }

      const previousState = this._lastChannelStates.get(channel.name);
      const isChannelNowConnected = channel.state === "joined";
      const hadCompletedInitialConnection = this._channelsCompletedInitialConnection.has(channel.name);

      // Only treat as reconnection if:
      // 1. Channel had previously completed an initial connection (not the first time)
      // 2. Channel was disconnected in the previous state
      // 3. Channel is now connected
      const wasChannelDisconnected = previousState !== undefined && previousState !== "joined";
      const isReconnection = hadCompletedInitialConnection && wasChannelDisconnected && isChannelNowConnected;

      if (isReconnection) {
        relevantReconnections.push(channel.name);
      }

      // Mark channel as having completed initial connection once it reaches "joined" state for the first time
      if (isChannelNowConnected && !hadCompletedInitialConnection) {
        this._channelsCompletedInitialConnection.add(channel.name);
      }

      // Update tracked state
      this._lastChannelStates.set(channel.name, channel.state);
    }

    // Only refetch if a relevant channel has reconnected (not initial connection)
    if (relevantReconnections.length > 0 && this._ready) {
      // Determine if auto-refetch should be enabled for this table
      const shouldAutoRefetch = this._shouldEnableAutoRefetch();

      if (!shouldAutoRefetch) {
        // Skip refetch for tables without updated_at (unless explicitly enabled)
        return;
      }

      // Clear any pending refetch
      if (this._connectionStatusDebounceTimer) {
        clearTimeout(this._connectionStatusDebounceTimer);
      }

      // Schedule refetch after a short delay to let connection stabilize
      this._connectionStatusDebounceTimer = setTimeout(() => {
        this._connectionStatusDebounceTimer = null;
        if (!this._closed && this._areRelevantChannelsConnected()) {
          // Skip refetch if we just fetched within the last 3 seconds (e.g., initial load)
          const timeSinceLastFetch = Date.now() - this._lastFetchTimestamp;
          if (timeSinceLastFetch < 3000) {
            return;
          }
          // Only refetch if relevant channels are still connected after the debounce period
          this._refetchAllData();
        }
      }, 1000); // 1 second debounce for connection status
    }
  }

  /**
   * Determine if auto-refetch should be enabled for this table.
   * Returns true if:
   * - enableAutoRefetch is explicitly true, OR
   * - enableAutoRefetch is undefined AND table has updated_at column
   * Returns false if:
   * - enableAutoRefetch is explicitly false, OR
   * - enableAutoRefetch is undefined AND table does NOT have updated_at column
   */
  private _shouldEnableAutoRefetch(): boolean {
    if (this._enableAutoRefetch === true) {
      return true;
    }
    if (this._enableAutoRefetch === false) {
      return false;
    }
    // Default behavior: only refetch if table has updated_at
    return TABLES_WITH_UPDATED_AT.has(this._table);
  }

  constructor({
    query,
    client,
    table,
    classRealTimeController,
    selectForSingleRow,
    submissionId,
    additionalRealTimeControllers,
    realtimeFilter,
    debounceInterval,
    loadEntireTable = true,
    initialData,
    enableAutoRefetch,
    autoFetchMissingRows
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
    /** Additional realtime controllers (e.g., DiscussionThreadRealTimeController, OfficeHoursRealTimeController) */
    additionalRealTimeControllers?: PawtograderRealTimeController[];
    /** Select clause to use for single-row refetches (preserves joins) */
    selectForSingleRow?: Query;
    submissionId?: number;
    /** Optional filter for real-time events to match only rows that would be included in the query */
    realtimeFilter?: RealtimeFilter<RelationName>;
    debounceInterval?: number;
    loadEntireTable?: boolean;
    /** Optional pre-loaded initial data to hydrate the controller without fetching. Query is still required for refetches. */
    initialData?: ResultOne[];
    /**
     * Controls auto-refetch behavior on reconnection.
     * - undefined (default): Auto-refetch only if table has updated_at column
     * - true: Always auto-refetch on reconnection
     * - false: Never auto-refetch on reconnection
     */
    enableAutoRefetch?: boolean;
    /**
     * Controls whether this table should auto-fetch missing rows.
     * If true, auto-fetch missing rows on getById.
     * If false, never auto-fetch missing rows on getById.
     */
    autoFetchMissingRows?: boolean;
  }) {
    this._rows = [];
    this._client = client;
    this._query = query;
    this._table = table;
    this._classRealTimeController = classRealTimeController || null;
    this._additionalRealTimeControllers = additionalRealTimeControllers || [];
    this._submissionId = submissionId || null;
    this._selectForSingleRow = selectForSingleRow;
    this._realtimeFilter = realtimeFilter || null;
    this._debounceInterval = debounceInterval || 500;
    this._enableAutoRefetch = enableAutoRefetch;
    this._autoFetchMissingRows = autoFetchMissingRows ?? true;
    // Track controller creation
    const tableName = table as string;
    const currentCount = TableController._controllerCounts.get(tableName) || 0;
    const newCount = currentCount + 1;
    TableController._controllerCounts.set(tableName, newCount);

    // Only log creation if there are more than 4 live controllers for this table
    if (newCount > 4) {
      // eslint-disable-next-line no-console
      console.log(
        `⚠️ TableController created for "${tableName}" (count: ${newCount} - potential leak!)`,
        Object.fromEntries(TableController._controllerCounts)
      );
      Sentry.addBreadcrumb({
        category: "tableController",
        message: `TableController created for "${tableName}" - count exceeds threshold`,
        level: "warning",
        data: {
          table: tableName,
          count: newCount,
          debugId: this._debugID,
          allCounts: Object.fromEntries(TableController._controllerCounts)
        }
      });
      Sentry.captureMessage(`TableController created for "${tableName}" - count exceeds threshold`, {
        level: "warning"
      });
    }
    this._readyPromise = new Promise(async (resolve, reject) => {
      try {
        const messageHandler = (message: BroadcastMessage) => {
          this.enqueueBroadcast(message);
          if (message.type !== "gradebook_row_recalc_state" && message.data) {
            this._bumpMaxUpdatedAtFrom(message.data);
          }
        };

        // Use provided initial data or fetch it
        if (this._closed) {
          resolve();
          return;
        }

        let dataToLoad: ResultOne[];
        if (initialData) {
          // Use pre-loaded data from server (skip initial fetch)
          dataToLoad = initialData;
        } else {
          // Fetch data from database
          dataToLoad = await this._fetchInitialData(loadEntireTable);
        }

        if (this._closed) {
          resolve();
          return;
        }

        this._rows = dataToLoad.map((row) => ({
          ...row,
          __db_pending: false
        }));

        // Initialize watermark
        for (const r of this._rows) {
          this._bumpMaxUpdatedAtFrom(r);
        }

        // Set up realtime subscription if controller is provided
        if (!this._closed && this._classRealTimeController) {
          if (this._submissionId) {
            this._classRealtimeUnsubscribe = this._classRealTimeController.subscribeToTableForSubmission(
              table,
              this._submissionId,
              messageHandler
            );
          } else {
            this._classRealtimeUnsubscribe = this._classRealTimeController.subscribeToTable(table, messageHandler);
          }

          // Subscribe to connection status changes for reconnection handling
          this._classStatusUnsubscribe = this._classRealTimeController.subscribeToStatus((status) => {
            if (this._closed) return;
            this._handleConnectionStatusChange(status);
          });

          // Initialize channel state tracking with current states
          const initialStatus = this._classRealTimeController.getConnectionStatus();
          for (const channel of initialStatus.channels) {
            if (this._isChannelRelevantForTable(channel)) {
              this._lastChannelStates.set(channel.name, channel.state);
            }
          }
        }

        // Subscribe to additional realtime controllers (e.g., per-thread, office hours)
        if (!this._closed && this._additionalRealTimeControllers.length > 0) {
          for (const controller of this._additionalRealTimeControllers) {
            // Subscribe to table changes
            const unsubscribe = controller.subscribeToTable(table, messageHandler);
            this._additionalRealtimeUnsubscribes.push(unsubscribe);

            // Subscribe to connection status changes
            const statusUnsubscribe = controller.subscribeToStatus((status) => {
              if (this._closed) return;
              this._handleConnectionStatusChange(status);
            });
            this._additionalStatusUnsubscribes.push(statusUnsubscribe);

            // Merge initial channel states (deduplicate by channel.name)
            const initialStatus = controller.getConnectionStatus();
            for (const channel of initialStatus.channels) {
              if (this._isChannelRelevantForTable(channel)) {
                // Only set if not already set by previous controllers
                if (!this._lastChannelStates.has(channel.name)) {
                  this._lastChannelStates.set(channel.name, channel.state);
                }
              }
            }
          }
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
    if (this._closed) {
      // Already closed, don't double-count
      return;
    }
    this._closed = true;

    // Track controller closure
    const tableName = this._table as string;
    const currentCount = TableController._controllerCounts.get(tableName) || 0;
    const newCount = Math.max(0, currentCount - 1);

    if (newCount === 0) {
      TableController._controllerCounts.delete(tableName);
    } else {
      TableController._controllerCounts.set(tableName, newCount);
    }

    if (this._classRealtimeUnsubscribe) {
      this._classRealtimeUnsubscribe();
      this._classRealtimeUnsubscribe = null;
    }
    if (this._classStatusUnsubscribe) {
      this._classStatusUnsubscribe();
      this._classStatusUnsubscribe = null;
    }
    // Unsubscribe from all additional controllers
    for (const unsubscribe of this._additionalRealtimeUnsubscribes) {
      unsubscribe();
    }
    this._additionalRealtimeUnsubscribes = [];
    for (const unsubscribe of this._additionalStatusUnsubscribes) {
      unsubscribe();
    }
    this._additionalStatusUnsubscribes = [];
    if (this._debounceTimeout) {
      clearTimeout(this._debounceTimeout);
      this._debounceTimeout = null;
    }
    if (this._connectionStatusDebounceTimer) {
      clearTimeout(this._connectionStatusDebounceTimer);
      this._connectionStatusDebounceTimer = null;
    }
    // Clear all listeners and pending operations
    this._refetchListeners = [];
    this._listDataListeners = [];
    this._itemDataListeners.clear();
    // Clear tracked channel states
    this._lastChannelStates.clear();
    this._channelsCompletedInitialConnection.clear();
    this._pendingOperations = [];
    this._isProcessingBatch = false;
  }

  private async _handleInsertBatch(messages: BroadcastMessage[]): Promise<void> {
    if (this._closed) return;

    const messagesWithData: BroadcastMessage[] = [];
    const idsToRefetch: IDType[] = [];

    // Separate messages with data from those requiring refetch
    for (const message of messages) {
      if (message.type !== "gradebook_row_recalc_state") {
        if (message.data) {
          messagesWithData.push(message);
        } else if (message.row_id) {
          idsToRefetch.push(message.row_id as IDType);
        }
      }
    }

    // Process messages with full data synchronously first
    for (const message of messagesWithData) {
      this._handleInsert(message);
    }

    // Batch refetch for messages without data and await completion
    if (idsToRefetch.length > 0) {
      try {
        const refetchedRows = await this._refetchRowsByIds(idsToRefetch);
        for (const [id, row] of refetchedRows) {
          if (!this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id)) {
            // Check if the fetched row matches our realtime filter
            if (this._matchesRealtimeFilter(row as unknown as Record<string, unknown>)) {
              this._bumpMaxUpdatedAtFrom(row as unknown as Record<string, unknown>);
              // Check for pending tentative rows that might represent the same data
              const pendingRow = this._rows.find((r) => {
                const rowData = r as PossiblyTentativeResult<ResultOne>;
                return (
                  rowData.__db_pending && this._isPotentialMatch(rowData, row as unknown as Record<string, unknown>)
                );
              });

              if (pendingRow) {
                // Update the pending row with the real data instead of adding a duplicate
                const pendingRowWithId = pendingRow as ResultOne & { id: IDType };
                pendingRowWithId.id = id;
                this._updateRow(id, row as ResultOne & { id: IDType }, false);
              } else {
                this._addRow({
                  ...row,
                  __db_pending: false
                });
              }
            }
          }
        }
      } catch (error) {
        Sentry.captureException(error);
      }
    }
  }

  private async _handleUpdateBatch(messages: BroadcastMessage[]): Promise<void> {
    if (this._closed) return;

    const messagesWithData: BroadcastMessage[] = [];
    const idsToRefetch: IDType[] = [];

    // Separate messages with data from those requiring refetch
    for (const message of messages) {
      if (message.type !== "gradebook_row_recalc_state") {
        if (message.data) {
          messagesWithData.push(message);
        } else if (message.row_id) {
          idsToRefetch.push(message.row_id as IDType);
        }
      }
    }

    // Process messages with full data synchronously first
    for (const message of messagesWithData) {
      this._handleUpdate(message);
    }

    // Batch refetch for messages without data and await completion
    if (idsToRefetch.length > 0) {
      try {
        const refetchedRows = await this._refetchRowsByIds(idsToRefetch);
        for (const [id, row] of refetchedRows) {
          const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
          const matchesFilter = this._matchesRealtimeFilter(row as unknown as Record<string, unknown>);

          if (existingRow && !matchesFilter) {
            // Row was updated but no longer matches our filter - remove it
            this._removeRow(id);
          } else if (existingRow && matchesFilter) {
            this._bumpMaxUpdatedAtFrom(row as unknown as Record<string, unknown>);
            this._updateRow(id, row as ResultOne & { id: IDType }, false);
          } else if (!existingRow && matchesFilter) {
            this._bumpMaxUpdatedAtFrom(row as unknown as Record<string, unknown>);
            this._addRow({
              ...row,
              __db_pending: false
            });
          }
        }
      } catch (error) {
        Sentry.captureException(error);
      }
    }
  }

  private async _handleDeleteBatch(messages: BroadcastMessage[]): Promise<void> {
    if (this._closed) return;

    const idsToDelete = new Set<IDType>();

    // Collect all IDs to delete
    for (const message of messages) {
      if (message.type !== "gradebook_row_recalc_state") {
        if (message.data) {
          const data = message.data as Record<string, unknown>;
          idsToDelete.add(data.id as IDType);
        } else if (message.row_id) {
          idsToDelete.add(message.row_id as IDType);
        }
      }
    }

    // Remove all rows in batch (synchronous operation, no async needed)
    for (const id of idsToDelete) {
      this._removeRow(id);
    }
  }

  private _handleInsert(message: BroadcastMessage) {
    if (this._closed) return;
    if (message.type === "gradebook_row_recalc_state") return; // Handled elsewhere
    if (message.data) {
      // Handle full data broadcasts
      const data = message.data as Record<string, unknown>;

      // Check if the row matches our realtime filter
      if (!this._matchesRealtimeFilter(data)) {
        return; // Skip rows that don't match our filter
      }

      // Check for exact ID match first
      const existingRowById = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === data.id);
      this._bumpMaxUpdatedAtFrom(data);
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
              this._bumpMaxUpdatedAtFrom(fullRow as unknown as Record<string, unknown>);
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
              this._bumpMaxUpdatedAtFrom(fullRow as unknown as Record<string, unknown>);
              this._addRow({
                ...(fullRow as ResultOne),
                __db_pending: false
              } as PossiblyTentativeResult<ResultOne>);
            } else {
              this._bumpMaxUpdatedAtFrom(data);
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
          this._bumpMaxUpdatedAtFrom(data);
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
          this._bumpMaxUpdatedAtFrom(row as unknown as Record<string, unknown>);

          // Check if the fetched row matches our realtime filter
          if (!this._matchesRealtimeFilter(row as Record<string, unknown>)) {
            return; // Skip rows that don't match our filter
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

  /**
   * Shallow equality check for two plain objects. Returns true if they have
   * the same set of keys and all corresponding values are strictly equal.
   */
  private _shallowEqualObjects(objA: unknown, objB: unknown): boolean {
    if (objA === objB) return true;
    if (!objA || !objB) return false;
    if (typeof objA !== "object" || typeof objB !== "object") return false;

    const a = objA as Record<string, unknown>;
    const b = objB as Record<string, unknown>;

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (a[key] !== b[key]) return false;
    }
    return true;
  }

  /** Deep equality for JSON-like values (objects/arrays/primitives). */
  private _deepEqualObjects(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a !== typeof b) return false;

    // Dates: compare time value
    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }

    // Arrays
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!this._deepEqualObjects(a[i], b[i])) return false;
      }
      return true;
    }

    // Objects
    if (typeof a === "object" && typeof b === "object") {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;
      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);
      if (aKeys.length !== bKeys.length) return false;
      for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
        if (!this._deepEqualObjects(aObj[key], bObj[key])) return false;
      }
      return true;
    }

    // Fallback strict equality for primitives and mismatched types
    return false;
  }

  /**
   * Check if a row matches the realtime filter
   */
  private _matchesRealtimeFilter(rowData: Record<string, unknown>): boolean {
    if (!this._realtimeFilter) {
      return true; // No filter means all rows match
    }

    for (const [key, filterValue] of Object.entries(this._realtimeFilter)) {
      const rowValue = rowData[key];

      if (Array.isArray(filterValue)) {
        // Handle array filters (IN clause equivalent)
        if (!filterValue.includes(rowValue as never)) {
          return false;
        }
      } else {
        // Handle single value filters (equality)
        if (rowValue !== filterValue) {
          return false;
        }
      }
    }

    return true;
  }

  private _handleUpdate(message: BroadcastMessage) {
    if (this._closed) return;
    if (message.type === "gradebook_row_recalc_state") return; // Handled elsewhere
    if (message.data) {
      // Handle full data broadcasts
      const data = message.data as Record<string, unknown>;
      const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === data.id);

      // Check if the updated row matches our realtime filter
      const matchesFilter = this._matchesRealtimeFilter(data);

      if (existingRow && !matchesFilter) {
        // Row was updated but no longer matches our filter - remove it
        this._removeRow(data.id as IDType);
        return;
      } else if (!existingRow && !matchesFilter) {
        // Row doesn't exist and doesn't match filter - ignore
        return;
      }
      const applyUpdate = (rowLike: Record<string, unknown>) => {
        this._bumpMaxUpdatedAtFrom(rowLike);
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
        this._bumpMaxUpdatedAtFrom(row as unknown as Record<string, unknown>);

        const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === message.row_id);
        const matchesFilter = this._matchesRealtimeFilter(row as Record<string, unknown>);

        if (existingRow && !matchesFilter) {
          // Row was updated but no longer matches our filter - remove it
          this._removeRow(message.row_id as IDType);
          return;
        } else if (!existingRow && !matchesFilter) {
          // Row doesn't exist and doesn't match filter - ignore
          return;
        }

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
    if (message.type === "gradebook_row_recalc_state") return; // Handled elsewhere
    if (message.data) {
      const data = message.data as Record<string, unknown>;
      this._removeRow(data.id as IDType);
    } else if (message.row_id) {
      this._removeRow(message.row_id as IDType);
    }
  }

  /**
   * Handle bulk operations (INSERT, UPDATE, DELETE) from statement-level triggers.
   * If requires_refetch is true, triggers a full refetch.
   * Otherwise, refetches only the specified row IDs.
   */
  private async _handleBulkUpdate(message: BroadcastMessage): Promise<void> {
    if (this._closed) return;

    // If refetch is required (large bulk operation), trigger full refetch
    if ("requires_refetch" in message && message.requires_refetch) {
      // Use incremental refetch if available, otherwise full refetch
      await this._refetchAllData();
      return;
    }

    // Handle DELETE operations - remove rows by IDs
    if (message.operation === "DELETE" && "row_ids" in message && message.row_ids && message.row_ids.length > 0) {
      const idsToDelete = message.row_ids.map((id) => id as IDType);
      for (const id of idsToDelete) {
        this._removeRow(id);
      }
      return;
    }

    // Handle INSERT/UPDATE operations - refetch specified row IDs
    if (
      message.type !== "gradebook_row_recalc_state" &&
      "row_ids" in message &&
      message.row_ids &&
      message.row_ids.length > 0
    ) {
      const idsToRefetch = message.row_ids.map((id) => id as IDType);
      try {
        const refetchedRows = await this._refetchRowsByIds(idsToRefetch);

        // Update existing rows and add new ones
        for (const [id, row] of refetchedRows) {
          const existingRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
          const matchesFilter = this._matchesRealtimeFilter(row as unknown as Record<string, unknown>);

          if (existingRow && !matchesFilter) {
            // Row was updated but no longer matches our filter - remove it
            this._removeRow(id);
          } else if (existingRow && matchesFilter) {
            this._bumpMaxUpdatedAtFrom(row as unknown as Record<string, unknown>);
            this._updateRow(id, row as ResultOne & { id: IDType }, false);
          } else if (!existingRow && matchesFilter) {
            this._bumpMaxUpdatedAtFrom(row as unknown as Record<string, unknown>);
            this._addRow({
              ...row,
              __db_pending: false
            });
          }
        }
      } catch (error) {
        Sentry.captureException(error);
        // Fallback to full refetch on error
        await this._refetchAllData();
      }
    }
  }

  private _nonExistantKeys: Set<IDType> = new Set();
  private async _maybeRefetchKey(id: IDType) {
    if (!this._ready || !this._autoFetchMissingRows) {
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

  async getOneByFilters(
    filters: { column: keyof Database["public"]["Tables"][RelationName]["Row"]; operator: string; value: unknown }[]
  ) {
    //Check to see if we already have this row in our cache
    const matcher = (r: ResultOne & { id: ExtractIdType<RelationName> }) => {
      for (const filter of filters) {
        if (r[filter.column as keyof ResultOne & { id: ExtractIdType<RelationName> }] !== filter.value) {
          return false;
        }
      }
      return true;
    };
    const existingRow = this._rows.find(matcher as (r: PossiblyTentativeResult<ResultOne>) => boolean);
    if (existingRow) {
      return existingRow;
    }
    let query = this._client.from(this._table).select("*");
    for (const filter of filters) {
      query = query.filter(filter.column as string, filter.operator, filter.value);
    }
    const { data, error } = await query.maybeSingle();
    if (error) {
      throw error;
    }
    if (!data) {
      return null;
    }
    this._addRow({
      ...data,
      __db_pending: false
    } as PossiblyTentativeResult<ResultOne>);
    return data;
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
    if (id === undefined) {
      throw new Error("Undefined ID is not a valid ID, ever.");
    }
    if (id === null) {
      throw new Error("Null ID is not a valid ID, ever.");
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
    if (id === null) {
      throw new Error("Null ID is not a valid ID, ever.");
    }
    if (id === "") {
      throw new Error("Empty string ID is not a valid ID, ever.");
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

  async create(row: Database["public"]["Tables"][RelationName]["Insert"]): Promise<ResultOne> {
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

  async hardDelete(id: ExtractIdType<RelationName>): Promise<void> {
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
    const { error } = await this._client.from(this._table).delete().eq("id", id);
    if (error) {
      this._addRow({ ...existingRow, __db_pending: false } as PossiblyTentativeResult<ResultOne>);
      throw error;
    }
    return;
  }

  /**
   * Most things are soft-deleted (have a deleted_at, we set to NOW)
   * Use this for those.
   *
   * @param id
   * @returns
   */
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
    await this.waitForRefetchToComplete();
    let oldRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
    // If row not found, try to fetch it first (similar to getById behavior)
    if (!oldRow && !this._nonExistantKeys.has(id)) {
      await this._maybeRefetchKey(id);
      oldRow = this._rows.find((r) => (r as ResultOne & { id: IDType }).id === id);
    }
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
