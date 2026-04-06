"use client";

import { OfficeHoursRealTimeController } from "@/lib/OfficeHoursRealTimeController";
import { createClient } from "@/utils/supabase/client";
import { HelpRequestMessageReadReceipt, HelpRequestMessageWithoutId } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Spinner } from "@chakra-ui/react";
import { SupabaseClient } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useCourseController } from "./useCourseController";
import {
  useHelpRequestsQuery,
  useHelpQueuesQuery,
  useHelpRequestStudentsQuery,
  useHelpQueueAssignmentsQuery,
  useStudentKarmaNotesQuery,
  useHelpRequestTemplatesQuery,
  useHelpRequestModerationQuery,
  useStudentHelpActivityQuery,
  useHelpRequestFeedbackQuery,
  useHelpRequestWorkSessionsQuery
} from "./office-hours-data";

// Re-export chat message type for compatibility
export type ChatMessage = HelpRequestMessageWithoutId & {
  id: number | null;
  read_receipts?: HelpRequestMessageReadReceipt[];
};

export type UpdateCallback<T> = (data: T) => void;
export type Unsubscribe = () => void;

/**
 * Lightweight adapter providing the same mutation API as the old
 * TableController-based shims.  No realtime subscriptions;
 * data flows through TanStack Query hooks.
 */
function makeOHTableShim<TableName extends keyof Database["public"]["Tables"]>(
  client: SupabaseClient<Database>,
  table: TableName,
  queryKey: readonly unknown[]
) {
  type Row = Database["public"]["Tables"][TableName]["Row"];
  type Insert = Database["public"]["Tables"][TableName]["Insert"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = client as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let _queryClient: any = null;

  return {
    _setQueryClient(qc: unknown) {
      _queryClient = qc;
    },
    async create(row: Insert): Promise<Row> {
      const { data, error } = await db.from(table).insert(row).select("*").single();
      if (error) throw error;
      _queryClient?.invalidateQueries?.({ queryKey });
      return data as Row;
    },
    async update(id: number | string, values: Partial<Row>): Promise<Row> {
      const { data, error } = await db.from(table).update(values).eq("id", id).select("*").single();
      if (error) throw error;
      _queryClient?.invalidateQueries?.({ queryKey });
      return data as Row;
    },
    async delete(id: number | string): Promise<void> {
      const { error } = await db.from(table).update({ deleted_at: new Date().toISOString() }).eq("id", id);
      if (error) throw error;
      _queryClient?.invalidateQueries?.({ queryKey });
    },
    async invalidate(): Promise<void> {
      _queryClient?.invalidateQueries?.({ queryKey });
    },
    async refetchAll(): Promise<void> {
      _queryClient?.invalidateQueries?.({ queryKey });
    },
    readyPromise: Promise.resolve()
  };
}

type OHTableShim<T extends keyof Database["public"]["Tables"]> = ReturnType<typeof makeOHTableShim<T>>;

/**
 * Lightweight controller that holds the OfficeHoursRealTimeController and
 * a few non-data utilities (message read tracking, connection status).
 * All data queries are handled by TanStack Query hooks in office-hours-data/.
 * Table shims provide create/update/delete for consumers that still call
 * controller.helpQueues.create(...) etc.
 */
export class OfficeHoursController {
  private _officeHoursRealTimeController: OfficeHoursRealTimeController | null = null;
  private _broadcastUnsubscribe: (() => void) | null = null;

  // Track read receipts that have been marked to prevent duplicates across component mounts
  private _markedAsReadSet: Set<number> = new Set();

  // Table shims (same API surface as old TableController getters)
  readonly helpRequests: OHTableShim<"help_requests">;
  readonly helpQueues: OHTableShim<"help_queues">;
  readonly helpRequestStudents: OHTableShim<"help_request_students">;
  readonly helpQueueAssignments: OHTableShim<"help_queue_assignments">;
  readonly studentKarmaNotes: OHTableShim<"student_karma_notes">;
  readonly helpRequestTemplates: OHTableShim<"help_request_templates">;
  readonly helpRequestModeration: OHTableShim<"help_request_moderation">;
  readonly studentHelpActivity: OHTableShim<"student_help_activity">;
  readonly helpRequestFeedback: OHTableShim<"help_request_feedback">;
  readonly helpRequestFileReferences: OHTableShim<"help_request_file_references">;
  readonly videoMeetingSessions: OHTableShim<"video_meeting_sessions">;
  readonly helpRequestWorkSessions: OHTableShim<"help_request_work_sessions">;

  constructor(
    public classId: number,
    client: SupabaseClient<Database>,
    officeHoursRealTimeController: OfficeHoursRealTimeController
  ) {
    this._officeHoursRealTimeController = officeHoursRealTimeController;

    const cid = classId;
    this.helpRequests = makeOHTableShim(client, "help_requests", ["office_hours", cid, "help_requests"]);
    this.helpQueues = makeOHTableShim(client, "help_queues", ["office_hours", cid, "help_queues"]);
    this.helpRequestStudents = makeOHTableShim(client, "help_request_students", [
      "office_hours",
      cid,
      "help_request_students"
    ]);
    this.helpQueueAssignments = makeOHTableShim(client, "help_queue_assignments", [
      "office_hours",
      cid,
      "help_queue_assignments"
    ]);
    this.studentKarmaNotes = makeOHTableShim(client, "student_karma_notes", [
      "office_hours",
      cid,
      "student_karma_notes"
    ]);
    this.helpRequestTemplates = makeOHTableShim(client, "help_request_templates", [
      "office_hours",
      cid,
      "help_request_templates"
    ]);
    this.helpRequestModeration = makeOHTableShim(client, "help_request_moderation", [
      "office_hours",
      cid,
      "help_request_moderation"
    ]);
    this.studentHelpActivity = makeOHTableShim(client, "student_help_activity", [
      "office_hours",
      cid,
      "student_help_activity"
    ]);
    this.helpRequestFeedback = makeOHTableShim(client, "help_request_feedback", [
      "office_hours",
      cid,
      "help_request_feedback"
    ]);
    this.helpRequestFileReferences = makeOHTableShim(client, "help_request_file_references", [
      "office_hours",
      cid,
      "help_request_file_references"
    ]);
    this.videoMeetingSessions = makeOHTableShim(client, "video_meeting_sessions", [
      "office_hours",
      cid,
      "video_meeting_sessions"
    ]);
    this.helpRequestWorkSessions = makeOHTableShim(client, "help_request_work_sessions", [
      "office_hours",
      cid,
      "help_request_work_sessions"
    ]);
  }

  /** Inject the QueryClient so shims can invalidate TanStack caches. */
  _setQueryClient(qc: unknown) {
    this.helpRequests._setQueryClient(qc);
    this.helpQueues._setQueryClient(qc);
    this.helpRequestStudents._setQueryClient(qc);
    this.helpQueueAssignments._setQueryClient(qc);
    this.studentKarmaNotes._setQueryClient(qc);
    this.helpRequestTemplates._setQueryClient(qc);
    this.helpRequestModeration._setQueryClient(qc);
    this.studentHelpActivity._setQueryClient(qc);
    this.helpRequestFeedback._setQueryClient(qc);
    this.helpRequestFileReferences._setQueryClient(qc);
    this.videoMeetingSessions._setQueryClient(qc);
    this.helpRequestWorkSessions._setQueryClient(qc);
  }

  set officeHoursRealTimeController(officeHoursRealTimeController: OfficeHoursRealTimeController) {
    this._officeHoursRealTimeController = officeHoursRealTimeController;
  }

  get officeHoursRealTimeController(): OfficeHoursRealTimeController {
    if (!this._officeHoursRealTimeController) {
      throw new Error("OfficeHoursRealTimeController not initialized.");
    }
    return this._officeHoursRealTimeController;
  }

  /**
   * Mark a message as read to prevent duplicate API calls
   */
  markMessageAsRead(messageId: number): boolean {
    if (this._markedAsReadSet.has(messageId)) {
      return false; // Already marked
    }
    this._markedAsReadSet.add(messageId);
    return true; // Newly marked
  }

  /**
   * Check if a message has been marked as read
   */
  isMessageMarkedAsRead(messageId: number): boolean {
    return this._markedAsReadSet.has(messageId);
  }

  /**
   * Clear marked as read state (useful for testing or manual resets)
   */
  clearMarkedAsReadState(): void {
    this._markedAsReadSet.clear();
  }

  /**
   * Get connection status from the real-time controller
   */
  getConnectionStatus() {
    if (!this._officeHoursRealTimeController) {
      return {
        overall: "disconnected" as const,
        channels: [],
        lastUpdate: new Date()
      };
    }
    return this._officeHoursRealTimeController.getConnectionStatus();
  }

  /**
   * Check if the real-time controller is ready
   */
  get isReady(): boolean {
    return this._officeHoursRealTimeController?.isReady ?? false;
  }

  /**
   * Close the controller and clean up resources
   */
  close(): void {
    if (this._broadcastUnsubscribe) {
      this._broadcastUnsubscribe();
      this._broadcastUnsubscribe = null;
    }

    if (this._officeHoursRealTimeController) {
      this._officeHoursRealTimeController.close();
      this._officeHoursRealTimeController = null;
    }

    this._markedAsReadSet.clear();
  }
}

const OfficeHoursControllerContext = createContext<OfficeHoursController | null>(null);

export function OfficeHoursControllerProvider({
  classId,
  profileId,
  role,
  children
}: {
  classId: number;
  profileId: string;
  role: Database["public"]["Enums"]["app_role"];
  children: React.ReactNode;
}) {
  const controller = useRef<OfficeHoursController | null>(null);
  const queryClient = useQueryClient();
  // Memoize client to prevent recreating on every render
  const clientRef = useRef<SupabaseClient<Database> | null>(null);
  if (!clientRef.current) {
    clientRef.current = createClient();
  }
  const client = clientRef.current;
  const [officeHoursRealTimeController, setOfficeHoursRealTimeController] =
    useState<OfficeHoursRealTimeController | null>(null);
  useEffect(() => {
    const newController = new OfficeHoursRealTimeController({
      client,
      classId,
      profileId,
      isStaff: role === "instructor" || role === "grader"
    });
    setOfficeHoursRealTimeController(newController);

    // Cleanup: close the controller when deps change or on unmount
    return () => {
      newController.close();
    };
  }, [client, classId, profileId, role]);

  // Initialize controller with required dependencies
  if (!controller.current && officeHoursRealTimeController) {
    controller.current = new OfficeHoursController(classId, client, officeHoursRealTimeController);
  }

  // Keep QueryClient injected on every render (stable across renders but ensures availability)
  if (controller.current) {
    controller.current._setQueryClient(queryClient);
  }

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (controller.current) {
        controller.current.close();
        controller.current = null;
      }
    };
  }, []);

  if (!controller.current) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100vh">
        <Spinner />
      </Box>
    );
  }
  return (
    <OfficeHoursControllerContext.Provider value={controller.current}>{children}</OfficeHoursControllerContext.Provider>
  );
}

export function useOfficeHoursController() {
  const controller = useContext(OfficeHoursControllerContext);
  if (!controller) {
    throw new Error("OfficeHoursController not found. Must be used within OfficeHoursControllerProvider.");
  }
  return controller;
}

// useHelpRequestMessages and useHelpRequestReadReceipts removed —
// replaced by useHelpRequestMessagesQuery / useHelpRequestReadReceiptsQuery from office-hours-data

export function useHelpRequests() {
  const { data } = useHelpRequestsQuery();
  return data ?? [];
}

export function useHelpRequest(id: number | undefined) {
  const { data } = useHelpRequestsQuery();
  return useMemo(() => data?.find((r) => r.id === id), [data, id]);
}

export function useHelpQueue(id: number | undefined) {
  const { data } = useHelpQueuesQuery();
  return useMemo(() => data?.find((q) => q.id === id), [data, id]);
}
export function useHelpQueues() {
  const { data } = useHelpQueuesQuery();
  return data ?? [];
}

export function useHelpRequestStudents() {
  const { data } = useHelpRequestStudentsQuery();
  return data ?? [];
}

export function useHelpQueueAssignments() {
  const { data } = useHelpQueueAssignmentsQuery();
  return data ?? [];
}

/**
 * Returns only active help queue assignments (is_active === true).
 */
export function useActiveHelpQueueAssignments() {
  const { data } = useHelpQueueAssignmentsQuery();
  return useMemo(() => (data ?? []).filter((a) => a.is_active === true), [data]);
}

export function useStudentKarmaNotes() {
  const { data } = useStudentKarmaNotesQuery();
  return data ?? [];
}

export function useHelpRequestTemplates() {
  const { data } = useHelpRequestTemplatesQuery();
  return data ?? [];
}

export function useHelpRequestModeration() {
  const { data } = useHelpRequestModerationQuery();
  return data ?? [];
}

export function useStudentHelpActivity() {
  const { data } = useStudentHelpActivityQuery();
  return data ?? [];
}

export function useHelpRequestFeedback() {
  const { data } = useHelpRequestFeedbackQuery();
  return data ?? [];
}

export function useHelpRequestWorkSessions() {
  const { data } = useHelpRequestWorkSessionsQuery();
  return data ?? [];
}

export function useWorkSessionsForRequest(help_request_id: number | undefined) {
  const allSessions = useHelpRequestWorkSessions();

  if (!help_request_id || !allSessions) return [];

  return allSessions.filter((session) => session.help_request_id === help_request_id);
}

export { useConnectionStatus } from "./useConnectionStatus";
export { useHelpRequestFileReferences } from "./useHelpRequestFileReferences";
export { useRealtimeChat } from "./useRealtimeChat";
