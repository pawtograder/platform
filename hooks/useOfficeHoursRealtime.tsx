"use client";

import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext } from "react";
import { useCreate } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { OfficeHoursRealTimeController } from "@/lib/OfficeHoursRealTimeController";
import TableController, { BroadcastMessage } from "@/lib/TableController";
import { SupabaseClient } from "@supabase/supabase-js";
import useAuthState from "./useAuthState";
import { useClassProfiles } from "./useClassProfiles";

import {
  HelpRequest,
  HelpRequestMessage,
  HelpRequestMessageWithoutId,
  HelpRequestMessageReadReceipt,
  HelpRequestStudent,
  HelpRequestFileReference,
  HelpRequestModeration,
  HelpRequestTemplate,
  HelpRequestFeedback,
  HelpQueue,
  HelpQueueAssignment,
  StudentKarmaNotes,
  VideoMeetingSession,
  StudentHelpActivity,
  OfficeHoursBroadcastMessage,
  OfficeHoursConnectionStatus
} from "@/utils/supabase/DatabaseTypes";
import { Database } from "@/utils/supabase/SupabaseTypes";
import { Box, Spinner } from "@chakra-ui/react";

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
  const [officeHoursRealTimeController, setOfficeHoursRealTimeController] = useState<OfficeHoursRealTimeController | null>(null);
  useEffect(() => {
    setOfficeHoursRealTimeController(new OfficeHoursRealTimeController({
      client,
      classId,
      profileId,
      isStaff: role === "instructor" || role === "grader"
    }));
  }, [client, classId, profileId, role]);

  // Initialize controller with required dependencies
  if (!controller.current && officeHoursRealTimeController) {
    controller.current = new OfficeHoursController(classId, client, officeHoursRealTimeController);
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
export function useHelpRequestMessages() {
  const controller = useOfficeHoursController();
  const [messages, setMessages] = useState<HelpRequestMessage[]>([]);
  useEffect(() => {
    const { data, unsubscribe } = controller.helpRequestMessages.list((data) => {
      setMessages(data);
    });
    setMessages(data);
    return unsubscribe;
  }, [controller]);
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

/**
 * Props for configuring the office hours realtime hook
 */
export interface UseOfficeHoursRealtimeOptions {
  classId: number;
  profileId?: string;
  isStaff?: boolean;
  /**
   * Specific help request ID to subscribe to (optional)
   */
  helpRequestId?: number;
  /**
   * Specific help queue ID to subscribe to (optional)
   */
  helpQueueId?: number;
  /**
   * Whether to enable staff data subscriptions (moderation/karma)
   */
  enableStaffData?: boolean;
  /**
   * Whether to enable global help queues subscription
   */
  enableGlobalQueues?: boolean;
  /**
   * Whether to fetch only available help queues (available = true)
   */
  onlyAvailableQueues?: boolean;
  /**
   * Whether to fetch only active queue assignments (is_active = true)
   */
  onlyActiveAssignments?: boolean;
  /**
   * Whether to fetch active help requests for the class (status = 'open' or 'in_progress')
   */
  enableActiveRequests?: boolean;
  /**
   * Whether to enable chat functionality (sendMessage, markMessageAsRead)
   */
  enableChat?: boolean;
}

/**
 * Data structure containing all office hours related data
 */
export interface OfficeHoursData {
  // Help Request Data
  helpRequest?: HelpRequest;
  helpRequestMessages: HelpRequestMessage[];
  helpRequestReadReceipts: HelpRequestMessageReadReceipt[];
  helpRequestStudents: HelpRequestStudent[];
  helpRequestFileReferences: HelpRequestFileReference[];
  helpRequestTemplates: HelpRequestTemplate[];
  helpRequestFeedback: HelpRequestFeedback[];

  // Staff Data (only accessible by staff or current user's own data)
  helpRequestModeration: HelpRequestModeration[];
  studentKarmaNotes: StudentKarmaNotes[];

  // Video/Activity Data
  videoMeetingSessions: VideoMeetingSession[];
  studentHelpActivity: StudentHelpActivity[];

  // Help Queue Data
  helpQueue?: HelpQueue;
  helpQueues: HelpQueue[];
  helpQueueAssignments: HelpQueueAssignment[];

  // Active Help Requests Data (for overview pages)
  activeHelpRequests: HelpRequest[];
}

/**
 * Hook return type with all available functionality
 */
export interface UseOfficeHoursRealtimeReturn {
  // Data
  data: OfficeHoursData;

  // Connection status
  connectionStatus: OfficeHoursConnectionStatus | null;
  isConnected: boolean;
  isValidating: boolean;
  isAuthorized: boolean;
  connectionError: string | null;

  // Controller access
  controller: OfficeHoursRealTimeController | null;

  // Subscription helpers
  subscribeToHelpRequest: (
    helpRequestId: number,
    callback: (message: OfficeHoursBroadcastMessage) => void
  ) => () => void;
  subscribeToHelpRequestStaff: (
    helpRequestId: number,
    callback: (message: OfficeHoursBroadcastMessage) => void
  ) => () => void;
  subscribeToHelpQueue: (helpQueueId: number, callback: (message: OfficeHoursBroadcastMessage) => void) => () => void;
  subscribeToAllHelpQueues: (callback: (message: OfficeHoursBroadcastMessage) => void) => () => void;
  subscribeToTable: (tableName: string, callback: (message: OfficeHoursBroadcastMessage) => void) => () => void;

  // Chat functionality (only available when enableChat is true and helpRequestId is provided)
  sendMessage?: (content: string, replyToMessageId?: number | null) => Promise<void>;
  markMessageAsRead?: (messageId: number, messageAuthorId?: string) => Promise<void>;
  readReceipts: HelpRequestMessageReadReceipt[]; // Optimistic read receipts excluding current user

  // Loading states
  isLoading: boolean;
}

/**
 * Legacy hook for backwards compatibility. Prefer using individual hooks and OfficeHoursControllerProvider.
 * New pattern: Use OfficeHoursControllerProvider + individual hooks like useHelpRequestMessages, useHelpQueues, etc.
 * When helpRequestId/helpQueueId are provided, explicitly subscribe to those channels
 * to ensure they exist and are connected. The main controller subscription will still handle
 * the actual message processing, but these subscriptions ensure the channels are active.
 */
export function useOfficeHoursRealtime(options: UseOfficeHoursRealtimeOptions): UseOfficeHoursRealtimeReturn {
  const controller = useOfficeHoursController();

  // Ensure help request channel subscription when helpRequestId is provided.
  // The OfficeHoursController subscribes to all messages with an empty filter {}, but this
  // doesn't trigger channel creation. The database broadcasts read receipts to specific
  // help_request:ID channels, so we must ensure that channel exists and is subscribed to.
  useEffect(() => {
    if (options.helpRequestId) {
      console.log(`[ReadReceiptFix] Subscribing to help request channel for ID: ${options.helpRequestId}`);
      const unsubscribe = controller.officeHoursRealTimeController.subscribeToHelpRequest(
        options.helpRequestId,
        (message) => {
          console.log(`[ReadReceiptFix] Received help request broadcast for ${options.helpRequestId}:`, message);
          // The message will still be handled by the main controller subscription
          // This subscription just ensures the channel exists and is connected
        }
      );

      return unsubscribe;
    }
  }, [controller, options.helpRequestId]);

  // Also ensure help queue channel subscription when helpQueueId is provided
  useEffect(() => {
    if (options.helpQueueId) {
      console.log(`[ReadReceiptFix] Subscribing to help queue channel for ID: ${options.helpQueueId}`);
      const unsubscribe = controller.officeHoursRealTimeController.subscribeToHelpQueue(
        options.helpQueueId,
        (message) => {
          console.log(`[ReadReceiptFix] Received help queue broadcast for ${options.helpQueueId}:`, message);
        }
      );

      return unsubscribe;
    }
  }, [controller, options.helpQueueId]);

  const messages = useHelpRequestMessages();
  const readReceipts = useHelpRequestReadReceipts();
  const students = useHelpRequestStudents();
  const requests = useHelpRequests();
  const queues = useHelpQueues();
  const assignments = useHelpQueueAssignments();
  const karmaNotes = useStudentKarmaNotes();
  const templates = useHelpRequestTemplates();
  const activity = useStudentHelpActivity();
  const moderation = useHelpRequestModeration();
  const feedback = useHelpRequestFeedback();

  const helpRequest = useHelpRequest(options.helpRequestId);
  const validHelpRequest = options.helpRequestId ? helpRequest : undefined;

  // Get real connection status from controller
  const [connectionStatus, setConnectionStatus] = useState<OfficeHoursConnectionStatus | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    const updateStatus = () => {
      try {
        const status = controller.getConnectionStatus() as OfficeHoursConnectionStatus;
        setConnectionStatus(status);
        setConnectionError(null);
      } catch (error) {
        console.error("Failed to get connection status:", error);
        setConnectionError(error instanceof Error ? error.message : "Unknown connection error");
      }
    };

    updateStatus();

    // Subscribe to status changes if available
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = controller.officeHoursRealTimeController?.subscribeToStatus?.(updateStatus);
    } catch (error) {
      console.warn("Could not subscribe to status changes:", error);
    }

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [controller]);

  // Calculate connection states
  const isConnected = connectionStatus?.overall === "connected";
  const isValidating = connectionStatus?.overall === "connecting";
  const isAuthorized = connectionStatus?.overall !== "disconnected" || connectionError === null;

  // Filter data based on options
  const filteredMessages = useMemo(() => {
    if (!options.helpRequestId) return messages;
    return messages.filter((msg) => msg.help_request_id === options.helpRequestId);
  }, [messages, options.helpRequestId]);

  const filteredReadReceipts = useMemo(() => {
    if (!options.helpRequestId) return readReceipts;
    const messageIds = filteredMessages.map((msg) => msg.id);
    return readReceipts.filter((receipt) => messageIds.includes(receipt.message_id));
  }, [readReceipts, filteredMessages, options.helpRequestId]);

  const filteredStudents = useMemo(() => {
    if (!options.helpRequestId) return students;
    return students.filter((student) => student.help_request_id === options.helpRequestId);
  }, [students, options.helpRequestId]);

  const filteredFeedback = useMemo(() => {
    if (!options.helpRequestId) return feedback;
    return feedback.filter((fb) => fb.help_request_id === options.helpRequestId);
  }, [feedback, options.helpRequestId]);

  const filteredQueues = useMemo(() => {
    if (options.helpQueueId) {
      return queues.filter((queue) => queue.id === options.helpQueueId);
    }
    if (options.onlyAvailableQueues) {
      return queues.filter((queue) => queue.available);
    }
    return queues;
  }, [queues, options.helpQueueId, options.onlyAvailableQueues]);

  const filteredAssignments = useMemo(() => {
    if (options.helpQueueId) {
      return assignments.filter((assignment) => assignment.help_queue_id === options.helpQueueId);
    }
    if (options.onlyActiveAssignments) {
      return assignments.filter((assignment) => assignment.is_active);
    }
    return assignments;
  }, [assignments, options.helpQueueId, options.onlyActiveAssignments]);

  const activeHelpRequests = useMemo(() => {
    if (!options.enableActiveRequests) return [];
    return requests.filter((request) => request.status === "open" || request.status === "in_progress");
  }, [requests, options.enableActiveRequests]);

  const data: OfficeHoursData = useMemo(
    () => ({
      helpRequest: validHelpRequest,
      helpRequestMessages: filteredMessages,
      helpRequestReadReceipts: filteredReadReceipts,
      helpRequestStudents: filteredStudents,
      helpRequestFileReferences: [],
      helpRequestTemplates: templates,
      helpRequestFeedback: filteredFeedback,
      helpRequestModeration: moderation,
      studentKarmaNotes: karmaNotes,
      videoMeetingSessions: [],
      studentHelpActivity: activity,
      helpQueue: options.helpQueueId ? filteredQueues[0] : undefined,
      helpQueues: filteredQueues,
      helpQueueAssignments: filteredAssignments,
      activeHelpRequests
    }),
    [
      validHelpRequest,
      filteredMessages,
      filteredReadReceipts,
      filteredStudents,
      templates,
      filteredFeedback,
      karmaNotes,
      activity,
      filteredQueues,
      filteredAssignments,
      activeHelpRequests,
      options.helpQueueId,
      moderation
    ]
  );

  // Chat functionality using Refine hooks
  const { mutateAsync: createMessage } = useCreate({
    resource: "help_request_messages"
  });

  const { mutateAsync: createReadReceipt } = useCreate({
    resource: "help_request_message_read_receipts"
  });

  const { user } = useAuthState();
  const { private_profile_id } = useClassProfiles();

  const sendMessage = useCallback(
    async (content: string, replyToMessageId?: number | null) => {
      if (!options.enableChat) {
        throw new Error("Chat functionality not enabled");
      }

      if (!user || !private_profile_id || !options.helpRequestId) {
        throw new Error("User authentication and help request ID required");
      }

      if (!content.trim()) {
        throw new Error("Message content cannot be empty");
      }

      await createMessage({
        values: {
          message: content,
          help_request_id: options.helpRequestId,
          author: private_profile_id,
          class_id: options.classId,
          instructors_only: false,
          reply_to_message_id: replyToMessageId || null
        }
      });
    },
    [options.enableChat, options.helpRequestId, options.classId, user, private_profile_id, createMessage]
  );

  const markMessageAsRead = useCallback(
    async (messageId: number, messageAuthorId?: string) => {
      if (!options.enableChat || !user || !private_profile_id) {
        return;
      }

      // Skip if current user is message author
      if (messageAuthorId && (messageAuthorId === user.id || messageAuthorId === private_profile_id)) {
        return;
      }

      // Use controller's persistent tracking to prevent duplicate API calls
      if (!controller.markMessageAsRead(messageId)) {
        console.log(`Message ${messageId} already marked as read, skipping API call`);
        return;
      }

      // Check if read receipt already exists in current data
      const existingReceipt = readReceipts.find(
        (receipt) => receipt.message_id === messageId && receipt.viewer_id === private_profile_id
      );

      if (existingReceipt) {
        console.log(`Read receipt already exists for message ${messageId}, skipping API call`);
        return;
      }

      try {
        await createReadReceipt({
          values: {
            message_id: messageId,
            viewer_id: private_profile_id,
            class_id: options.classId
          }
        });
        console.log(`Successfully created read receipt for message ${messageId}`);
      } catch (error) {
        console.error(`Failed to create read receipt for message ${messageId}:`, error);
        // Remove from marked set on failure to allow retry
        controller.clearMarkedAsReadState();
        controller.markMessageAsRead(messageId); // Re-mark since we cleared all

        // Optionally, you could implement a retry mechanism here
        // or show a user-friendly error message
      }
    },
    [options.enableChat, options.classId, user, private_profile_id, readReceipts, createReadReceipt, controller]
  );

  // Subscription helpers using controller
  const subscribeToHelpRequest = useCallback(
    (helpRequestId: number, callback: (message: OfficeHoursBroadcastMessage) => void) => {
      const adaptedCallback = (message: BroadcastMessage) => {
        callback(message as OfficeHoursBroadcastMessage);
      };
      return controller.officeHoursRealTimeController.subscribeToHelpRequest(helpRequestId, adaptedCallback);
    },
    [controller]
  );

  const subscribeToHelpRequestStaff = useCallback(
    (helpRequestId: number, callback: (message: OfficeHoursBroadcastMessage) => void) => {
      const adaptedCallback = (message: BroadcastMessage) => {
        callback(message as OfficeHoursBroadcastMessage);
      };
      return controller.officeHoursRealTimeController.subscribeToHelpRequestStaffData(helpRequestId, adaptedCallback);
    },
    [controller]
  );

  const subscribeToHelpQueue = useCallback(
    (helpQueueId: number, callback: (message: OfficeHoursBroadcastMessage) => void) => {
      const adaptedCallback = (message: BroadcastMessage) => {
        callback(message as OfficeHoursBroadcastMessage);
      };
      return controller.officeHoursRealTimeController.subscribeToHelpQueue(helpQueueId, adaptedCallback);
    },
    [controller]
  );

  const subscribeToAllHelpQueues = useCallback(
    (callback: (message: OfficeHoursBroadcastMessage) => void) => {
      const adaptedCallback = (message: BroadcastMessage) => {
        callback(message as OfficeHoursBroadcastMessage);
      };
      return controller.officeHoursRealTimeController.subscribeToAllHelpQueues(adaptedCallback);
    },
    [controller]
  );

  const subscribeToTable = useCallback(
    (tableName: string, callback: (message: OfficeHoursBroadcastMessage) => void) => {
      const adaptedCallback = (message: BroadcastMessage) => {
        callback(message as OfficeHoursBroadcastMessage);
      };
      return controller.officeHoursRealTimeController.subscribeToTable(tableName, adaptedCallback);
    },
    [controller]
  );

  return {
    data,
    connectionStatus,
    isConnected,
    isValidating,
    isAuthorized,
    connectionError,
    controller: controller.officeHoursRealTimeController,
    subscribeToHelpRequest,
    subscribeToHelpRequestStaff,
    subscribeToHelpQueue,
    subscribeToAllHelpQueues,
    subscribeToTable,
    sendMessage: options.enableChat ? sendMessage : undefined,
    markMessageAsRead: options.enableChat ? markMessageAsRead : undefined,
    readReceipts: filteredReadReceipts.filter((receipt) => receipt.viewer_id !== private_profile_id),
    isLoading: !controller.isReady
  };
}

/**
 * USAGE EXAMPLES:
 *
 * 1. Subscribe to all help request data for a specific request:
 * ```tsx
 * const { data, isConnected, subscribeToHelpRequest } = useOfficeHoursRealtime({
 *   classId: 123,
 *   helpRequestId: 456,
 *   enableStaffData: true // Only if user is staff
 * });
 *
 * // Access all data
 * const {
 *   helpRequest,
 *   helpRequestMessages,
 *   helpRequestReadReceipts,
 *   helpRequestStudents,
 *   helpRequestFileReferences,
 *   helpRequestModeration, // Staff data
 *   studentKarmaNotes, // Staff data
 *   videoMeetingSessions,
 *   studentHelpActivity
 * } = data;
 * ```
 *
 * 2. Subscribe to help queue status and all help requests in that queue:
 * ```tsx
 * const { data, subscribeToHelpQueue } = useOfficeHoursRealtime({
 *   classId: 123,
 *   helpQueueId: 789
 * });
 *
 * // Access queue data
 * const { helpQueue, helpQueueAssignments } = data;
 * ```
 *
 * 3. Subscribe to all help queues in a class:
 * ```tsx
 * const { data, subscribeToAllHelpQueues } = useOfficeHoursRealtime({
 *   classId: 123,
 *   enableGlobalQueues: true
 * });
 *
 * // Access all queues and assignments
 * const { helpQueues, helpQueueAssignments } = data;
 * ```
 *
 * 4. Staff-only: Subscribe to moderation and karma data:
 * ```tsx
 * const { data, subscribeToHelpRequestStaff } = useOfficeHoursRealtime({
 *   classId: 123,
 *   helpRequestId: 456,
 *   isStaff: true,
 *   enableStaffData: true
 * });
 *
 * // Staff can see all moderation data, students only see their own
 * const { helpRequestModeration, studentKarmaNotes } = data;
 * ```
 *
 * 5. Custom realtime subscriptions:
 * ```tsx
 * const { subscribeToTable } = useOfficeHoursRealtime({ classId: 123 });
 *
 * useEffect(() => {
 *   // Subscribe to specific table changes
 *   const unsubscribe = subscribeToTable('help_request_messages', (message) => {
 *     console.log('Message change:', message);
 *     if (message.operation === 'INSERT') {
 *       // Handle new message
 *     }
 *   });
 *
 *   return unsubscribe;
 * }, []);
 * ```
 *
 * 6. Monitor connection status:
 * ```tsx
 * const { connectionStatus, isConnected } = useOfficeHoursRealtime({ classId: 123 });
 *
 * if (!isConnected) {
 *   return <div>Connecting to realtime...</div>;
 * }
 *
 * return (
 *   <div>
 *     Status: {connectionStatus?.overall}
 *     Active channels: {connectionStatus?.channels.length}
 *   </div>
 * );
 * ```
 *
 * CHANNEL TYPES SUPPORTED:
 * - help_request:<id> - All data associated with a help request
 * - help_request:<id>:staff - Moderation and karma data (staff/own data only)
 * - help_queue:<id> - Status of a single help queue
 * - help_queues - All help queues with assignments
 *
 * MESSAGE TYPES:
 * - table_change: Changes to help request related tables
 * - staff_data_change: Changes to moderation/karma data
 * - queue_change: Changes to help queue related data
 * - channel_created/system: System messages (usually ignored)
 */
