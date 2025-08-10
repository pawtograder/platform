"use client";

import { OfficeHoursRealTimeController } from "@/lib/OfficeHoursRealTimeController";
import TableController from "@/lib/TableController";
import { createClient } from "@/utils/supabase/client";
import { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import {
  HelpQueue,
  HelpQueueAssignment,
  HelpRequest,
  HelpRequestFeedback,
  HelpRequestMessage,
  HelpRequestMessageReadReceipt,
  HelpRequestMessageWithoutId,
  HelpRequestModeration,
  HelpRequestStudent,
  HelpRequestTemplate,
  StudentHelpActivity,
  StudentKarmaNotes
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Spinner } from "@chakra-ui/react";
import { createLogger } from "@/lib/DebugLogger";

const log = createLogger("OfficeHoursControllerProvider");

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

  // Track read receipts that have been marked to prevent duplicates across component mounts
  private _markedAsReadSet: Set<number> = new Set();

  // TableControllers for all tables
  readonly helpRequestMessages: TableController<"help_request_messages">;
  readonly helpRequestReadReceipts: TableController<"help_request_message_read_receipts">;
  readonly helpRequests: TableController<"help_requests">;
  readonly helpQueues: TableController<"help_queues">;
  readonly helpRequestStudents: TableController<"help_request_students">;
  readonly helpQueueAssignments: TableController<"help_queue_assignments">;
  readonly studentKarmaNotes: TableController<"student_karma_notes">;
  readonly helpRequestTemplates: TableController<"help_request_templates">;
  readonly helpRequestModeration: TableController<"help_request_moderation">;
  readonly studentHelpActivity: TableController<"student_help_activity">;
  readonly helpRequestFeedback: TableController<"help_request_feedback">;
  readonly helpRequestFileReferences: TableController<"help_request_file_references">;
  readonly videoMeetingSessions: TableController<"video_meeting_sessions">;

  constructor(
    public classId: number,
    client: SupabaseClient<Database>,
    officeHoursRealTimeController: OfficeHoursRealTimeController
  ) {
    this._officeHoursRealTimeController = officeHoursRealTimeController;

    //TODO: Should be in a separate hook dependent on the help request id, just use-memo it there.
    this.helpRequestMessages = new TableController({
      client,
      table: "help_request_messages",
      query: client.from("help_request_messages").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    //TODO: Should be just for the current user, right?
    this.helpRequestReadReceipts = new TableController({
      client,
      table: "help_request_message_read_receipts",
      query: client.from("help_request_message_read_receipts").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.helpRequests = new TableController({
      client,
      table: "help_requests",
      query: client.from("help_requests").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.helpQueues = new TableController({
      client,
      table: "help_queues",
      query: client.from("help_queues").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.helpRequestStudents = new TableController({
      client,
      table: "help_request_students",
      query: client.from("help_request_students").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.helpQueueAssignments = new TableController({
      client,
      table: "help_queue_assignments",
      query: client.from("help_queue_assignments").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.studentKarmaNotes = new TableController({
      client,
      table: "student_karma_notes",
      query: client.from("student_karma_notes").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.helpRequestTemplates = new TableController({
      client,
      table: "help_request_templates",
      query: client.from("help_request_templates").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.helpRequestModeration = new TableController({
      client,
      table: "help_request_moderation",
      query: client.from("help_request_moderation").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.studentHelpActivity = new TableController({
      client,
      table: "student_help_activity",
      query: client.from("student_help_activity").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.helpRequestFeedback = new TableController({
      client,
      table: "help_request_feedback",
      query: client.from("help_request_feedback").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.helpRequestFileReferences = new TableController({
      client,
      table: "help_request_file_references",
      query: client.from("help_request_file_references").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    this.videoMeetingSessions = new TableController({
      client,
      table: "video_meeting_sessions",
      query: client.from("video_meeting_sessions").select("*").eq("class_id", classId),
      officeHoursRealTimeController
    });

    // Subscribe to broadcast messages and integrate with remaining data maps
    this._broadcastUnsubscribe = this._officeHoursRealTimeController.subscribe(
      {}, // Subscribe to all messages from any active channel
      (message) => {
        this._handleBroadcastMessage(message as DatabaseBroadcastMessage);
      }
    );
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

    // Close all TableControllers
    this.helpRequestMessages.close();
    this.helpRequestReadReceipts.close();
    this.helpRequests.close();
    this.helpQueues.close();
    this.helpRequestStudents.close();
    this.helpQueueAssignments.close();
    this.studentKarmaNotes.close();
    this.helpRequestTemplates.close();
    this.helpRequestModeration.close();
    this.studentHelpActivity.close();
    this.helpRequestFeedback.close();
    this.helpRequestFileReferences.close();
    this.videoMeetingSessions.close();

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
  const client = createClient();
  const [officeHoursRealTimeController, setOfficeHoursRealTimeController] =
    useState<OfficeHoursRealTimeController | null>(null);
  useEffect(() => {
    log.info("mount", { classId, profileId, role });
    const rtc = new OfficeHoursRealTimeController({
      client,
      classId,
      profileId,
      isStaff: role === "instructor" || role === "grader"
    });
    setOfficeHoursRealTimeController(rtc);
    void rtc.start();
  }, [client, classId, profileId, role]);

  // Initialize controller with required dependencies
  if (!controller.current && officeHoursRealTimeController) {
    log.info("construct OfficeHoursController");
    controller.current = new OfficeHoursController(classId, client, officeHoursRealTimeController);
  }

  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (controller.current) {
        log.warn("cleanup (provider unmount)", { classId });
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
    const { data, unsubscribe } = controller.helpRequestMessages.list((data) => {
      const filteredData = data.filter((msg) => msg.help_request_id === help_request_id);
      setMessages(filteredData);
    });
    const filteredData = data.filter((msg) => msg.help_request_id === help_request_id);
    setMessages(filteredData);
    return unsubscribe;
  }, [controller, help_request_id]);
  return messages;
}

export function useHelpRequestReadReceipts() {
  const controller = useOfficeHoursController();
  const [receipts, setReceipts] = useState<HelpRequestMessageReadReceipt[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.helpRequestReadReceipts.list((data) => {
      setReceipts(data);
    });
    setReceipts(data);
    return unsubscribe;
  }, [controller]);
  return receipts;
}

export function useHelpRequests() {
  const controller = useOfficeHoursController();
  const [requests, setRequests] = useState<HelpRequest[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.helpRequests.list((data) => {
      setRequests(data);
    });
    setRequests(data);
    return unsubscribe;
  }, [controller]);
  return requests;
}

export function useHelpRequest(id: number | undefined) {
  const controller = useOfficeHoursController();
  const [request, setRequest] = useState<HelpRequest | undefined>(undefined);
  useEffect(() => {
    if (!id) {
      return;
    }
    const { data, unsubscribe } = controller.helpRequests.getById(id, (data) => {
      setRequest(data);
    });
    setRequest(data);
    return unsubscribe;
  }, [controller, id]);
  return request;
}

export function useHelpQueue(id: number | undefined) {
  const controller = useOfficeHoursController();
  const [queue, setQueue] = useState<HelpQueue | undefined>(id ? controller.helpQueues.getById(id)?.data : undefined);
  useEffect(() => {
    if (!id) {
      return;
    }
    const { data, unsubscribe } = controller.helpQueues.getById(id, (data) => {
      setQueue(data);
    });
    setQueue(data);
    return unsubscribe;
  }, [controller, id]);
  return queue;
}
export function useHelpQueues() {
  const controller = useOfficeHoursController();
  const [queues, setQueues] = useState<HelpQueue[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.helpQueues.list((data) => {
      setQueues(data);
    });
    setQueues(data);
    return unsubscribe;
  }, [controller]);
  return queues;
}

export function useHelpRequestStudents() {
  const controller = useOfficeHoursController();
  const [students, setStudents] = useState<HelpRequestStudent[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.helpRequestStudents.list((data) => {
      setStudents(data);
    });
    setStudents(data);
    return unsubscribe;
  }, [controller]);
  return students;
}

export function useHelpQueueAssignments() {
  const controller = useOfficeHoursController();
  const [assignments, setAssignments] = useState<HelpQueueAssignment[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.helpQueueAssignments.list((data) => {
      setAssignments(data);
    });
    setAssignments(data);
    return unsubscribe;
  }, [controller]);
  return assignments;
}

export function useStudentKarmaNotes() {
  const controller = useOfficeHoursController();
  const [karmaNotes, setKarmaNotes] = useState<StudentKarmaNotes[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.studentKarmaNotes.list((data) => {
      setKarmaNotes(data);
    });
    setKarmaNotes(data);
    return unsubscribe;
  }, [controller]);
  return karmaNotes;
}

export function useHelpRequestTemplates() {
  const controller = useOfficeHoursController();
  const [templates, setTemplates] = useState<HelpRequestTemplate[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.helpRequestTemplates.list((data) => {
      setTemplates(data);
    });
    setTemplates(data);
    return unsubscribe;
  }, [controller]);
  return templates;
}

export function useHelpRequestModeration() {
  const controller = useOfficeHoursController();
  const [moderation, setModeration] = useState<HelpRequestModeration[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.helpRequestModeration.list((data) => {
      setModeration(data);
    });
    setModeration(data);
    return unsubscribe;
  }, [controller]);
  return moderation;
}

export function useStudentHelpActivity() {
  const controller = useOfficeHoursController();
  const [activity, setActivity] = useState<StudentHelpActivity[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.studentHelpActivity.list((data) => {
      setActivity(data);
    });
    setActivity(data);
    return unsubscribe;
  }, [controller]);
  return activity;
}

export function useHelpRequestFeedback() {
  const controller = useOfficeHoursController();
  const [feedback, setFeedback] = useState<HelpRequestFeedback[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.helpRequestFeedback.list((data) => {
      setFeedback(data);
    });
    setFeedback(data);
    return unsubscribe;
  }, [controller]);
  return feedback;
}
export { useConnectionStatus } from "./useConnectionStatus";
export { useHelpRequestFileReferences } from "./useHelpRequestFileReferences";
export { useRealtimeChat } from "./useRealtimeChat";
