"use client";

import { OfficeHoursRealTimeController } from "@/lib/OfficeHoursRealTimeController";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { HelpRequestMessageReadReceipt, HelpRequestMessageWithoutId } from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Spinner } from "@chakra-ui/react";
import { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useCourseController } from "./useCourseController";
import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
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

// Type for broadcast messages from the database trigger
type DatabaseBroadcastMessage = {
  type: "table_change" | "staff_data_change" | "queue_change" | "channel_created" | "system";
  operation?: "INSERT" | "UPDATE" | "DELETE";
  table?: string;
  row_id?: number | string;
  data?: Record<string, unknown>;
  help_request_id?: number;
  help_queue_id?: number;
  class_id: number;
  student_profile_id?: string;
  timestamp: string;
};

// Re-export chat message type for compatibility
export type ChatMessage = HelpRequestMessageWithoutId & {
  id: number | null;
  read_receipts?: HelpRequestMessageReadReceipt[];
};

export type UpdateCallback<T> = (data: T) => void;
export type Unsubscribe = () => void;

export class OfficeHoursController {
  private _isLoaded = false;
  private _officeHoursRealTimeController: OfficeHoursRealTimeController | null = null;
  private _broadcastUnsubscribe: (() => void) | null = null;
  private _client: SupabaseClient<Database>;

  // Track read receipts that have been marked to prevent duplicates across component mounts
  private _markedAsReadSet: Set<number> = new Set();

  // Per-request Maps removed — TanStack Query hooks with gcTime handle lifecycle automatically.

  // Lazily created TableController instances to avoid realtime subscription bursts
  private _helpRequests?: TableController<"help_requests">;
  private _helpQueues?: TableController<"help_queues">;
  private _helpRequestStudents?: TableController<"help_request_students">;
  private _helpQueueAssignments?: TableController<"help_queue_assignments">;
  private _studentKarmaNotes?: TableController<"student_karma_notes">;
  private _helpRequestTemplates?: TableController<"help_request_templates">;
  private _helpRequestModeration?: TableController<"help_request_moderation">;
  private _studentHelpActivity?: TableController<"student_help_activity">;
  private _helpRequestFeedback?: TableController<"help_request_feedback">;
  private _helpRequestFileReferences?: TableController<"help_request_file_references">;
  private _videoMeetingSessions?: TableController<"video_meeting_sessions">;
  private _helpRequestWorkSessions?: TableController<"help_request_work_sessions">;

  private _classRealTimeController: ClassRealTimeController;

  constructor(
    public classId: number,
    client: SupabaseClient<Database>,
    classRealTimeController: ClassRealTimeController,
    officeHoursRealTimeController: OfficeHoursRealTimeController
  ) {
    this._client = client;
    this._classRealTimeController = classRealTimeController;
    this._officeHoursRealTimeController = officeHoursRealTimeController;

    // Subscribe to broadcast messages and integrate with remaining data maps
    this._broadcastUnsubscribe = this._officeHoursRealTimeController.subscribe(
      {}, // Subscribe to all messages from any active channel
      (message) => {
        this._handleBroadcastMessage(message as DatabaseBroadcastMessage);
      }
    );
  }

  /**
   * No-op. TableControllers are no longer needed -- data flows through TanStack Query hooks.
   * Lazy getters are retained for backward compatibility but are no longer eagerly triggered.
   */
  initializeEagerControllers() {
    // TableControllers are no longer needed — data flows through TanStack Query hooks.
    // Lazy getters are retained for backward compatibility but are no longer eagerly triggered.
  }

  // Lazy getters for TableControllers
  get helpRequests(): TableController<"help_requests"> {
    if (!this._helpRequests) {
      this._helpRequests = new TableController({
        client: this._client,
        table: "help_requests",
        query: this._client.from("help_requests").select("*").eq("class_id", this.classId),
        classRealTimeController: this._classRealTimeController,
        realtimeFilter: {
          class_id: this.classId
        },
        debounceInterval: 0
      });
    }
    return this._helpRequests;
  }

  get helpQueues(): TableController<"help_queues"> {
    if (!this._helpQueues) {
      this._helpQueues = new TableController({
        client: this._client,
        table: "help_queues",
        query: this._client.from("help_queues").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController],
        realtimeFilter: {
          class_id: this.classId
        }
      });
    }
    return this._helpQueues;
  }

  get helpRequestStudents(): TableController<"help_request_students"> {
    if (!this._helpRequestStudents) {
      this._helpRequestStudents = new TableController({
        client: this._client,
        table: "help_request_students",
        query: this._client.from("help_request_students").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController],
        realtimeFilter: {
          class_id: this.classId
        }
      });
    }
    return this._helpRequestStudents;
  }

  get helpQueueAssignments(): TableController<"help_queue_assignments"> {
    if (!this._helpQueueAssignments) {
      this._helpQueueAssignments = new TableController({
        client: this._client,
        table: "help_queue_assignments",
        query: this._client.from("help_queue_assignments").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController],
        realtimeFilter: {
          class_id: this.classId
        }
      });
    }
    return this._helpQueueAssignments;
  }

  get studentKarmaNotes(): TableController<"student_karma_notes"> {
    if (!this._studentKarmaNotes) {
      this._studentKarmaNotes = new TableController({
        client: this._client,
        table: "student_karma_notes",
        query: this._client.from("student_karma_notes").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController]
      });
    }
    return this._studentKarmaNotes;
  }

  get helpRequestTemplates(): TableController<"help_request_templates"> {
    if (!this._helpRequestTemplates) {
      this._helpRequestTemplates = new TableController({
        client: this._client,
        table: "help_request_templates",
        query: this._client.from("help_request_templates").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController],
        realtimeFilter: {
          class_id: this.classId
        }
      });
    }
    return this._helpRequestTemplates;
  }

  get helpRequestModeration(): TableController<"help_request_moderation"> {
    if (!this._helpRequestModeration) {
      this._helpRequestModeration = new TableController({
        client: this._client,
        table: "help_request_moderation",
        query: this._client.from("help_request_moderation").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController]
      });
    }
    return this._helpRequestModeration;
  }

  get studentHelpActivity(): TableController<"student_help_activity"> {
    if (!this._studentHelpActivity) {
      this._studentHelpActivity = new TableController({
        client: this._client,
        table: "student_help_activity",
        query: this._client.from("student_help_activity").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController]
      });
    }
    return this._studentHelpActivity;
  }

  get helpRequestFeedback(): TableController<"help_request_feedback"> {
    if (!this._helpRequestFeedback) {
      this._helpRequestFeedback = new TableController({
        client: this._client,
        table: "help_request_feedback",
        query: this._client.from("help_request_feedback").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController]
      });
    }
    return this._helpRequestFeedback;
  }

  get helpRequestFileReferences(): TableController<"help_request_file_references"> {
    if (!this._helpRequestFileReferences) {
      this._helpRequestFileReferences = new TableController({
        client: this._client,
        table: "help_request_file_references",
        query: this._client.from("help_request_file_references").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController],
        realtimeFilter: {
          class_id: this.classId
        }
      });
    }
    return this._helpRequestFileReferences;
  }

  get videoMeetingSessions(): TableController<"video_meeting_sessions"> {
    if (!this._videoMeetingSessions) {
      this._videoMeetingSessions = new TableController({
        client: this._client,
        table: "video_meeting_sessions",
        query: this._client.from("video_meeting_sessions").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController],
        realtimeFilter: {
          class_id: this.classId
        }
      });
    }
    return this._videoMeetingSessions;
  }

  get helpRequestWorkSessions(): TableController<"help_request_work_sessions"> {
    if (!this._helpRequestWorkSessions) {
      this._helpRequestWorkSessions = new TableController({
        client: this._client,
        table: "help_request_work_sessions",
        query: this._client.from("help_request_work_sessions").select("*").eq("class_id", this.classId),
        additionalRealTimeControllers: [this.officeHoursRealTimeController],
        realtimeFilter: {
          class_id: this.classId
        }
      });
    }
    return this._helpRequestWorkSessions;
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
   * Handle broadcast messages from OfficeHoursRealTimeController and update data maps
   */
  private _handleBroadcastMessage(message: DatabaseBroadcastMessage) {
    if (message.type !== "table_change" || !message.table || !message.operation || !message.data) {
      return;
    }
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

  // loadMessagesForHelpRequest removed — replaced by useHelpRequestMessagesQuery() from office-hours-data

  // loadReadReceiptsForHelpRequest removed — replaced by useHelpRequestReadReceiptsQuery() from office-hours-data

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

    // Close all TableControllers (only if they were created)
    this._helpRequests?.close();
    this._helpQueues?.close();
    this._helpRequestStudents?.close();
    this._helpQueueAssignments?.close();
    this._studentKarmaNotes?.close();
    this._helpRequestTemplates?.close();
    this._helpRequestModeration?.close();
    this._studentHelpActivity?.close();
    this._helpRequestFeedback?.close();
    this._helpRequestFileReferences?.close();
    this._videoMeetingSessions?.close();
    this._helpRequestWorkSessions?.close();

    this._markedAsReadSet.clear();
  }

  get isLoaded() {
    return this._isLoaded;
  }
}

function OfficeHoursControllerProviderImpl() {
  // All data is now automatically loaded and managed by TableControllers in the constructor
  return <></>;
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
  // Memoize client to prevent recreating on every render
  const clientRef = useRef<SupabaseClient<Database> | null>(null);
  if (!clientRef.current) {
    clientRef.current = createClient();
  }
  const client = clientRef.current;
  const { classRealTimeController } = useCourseController();
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
    controller.current = new OfficeHoursController(
      classId,
      client,
      classRealTimeController,
      officeHoursRealTimeController
    );
    // Initialize the critical controllers now that everything is stable
    controller.current.initializeEagerControllers();
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
    <OfficeHoursControllerContext.Provider value={controller.current}>
      <OfficeHoursControllerProviderImpl />
      {children}
    </OfficeHoursControllerContext.Provider>
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
