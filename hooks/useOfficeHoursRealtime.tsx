"use client";

import { OfficeHoursRealTimeController } from "@/lib/OfficeHoursRealTimeController";
import TableController, { useTableControllerTableValues, useTableControllerValueById } from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import {
  HelpRequestMessage,
  HelpRequestMessageReadReceipt,
  HelpRequestMessageWithoutId
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Spinner } from "@chakra-ui/react";
import { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useCourseController } from "./useCourseController";
import { ClassRealTimeController } from "@/lib/ClassRealTimeController";

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

  // Track which help request IDs have had their messages loaded
  private _loadedHelpRequestIds: Set<number> = new Set();

  // Map of help request ID to their dedicated message TableController
  private _helpRequestMessageControllers: Map<number, TableController<"help_request_messages">> = new Map();
  // Map of help request ID to their dedicated read receipts TableController
  private _helpRequestReadReceiptControllers: Map<number, TableController<"help_request_message_read_receipts">> =
    new Map();

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
   * Initialize critical TableControllers immediately after construction
   * This creates them eagerly but in a controlled manner after realtime controllers are stable
   */
  initializeEagerControllers() {
    // These are accessed frequently and should be ready
    void this.helpRequests; // Triggers lazy creation
    void this.helpQueues; // Triggers lazy creation
    void this.helpRequestTemplates; // Triggers lazy creation
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

  /**
   * Load messages for a specific help request if not already loaded
   */
  loadMessagesForHelpRequest(helpRequestId: number): TableController<"help_request_messages"> {
    // Return existing controller if already loaded
    if (this._helpRequestMessageControllers.has(helpRequestId)) {
      return this._helpRequestMessageControllers.get(helpRequestId)!;
    }

    // Create new TableController for this specific help request
    const controller = new TableController({
      client: this._client,
      table: "help_request_messages",
      query: this._client
        .from("help_request_messages")
        .select("*")
        .eq("class_id", this.classId)
        .eq("help_request_id", helpRequestId),
      additionalRealTimeControllers: this._officeHoursRealTimeController ? [this._officeHoursRealTimeController] : [],
      realtimeFilter: {
        class_id: this.classId,
        help_request_id: helpRequestId
      }
    });

    this._helpRequestMessageControllers.set(helpRequestId, controller);
    this._loadedHelpRequestIds.add(helpRequestId);

    return controller;
  }

  /**
   * Load read receipts for a specific help request if not already loaded
   */
  loadReadReceiptsForHelpRequest(helpRequestId: number): TableController<"help_request_message_read_receipts"> {
    if (this._helpRequestReadReceiptControllers.has(helpRequestId)) {
      return this._helpRequestReadReceiptControllers.get(helpRequestId)!;
    }

    const controller = new TableController({
      client: this._client,
      table: "help_request_message_read_receipts",
      query: this._client
        .from("help_request_message_read_receipts")
        .select("*")
        .eq("class_id", this.classId)
        .eq("help_request_id", helpRequestId),
      additionalRealTimeControllers: this._officeHoursRealTimeController ? [this._officeHoursRealTimeController] : []
    });

    this._helpRequestReadReceiptControllers.set(helpRequestId, controller);
    return controller;
  }

  /**
   * Get the TableController for a specific help request's messages
   */
  getHelpRequestMessagesController(helpRequestId: number): TableController<"help_request_messages"> | undefined {
    return this._helpRequestMessageControllers.get(helpRequestId);
  }

  /**
   * Check if messages for a help request have been loaded
   */
  isHelpRequestLoaded(helpRequestId: number): boolean {
    return this._loadedHelpRequestIds.has(helpRequestId);
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

    // Close per-help-request message controllers
    for (const controller of this._helpRequestMessageControllers.values()) {
      controller.close();
    }
    this._helpRequestMessageControllers.clear();

    // Close per-help-request read receipt controllers
    for (const controller of this._helpRequestReadReceiptControllers.values()) {
      controller.close();
    }
    this._helpRequestReadReceiptControllers.clear();

    this._markedAsReadSet.clear();
    this._loadedHelpRequestIds.clear();
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
  const client = createClient();
  const { classRealTimeController } = useCourseController();
  const [officeHoursRealTimeController, setOfficeHoursRealTimeController] =
    useState<OfficeHoursRealTimeController | null>(null);
  useEffect(() => {
    setOfficeHoursRealTimeController(
      new OfficeHoursRealTimeController({
        client,
        classId,
        profileId,
        isStaff: role === "instructor" || role === "grader"
      })
    );
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

// Hook functions following the pattern from useCourseController
export function useHelpRequestMessages(help_request_id: number | undefined) {
  const controller = useOfficeHoursController();
  const [messages, setMessages] = useState<HelpRequestMessage[]>([]);

  useEffect(() => {
    if (!help_request_id) {
      setMessages([]);
      return;
    }

    // Load messages for this help request if not already loaded
    const helpRequestController = controller.loadMessagesForHelpRequest(help_request_id);

    // Subscribe to updates for this specific help request
    const { data, unsubscribe } = helpRequestController.list((data) => {
      setMessages(data);
    });

    // Set initial data
    setMessages(data);

    return unsubscribe;
  }, [controller, help_request_id]);

  return messages;
}

export function useHelpRequestReadReceipts(help_request_id: number | undefined) {
  const controller = useOfficeHoursController();
  const [receipts, setReceipts] = useState<HelpRequestMessageReadReceipt[]>([]);
  useEffect(() => {
    if (!help_request_id) {
      setReceipts([]);
      return;
    }

    const readReceiptsController = controller.loadReadReceiptsForHelpRequest(help_request_id);
    const { data, unsubscribe } = readReceiptsController.list((data) => {
      setReceipts(data);
    });
    setReceipts(data);
    return unsubscribe;
  }, [controller, help_request_id]);
  return receipts;
}

export function useHelpRequests() {
  const controller = useOfficeHoursController();
  return useTableControllerTableValues(controller.helpRequests);
}

export function useHelpRequest(id: number | undefined) {
  const controller = useOfficeHoursController();
  return useTableControllerValueById(controller.helpRequests, id);
}

export function useHelpQueue(id: number | undefined) {
  const controller = useOfficeHoursController();
  return useTableControllerValueById(controller.helpQueues, id);
}
export function useHelpQueues() {
  const controller = useOfficeHoursController();
  return useTableControllerTableValues(controller.helpQueues);
}

export function useHelpRequestStudents() {
  const controller = useOfficeHoursController();
  return useTableControllerTableValues(controller.helpRequestStudents);
}

export function useHelpQueueAssignments() {
  const controller = useOfficeHoursController();
  return useTableControllerTableValues(controller.helpQueueAssignments);
}

export function useStudentKarmaNotes() {
  const controller = useOfficeHoursController();
  return useTableControllerTableValues(controller.studentKarmaNotes);
}

export function useHelpRequestTemplates() {
  const controller = useOfficeHoursController();
  return useTableControllerTableValues(controller.helpRequestTemplates);
}

export function useHelpRequestModeration() {
  const controller = useOfficeHoursController();
  return useTableControllerTableValues(controller.helpRequestModeration);
}

export function useStudentHelpActivity() {
  const controller = useOfficeHoursController();
  return useTableControllerTableValues(controller.studentHelpActivity);
}

export function useHelpRequestFeedback() {
  const controller = useOfficeHoursController();
  return useTableControllerTableValues(controller.helpRequestFeedback);
}
export { useConnectionStatus } from "./useConnectionStatus";
export { useHelpRequestFileReferences } from "./useHelpRequestFileReferences";
export { useRealtimeChat } from "./useRealtimeChat";
