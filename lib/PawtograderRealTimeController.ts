/**
 * Common interface for all Pawtograder realtime controllers.
 * This interface defines the contract that all realtime controllers must implement
 * to work with TableController.
 *
 * Implementations:
 * - ClassRealTimeController - Class-wide channels (staff, students, user)
 * - OfficeHoursRealTimeController - Office hours channels (help queues, requests)
 * - DiscussionThreadRealTimeController - Per-thread channels (discussion_thread:$root_id)
 */

import { BroadcastMessage } from "./TableController";

export type ChannelStatus = {
  name: string;
  state: "closed" | "errored" | "joined" | "joining" | "leaving";
  type: string;
  [key: string]: unknown; // Allow additional properties for specific channel types
};

export type ConnectionStatus = {
  overall: "connected" | "connecting" | "disconnected" | "partial";
  channels: ChannelStatus[];
  lastUpdate: Date;
};

export interface PawtograderRealTimeController {
  /**
   * Subscribe to table change broadcasts
   * @param table The table name to subscribe to
   * @param callback Function to call when a broadcast is received
   * @returns Unsubscribe function
   */
  subscribeToTable(table: string, callback: (message: BroadcastMessage) => void): () => void;

  /**
   * Subscribe to connection status changes
   * @param callback Function to call when connection status changes
   * @returns Unsubscribe function
   */
  subscribeToStatus(callback: (status: ConnectionStatus) => void): () => void;

  /**
   * Get the current connection status
   * @returns Current status of all managed channels
   */
  getConnectionStatus(): ConnectionStatus;
}
