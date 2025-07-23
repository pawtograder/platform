"use client";

import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext } from "react";
import { useList, useCreate, LiveEvent } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { OfficeHoursRealTimeController } from "@/lib/OfficeHoursRealTimeController";
import useAuthState from "./useAuthState";
import { useClassProfiles } from "./useClassProfiles";
import { Box, Spinner } from "@chakra-ui/react";

import {
  HelpRequest,
  HelpRequestMessage,
  HelpRequestMessageWithoutId,
  HelpRequestMessageReadReceipt,
  HelpRequestStudent,
  HelpRequestFileReference,
  HelpRequestModeration,
  HelpRequestTemplate,
  HelpQueue,
  HelpQueueAssignment,
  StudentKarmaNotes,
  VideoMeetingSession,
  StudentHelpActivity,
  OfficeHoursBroadcastMessage,
  OfficeHoursConnectionStatus
} from "@/utils/supabase/DatabaseTypes";

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
import { Database } from "@/utils/supabase/SupabaseTypes";

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

  constructor(public classId: number) {}

  initializeRealTimeController(profileId: string, isStaff: boolean) {
    if (this._officeHoursRealTimeController) {
      this._officeHoursRealTimeController.close();
    }

    if (this._broadcastUnsubscribe) {
      this._broadcastUnsubscribe();
    }

    this._officeHoursRealTimeController = new OfficeHoursRealTimeController({
      client: createClient(),
      classId: this.classId,
      profileId,
      isStaff
    });

    // Subscribe to broadcast messages and integrate with data maps
    // NOTE: Using empty filter {} to receive all messages from any subscribed channel.
    // This doesn't create channels - specific subscriptions (like in useOfficeHoursRealtime)
    // must ensure channels are created by subscribing to specific help_request_id/help_queue_id.
    this._broadcastUnsubscribe = this._officeHoursRealTimeController.subscribe(
      {}, // Subscribe to all messages from any active channel
      (message) => {
        this._handleBroadcastMessage(message);
      }
    );
  }

  get officeHoursRealTimeController(): OfficeHoursRealTimeController {
    if (!this._officeHoursRealTimeController) {
      throw new Error("OfficeHoursRealTimeController not initialized. Call initializeRealTimeController first.");
    }
    return this._officeHoursRealTimeController;
  }

  /**
   * Handle broadcast messages from OfficeHoursRealTimeController and update data maps
   */
  private _handleBroadcastMessage(message: DatabaseBroadcastMessage) {
    console.log("Processing broadcast message in OfficeHoursController:", message);

    if (message.type !== "table_change" || !message.table || !message.operation || !message.data) {
      return;
    }

    const { table, operation, data } = message;

    switch (table) {
      case "help_request_messages":
        this._handleMessageBroadcast(operation, data);
        break;
      case "help_request_message_read_receipts":
        this._handleReadReceiptBroadcast(operation, data);
        break;
      case "help_requests":
        this._handleHelpRequestBroadcast(operation, data);
        break;
      case "help_queues":
        this._handleHelpQueueBroadcast(operation, data);
        break;
      case "help_queue_assignments":
        this._handleHelpQueueAssignmentBroadcast(operation, data);
        break;
      case "help_request_students":
        this._handleHelpRequestStudentBroadcast(operation, data);
        break;
      case "student_karma_notes":
        this._handleStudentKarmaNoteBroadcast(operation, data);
        break;
      case "help_request_templates":
        this._handleHelpRequestTemplateBroadcast(operation, data);
        break;
      case "student_help_activity":
        this._handleStudentHelpActivityBroadcast(operation, data);
        break;
    }
  }

  private _handleMessageBroadcast(operation: string, data: Record<string, unknown>) {
    const message = data as HelpRequestMessage;

    if (operation === "INSERT" || operation === "UPDATE") {
      this.helpRequestMessages.set(message.id, message);
      const subscribers = this.helpRequestMessagesSubscribers.get(message.id) || [];
      subscribers.forEach((cb) => cb(message));
      this.helpRequestMessagesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestMessages.values())));
    } else if (operation === "DELETE") {
      this.helpRequestMessages.delete(message.id);
      this.helpRequestMessagesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestMessages.values())));
    }
  }

  private _handleReadReceiptBroadcast(operation: string, data: Record<string, unknown>) {
    const receipt = data as HelpRequestMessageReadReceipt;

    if (operation === "INSERT" || operation === "UPDATE") {
      this.helpRequestReadReceipts.set(receipt.id, receipt);
      this.helpRequestReadReceiptsListSubscribers.forEach((cb) =>
        cb(Array.from(this.helpRequestReadReceipts.values()))
      );
    } else if (operation === "DELETE") {
      this.helpRequestReadReceipts.delete(receipt.id);
      this.helpRequestReadReceiptsListSubscribers.forEach((cb) =>
        cb(Array.from(this.helpRequestReadReceipts.values()))
      );
    }
  }

  private _handleHelpRequestBroadcast(operation: string, data: Record<string, unknown>) {
    const request = data as HelpRequest;

    if (operation === "INSERT" || operation === "UPDATE") {
      this.helpRequests.set(request.id, request);
      const subscribers = this.helpRequestSubscribers.get(request.id) || [];
      subscribers.forEach((cb) => cb(request));
      this.helpRequestsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequests.values())));
    } else if (operation === "DELETE") {
      this.helpRequests.delete(request.id);
      this.helpRequestsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequests.values())));
    }
  }

  private _handleHelpQueueBroadcast(operation: string, data: Record<string, unknown>) {
    const queue = data as HelpQueue;

    if (operation === "INSERT" || operation === "UPDATE") {
      this.helpQueues.set(queue.id, queue);
      this.helpQueuesListSubscribers.forEach((cb) => cb(Array.from(this.helpQueues.values())));
    } else if (operation === "DELETE") {
      this.helpQueues.delete(queue.id);
      this.helpQueuesListSubscribers.forEach((cb) => cb(Array.from(this.helpQueues.values())));
    }
  }

  private _handleHelpQueueAssignmentBroadcast(operation: string, data: Record<string, unknown>) {
    const assignment = data as HelpQueueAssignment;

    if (operation === "INSERT" || operation === "UPDATE") {
      this.helpQueueAssignments.set(assignment.id, assignment);
      this.helpQueueAssignmentsListSubscribers.forEach((cb) => cb(Array.from(this.helpQueueAssignments.values())));
    } else if (operation === "DELETE") {
      this.helpQueueAssignments.delete(assignment.id);
      this.helpQueueAssignmentsListSubscribers.forEach((cb) => cb(Array.from(this.helpQueueAssignments.values())));
    }
  }

  private _handleHelpRequestStudentBroadcast(operation: string, data: Record<string, unknown>) {
    const student = data as HelpRequestStudent;

    if (operation === "INSERT" || operation === "UPDATE") {
      this.helpRequestStudents.set(student.id, student);
      this.helpRequestStudentsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestStudents.values())));
    } else if (operation === "DELETE") {
      this.helpRequestStudents.delete(student.id);
      this.helpRequestStudentsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestStudents.values())));
    }
  }

  private _handleStudentKarmaNoteBroadcast(operation: string, data: Record<string, unknown>) {
    const karmaNote = data as StudentKarmaNotes;

    if (operation === "INSERT" || operation === "UPDATE") {
      this.studentKarmaNotes.set(karmaNote.id, karmaNote);
      this.studentKarmaNotesListSubscribers.forEach((cb) => cb(Array.from(this.studentKarmaNotes.values())));
    } else if (operation === "DELETE") {
      this.studentKarmaNotes.delete(karmaNote.id);
      this.studentKarmaNotesListSubscribers.forEach((cb) => cb(Array.from(this.studentKarmaNotes.values())));
    }
  }

  private _handleHelpRequestTemplateBroadcast(operation: string, data: Record<string, unknown>) {
    const template = data as HelpRequestTemplate;

    if (operation === "INSERT" || operation === "UPDATE") {
      this.helpRequestTemplates.set(template.id, template);
      this.helpRequestTemplatesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestTemplates.values())));
    } else if (operation === "DELETE") {
      this.helpRequestTemplates.delete(template.id);
      this.helpRequestTemplatesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestTemplates.values())));
    }
  }

  private _handleStudentHelpActivityBroadcast(operation: string, data: Record<string, unknown>) {
    const activity = data as StudentHelpActivity;

    if (operation === "INSERT" || operation === "UPDATE") {
      this.studentHelpActivity.set(activity.id, activity);
      this.studentHelpActivityListSubscribers.forEach((cb) => cb(Array.from(this.studentHelpActivity.values())));
    } else if (operation === "DELETE") {
      this.studentHelpActivity.delete(activity.id);
      this.studentHelpActivityListSubscribers.forEach((cb) => cb(Array.from(this.studentHelpActivity.values())));
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

    this._markedAsReadSet.clear();
  }

  private helpRequestMessages: Map<number, HelpRequestMessage> = new Map();
  private helpRequestMessagesListSubscribers: UpdateCallback<HelpRequestMessage[]>[] = [];
  private helpRequestMessagesSubscribers: Map<number, UpdateCallback<HelpRequestMessage>[]> = new Map();

  private helpRequestReadReceipts: Map<number, HelpRequestMessageReadReceipt> = new Map();
  private helpRequestReadReceiptsListSubscribers: UpdateCallback<HelpRequestMessageReadReceipt[]>[] = [];

  private helpRequestStudents: Map<number, HelpRequestStudent> = new Map();
  private helpRequestStudentsListSubscribers: UpdateCallback<HelpRequestStudent[]>[] = [];

  private helpRequestFileReferences: Map<number, HelpRequestFileReference> = new Map();
  private helpRequestFileReferencesListSubscribers: UpdateCallback<HelpRequestFileReference[]>[] = [];

  private helpRequestTemplates: Map<number, HelpRequestTemplate> = new Map();
  private helpRequestTemplatesListSubscribers: UpdateCallback<HelpRequestTemplate[]>[] = [];

  private helpRequestModeration: Map<number, HelpRequestModeration> = new Map();
  private helpRequestModerationListSubscribers: UpdateCallback<HelpRequestModeration[]>[] = [];

  private studentKarmaNotes: Map<number, StudentKarmaNotes> = new Map();
  private studentKarmaNotesListSubscribers: UpdateCallback<StudentKarmaNotes[]>[] = [];

  private videoMeetingSessions: Map<number, VideoMeetingSession> = new Map();
  private videoMeetingSessionsListSubscribers: UpdateCallback<VideoMeetingSession[]>[] = [];

  private studentHelpActivity: Map<number, StudentHelpActivity> = new Map();
  private studentHelpActivityListSubscribers: UpdateCallback<StudentHelpActivity[]>[] = [];

  private helpQueues: Map<number, HelpQueue> = new Map();
  private helpQueuesListSubscribers: UpdateCallback<HelpQueue[]>[] = [];

  private helpQueueAssignments: Map<number, HelpQueueAssignment> = new Map();
  private helpQueueAssignmentsListSubscribers: UpdateCallback<HelpQueueAssignment[]>[] = [];

  private helpRequests: Map<number, HelpRequest> = new Map();
  private helpRequestsListSubscribers: UpdateCallback<HelpRequest[]>[] = [];
  private helpRequestSubscribers: Map<number, UpdateCallback<HelpRequest>[]> = new Map();

  get isLoaded() {
    return this._isLoaded;
  }

  // Help Request Messages
  setHelpRequestMessages(data: HelpRequestMessage[]) {
    for (const message of data) {
      this.helpRequestMessages.set(message.id, message);
    }
    this.helpRequestMessagesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestMessages.values())));
  }

  listHelpRequestMessages(callback?: UpdateCallback<HelpRequestMessage[]>): {
    unsubscribe: Unsubscribe;
    data: HelpRequestMessage[];
  } {
    if (callback) {
      this.helpRequestMessagesListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.helpRequestMessagesListSubscribers = this.helpRequestMessagesListSubscribers.filter(
          (cb) => cb !== callback
        );
      },
      data: Array.from(this.helpRequestMessages.values())
    };
  }

  handleHelpRequestMessageEvent(event: LiveEvent) {
    const message = event.payload as HelpRequestMessage;
    if (event.type === "created" || event.type === "updated") {
      this.helpRequestMessages.set(message.id, message);
      const subscribers = this.helpRequestMessagesSubscribers.get(message.id) || [];
      subscribers.forEach((cb) => cb(message));
      this.helpRequestMessagesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestMessages.values())));
    } else if (event.type === "deleted") {
      this.helpRequestMessages.delete(message.id);
      this.helpRequestMessagesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestMessages.values())));
    }
  }

  // Help Request Read Receipts
  setHelpRequestReadReceipts(data: HelpRequestMessageReadReceipt[]) {
    for (const receipt of data) {
      this.helpRequestReadReceipts.set(receipt.id, receipt);
    }
    this.helpRequestReadReceiptsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestReadReceipts.values())));
  }

  listHelpRequestReadReceipts(callback?: UpdateCallback<HelpRequestMessageReadReceipt[]>): {
    unsubscribe: Unsubscribe;
    data: HelpRequestMessageReadReceipt[];
  } {
    if (callback) {
      this.helpRequestReadReceiptsListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.helpRequestReadReceiptsListSubscribers = this.helpRequestReadReceiptsListSubscribers.filter(
          (cb) => cb !== callback
        );
      },
      data: Array.from(this.helpRequestReadReceipts.values())
    };
  }

  handleHelpRequestReadReceiptEvent(event: LiveEvent) {
    const receipt = event.payload as HelpRequestMessageReadReceipt;
    if (event.type === "created" || event.type === "updated") {
      this.helpRequestReadReceipts.set(receipt.id, receipt);
      this.helpRequestReadReceiptsListSubscribers.forEach((cb) =>
        cb(Array.from(this.helpRequestReadReceipts.values()))
      );
    } else if (event.type === "deleted") {
      this.helpRequestReadReceipts.delete(receipt.id);
      this.helpRequestReadReceiptsListSubscribers.forEach((cb) =>
        cb(Array.from(this.helpRequestReadReceipts.values()))
      );
    }
  }

  // Help Requests
  setHelpRequests(data: HelpRequest[]) {
    for (const request of data) {
      this.helpRequests.set(request.id, request);
    }
    this.helpRequestsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequests.values())));
  }

  listHelpRequests(callback?: UpdateCallback<HelpRequest[]>): { unsubscribe: Unsubscribe; data: HelpRequest[] } {
    if (callback) {
      this.helpRequestsListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.helpRequestsListSubscribers = this.helpRequestsListSubscribers.filter((cb) => cb !== callback);
      },
      data: Array.from(this.helpRequests.values())
    };
  }

  getHelpRequest(
    id: number,
    callback?: UpdateCallback<HelpRequest>
  ): { unsubscribe: Unsubscribe; data: HelpRequest | undefined } {
    const subscribers = this.helpRequestSubscribers.get(id) || [];
    if (callback) {
      this.helpRequestSubscribers.set(id, [...subscribers, callback]);
    }
    return {
      unsubscribe: () => {
        this.helpRequestSubscribers.set(
          id,
          subscribers.filter((cb) => cb !== callback)
        );
      },
      data: this.helpRequests.get(id)
    };
  }

  handleHelpRequestEvent(event: LiveEvent) {
    const request = event.payload as HelpRequest;
    if (event.type === "created" || event.type === "updated") {
      this.helpRequests.set(request.id, request);
      const subscribers = this.helpRequestSubscribers.get(request.id) || [];
      subscribers.forEach((cb) => cb(request));
      this.helpRequestsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequests.values())));
    } else if (event.type === "deleted") {
      this.helpRequests.delete(request.id);
      this.helpRequestsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequests.values())));
    }
  }

  handleHelpRequestStudentEvent(event: LiveEvent) {
    const student = event.payload as HelpRequestStudent;
    if (event.type === "created" || event.type === "updated") {
      this.helpRequestStudents.set(student.id, student);
      this.helpRequestStudentsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestStudents.values())));
    } else if (event.type === "deleted") {
      this.helpRequestStudents.delete(student.id);
      this.helpRequestStudentsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestStudents.values())));
    }
  }

  // Help Queues
  setHelpQueues(data: HelpQueue[]) {
    for (const queue of data) {
      this.helpQueues.set(queue.id, queue);
    }
    this.helpQueuesListSubscribers.forEach((cb) => cb(Array.from(this.helpQueues.values())));
  }

  listHelpQueues(callback?: UpdateCallback<HelpQueue[]>): { unsubscribe: Unsubscribe; data: HelpQueue[] } {
    if (callback) {
      this.helpQueuesListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.helpQueuesListSubscribers = this.helpQueuesListSubscribers.filter((cb) => cb !== callback);
      },
      data: Array.from(this.helpQueues.values())
    };
  }

  handleHelpQueueEvent(event: LiveEvent) {
    const queue = event.payload as HelpQueue;
    if (event.type === "created" || event.type === "updated") {
      this.helpQueues.set(queue.id, queue);
      this.helpQueuesListSubscribers.forEach((cb) => cb(Array.from(this.helpQueues.values())));
    } else if (event.type === "deleted") {
      this.helpQueues.delete(queue.id);
      this.helpQueuesListSubscribers.forEach((cb) => cb(Array.from(this.helpQueues.values())));
    }
  }

  // Helper methods for other data types following similar patterns
  setHelpRequestStudents(data: HelpRequestStudent[]) {
    for (const student of data) {
      this.helpRequestStudents.set(student.id, student);
    }
    this.helpRequestStudentsListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestStudents.values())));
  }

  listHelpRequestStudents(callback?: UpdateCallback<HelpRequestStudent[]>): {
    unsubscribe: Unsubscribe;
    data: HelpRequestStudent[];
  } {
    if (callback) {
      this.helpRequestStudentsListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.helpRequestStudentsListSubscribers = this.helpRequestStudentsListSubscribers.filter(
          (cb) => cb !== callback
        );
      },
      data: Array.from(this.helpRequestStudents.values())
    };
  }

  setHelpQueueAssignments(data: HelpQueueAssignment[]) {
    for (const assignment of data) {
      this.helpQueueAssignments.set(assignment.id, assignment);
    }
    this.helpQueueAssignmentsListSubscribers.forEach((cb) => cb(Array.from(this.helpQueueAssignments.values())));
  }

  listHelpQueueAssignments(callback?: UpdateCallback<HelpQueueAssignment[]>): {
    unsubscribe: Unsubscribe;
    data: HelpQueueAssignment[];
  } {
    if (callback) {
      this.helpQueueAssignmentsListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.helpQueueAssignmentsListSubscribers = this.helpQueueAssignmentsListSubscribers.filter(
          (cb) => cb !== callback
        );
      },
      data: Array.from(this.helpQueueAssignments.values())
    };
  }

  // Student Karma Notes
  setStudentKarmaNotes(data: StudentKarmaNotes[]) {
    for (const karmaNote of data) {
      this.studentKarmaNotes.set(karmaNote.id, karmaNote);
    }
    this.studentKarmaNotesListSubscribers.forEach((cb) => cb(Array.from(this.studentKarmaNotes.values())));
  }

  listStudentKarmaNotes(callback?: UpdateCallback<StudentKarmaNotes[]>): {
    unsubscribe: Unsubscribe;
    data: StudentKarmaNotes[];
  } {
    if (callback) {
      this.studentKarmaNotesListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.studentKarmaNotesListSubscribers = this.studentKarmaNotesListSubscribers.filter((cb) => cb !== callback);
      },
      data: Array.from(this.studentKarmaNotes.values())
    };
  }

  handleStudentKarmaNotesEvent(event: LiveEvent) {
    const karmaNote = event.payload as StudentKarmaNotes;
    if (event.type === "created" || event.type === "updated") {
      this.studentKarmaNotes.set(karmaNote.id, karmaNote);
      this.studentKarmaNotesListSubscribers.forEach((cb) => cb(Array.from(this.studentKarmaNotes.values())));
    } else if (event.type === "deleted") {
      this.studentKarmaNotes.delete(karmaNote.id);
      this.studentKarmaNotesListSubscribers.forEach((cb) => cb(Array.from(this.studentKarmaNotes.values())));
    }
  }

  // Help Request Templates
  setHelpRequestTemplates(data: HelpRequestTemplate[]) {
    for (const template of data) {
      this.helpRequestTemplates.set(template.id, template);
    }
    this.helpRequestTemplatesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestTemplates.values())));
  }

  listHelpRequestTemplates(callback?: UpdateCallback<HelpRequestTemplate[]>): {
    unsubscribe: Unsubscribe;
    data: HelpRequestTemplate[];
  } {
    if (callback) {
      this.helpRequestTemplatesListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.helpRequestTemplatesListSubscribers = this.helpRequestTemplatesListSubscribers.filter(
          (cb) => cb !== callback
        );
      },
      data: Array.from(this.helpRequestTemplates.values())
    };
  }

  handleHelpRequestTemplatesEvent(event: LiveEvent) {
    const template = event.payload as HelpRequestTemplate;
    if (event.type === "created" || event.type === "updated") {
      this.helpRequestTemplates.set(template.id, template);
      this.helpRequestTemplatesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestTemplates.values())));
    } else if (event.type === "deleted") {
      this.helpRequestTemplates.delete(template.id);
      this.helpRequestTemplatesListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestTemplates.values())));
    }
  }

  // Student Help Activity
  setStudentHelpActivity(data: StudentHelpActivity[]) {
    for (const activity of data) {
      this.studentHelpActivity.set(activity.id, activity);
    }
    this.studentHelpActivityListSubscribers.forEach((cb) => cb(Array.from(this.studentHelpActivity.values())));
  }

  listStudentHelpActivity(callback?: UpdateCallback<StudentHelpActivity[]>): {
    unsubscribe: Unsubscribe;
    data: StudentHelpActivity[];
  } {
    if (callback) {
      this.studentHelpActivityListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.studentHelpActivityListSubscribers = this.studentHelpActivityListSubscribers.filter(
          (cb) => cb !== callback
        );
      },
      data: Array.from(this.studentHelpActivity.values())
    };
  }

  handleStudentHelpActivityEvent(event: LiveEvent) {
    const activity = event.payload as StudentHelpActivity;
    if (event.type === "created" || event.type === "updated") {
      this.studentHelpActivity.set(activity.id, activity);
      this.studentHelpActivityListSubscribers.forEach((cb) => cb(Array.from(this.studentHelpActivity.values())));
    } else if (event.type === "deleted") {
      this.studentHelpActivity.delete(activity.id);
      this.studentHelpActivityListSubscribers.forEach((cb) => cb(Array.from(this.studentHelpActivity.values())));
    }
  }

  // Help Request Moderation
  setHelpRequestModeration(data: HelpRequestModeration[]) {
    for (const moderation of data) {
      this.helpRequestModeration.set(moderation.id, moderation);
    }
    this.helpRequestModerationListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestModeration.values())));
  }

  listHelpRequestModeration(callback?: UpdateCallback<HelpRequestModeration[]>): {
    unsubscribe: Unsubscribe;
    data: HelpRequestModeration[];
  } {
    if (callback) {
      this.helpRequestModerationListSubscribers.push(callback);
    }
    return {
      unsubscribe: () => {
        this.helpRequestModerationListSubscribers = this.helpRequestModerationListSubscribers.filter(
          (cb) => cb !== callback
        );
      },
      data: Array.from(this.helpRequestModeration.values())
    };
  }

  handleHelpRequestModerationEvent(event: LiveEvent) {
    const moderation = event.payload as HelpRequestModeration;
    if (event.type === "created" || event.type === "updated") {
      this.helpRequestModeration.set(moderation.id, moderation);
      this.helpRequestModerationListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestModeration.values())));
    } else if (event.type === "deleted") {
      this.helpRequestModeration.delete(moderation.id);
      this.helpRequestModerationListSubscribers.forEach((cb) => cb(Array.from(this.helpRequestModeration.values())));
    }
  }
}

function OfficeHoursControllerProviderImpl({
  controller,
  classId
}: {
  controller: OfficeHoursController;
  classId: number;
}) {
  // Help Request Messages
  const helpRequestMessages = useList<HelpRequestMessage>({
    resource: "help_request_messages",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto",
    onLiveEvent: (event) => {
      controller.handleHelpRequestMessageEvent(event);
    }
  });
  useEffect(() => {
    if (helpRequestMessages.data) {
      controller.setHelpRequestMessages(helpRequestMessages.data.data);
    }
  }, [controller, helpRequestMessages.data]);

  // Help Request Read Receipts
  const helpRequestReadReceipts = useList<HelpRequestMessageReadReceipt>({
    resource: "help_request_message_read_receipts",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto",
    onLiveEvent: (event) => {
      controller.handleHelpRequestReadReceiptEvent(event);
    }
  });
  useEffect(() => {
    if (helpRequestReadReceipts.data) {
      controller.setHelpRequestReadReceipts(helpRequestReadReceipts.data.data);
    }
  }, [controller, helpRequestReadReceipts.data]);

  // Help Requests
  const helpRequests = useList<HelpRequest>({
    resource: "help_requests",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto",
    onLiveEvent: (event) => {
      controller.handleHelpRequestEvent(event);
    }
  });
  useEffect(() => {
    if (helpRequests.data) {
      controller.setHelpRequests(helpRequests.data.data);
    }
  }, [controller, helpRequests.data]);

  // Help Queues
  const helpQueues = useList<HelpQueue>({
    resource: "help_queues",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto",
    onLiveEvent: (event) => {
      controller.handleHelpQueueEvent(event);
    }
  });
  useEffect(() => {
    if (helpQueues.data) {
      controller.setHelpQueues(helpQueues.data.data);
    }
  }, [controller, helpQueues.data]);

  // Help Request Students
  const helpRequestStudents = useList<HelpRequestStudent>({
    resource: "help_request_students",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto",
    onLiveEvent: (event) => {
      controller.handleHelpRequestStudentEvent(event);
    }
  });
  useEffect(() => {
    if (helpRequestStudents.data) {
      controller.setHelpRequestStudents(helpRequestStudents.data.data);
    }
  }, [controller, helpRequestStudents.data]);

  // Help Queue Assignments
  const helpQueueAssignments = useList<HelpQueueAssignment>({
    resource: "help_queue_assignments",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto"
  });
  useEffect(() => {
    if (helpQueueAssignments.data) {
      controller.setHelpQueueAssignments(helpQueueAssignments.data.data);
    }
  }, [controller, helpQueueAssignments.data]);

  // Student Karma Notes
  const studentKarmaNotes = useList<StudentKarmaNotes>({
    resource: "student_karma_notes",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto",
    onLiveEvent: (event) => {
      controller.handleStudentKarmaNotesEvent(event);
    }
  });
  useEffect(() => {
    if (studentKarmaNotes.data) {
      controller.setStudentKarmaNotes(studentKarmaNotes.data.data);
    }
  }, [controller, studentKarmaNotes.data]);

  // Help Request Templates
  const helpRequestTemplates = useList<HelpRequestTemplate>({
    resource: "help_request_templates",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto",
    onLiveEvent: (event) => {
      controller.handleHelpRequestTemplatesEvent(event);
    }
  });
  useEffect(() => {
    if (helpRequestTemplates.data) {
      controller.setHelpRequestTemplates(helpRequestTemplates.data.data);
    }
  }, [controller, helpRequestTemplates.data]);

  // Help Request Moderation
  const helpRequestModeration = useList<HelpRequestModeration>({
    resource: "help_request_moderation",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto",
    onLiveEvent: (event) => {
      controller.handleHelpRequestModerationEvent(event);
    }
  });
  useEffect(() => {
    if (helpRequestModeration.data) {
      controller.setHelpRequestModeration(helpRequestModeration.data.data);
    }
  }, [controller, helpRequestModeration.data]);

  // Student Help Activity
  const studentHelpActivity = useList<StudentHelpActivity>({
    resource: "student_help_activity",
    filters: [{ field: "class_id", operator: "eq", value: classId }],
    pagination: { pageSize: 1000 },
    queryOptions: {
      staleTime: Infinity,
      cacheTime: Infinity
    },
    liveMode: "auto",
    onLiveEvent: (event) => {
      controller.handleStudentHelpActivityEvent(event);
    }
  });
  useEffect(() => {
    if (studentHelpActivity.data) {
      controller.setStudentHelpActivity(studentHelpActivity.data.data);
    }
  }, [controller, studentHelpActivity.data]);

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
  const controller = useRef<OfficeHoursController>(new OfficeHoursController(classId));
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    controller.current.initializeRealTimeController(profileId, role === "instructor" || role === "grader");
    setIsInitialized(true);

    // Cleanup on unmount
    return () => {
      controller.current.close();
    };
  }, [controller, profileId, role]);

  if (!isInitialized) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" height="100vh">
        <Spinner />
      </Box>
    );
  }

  return (
    <OfficeHoursControllerContext.Provider value={controller.current}>
      <OfficeHoursControllerProviderImpl controller={controller.current} classId={classId} />
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
    const { data, unsubscribe } = controller.listHelpRequestMessages((data) => {
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
    const { data, unsubscribe } = controller.listHelpRequestReadReceipts((data) => {
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
    const { data, unsubscribe } = controller.listHelpRequests((data) => {
      setRequests(data);
    });
    setRequests(data);
    return unsubscribe;
  }, [controller]);
  return requests;
}

export function useHelpRequest(id: number) {
  const controller = useOfficeHoursController();
  const [request, setRequest] = useState<HelpRequest | undefined>(undefined);
  useEffect(() => {
    const { data, unsubscribe } = controller.getHelpRequest(id, (data) => {
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
    const { data, unsubscribe } = controller.listHelpQueues((data) => {
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
    const { data, unsubscribe } = controller.listHelpRequestStudents((data) => {
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
    const { data, unsubscribe } = controller.listHelpQueueAssignments((data) => {
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
    const { data, unsubscribe } = controller.listStudentKarmaNotes((data) => {
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
    const { data, unsubscribe } = controller.listHelpRequestTemplates((data) => {
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
    const { data, unsubscribe } = controller.listHelpRequestModeration((data) => {
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
    const { data, unsubscribe } = controller.listStudentHelpActivity((data) => {
      setActivity(data);
    });
    setActivity(data);
    return unsubscribe;
  }, [controller]);
  return activity;
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

  const helpRequest = useHelpRequest(options.helpRequestId || 0);
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
      return controller.officeHoursRealTimeController.subscribeToHelpRequest(helpRequestId, callback);
    },
    [controller]
  );

  const subscribeToHelpRequestStaff = useCallback(
    (helpRequestId: number, callback: (message: OfficeHoursBroadcastMessage) => void) => {
      return controller.officeHoursRealTimeController.subscribeToHelpRequestStaffData(helpRequestId, callback);
    },
    [controller]
  );

  const subscribeToHelpQueue = useCallback(
    (helpQueueId: number, callback: (message: OfficeHoursBroadcastMessage) => void) => {
      return controller.officeHoursRealTimeController.subscribeToHelpQueue(helpQueueId, callback);
    },
    [controller]
  );

  const subscribeToAllHelpQueues = useCallback(
    (callback: (message: OfficeHoursBroadcastMessage) => void) => {
      return controller.officeHoursRealTimeController.subscribeToAllHelpQueues(callback);
    },
    [controller]
  );

  const subscribeToTable = useCallback(
    (tableName: string, callback: (message: OfficeHoursBroadcastMessage) => void) => {
      return controller.officeHoursRealTimeController.subscribeToTable(tableName, callback);
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
