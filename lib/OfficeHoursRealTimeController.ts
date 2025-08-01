import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { BroadcastMessage } from "./TableController";

type MessageFilter = {
  type?: BroadcastMessage["type"];
  table?: string;
  help_request_id?: number;
  help_queue_id?: number;
  student_profile_id?: string;
};

type MessageCallback = (message: BroadcastMessage) => void;

interface MessageSubscription {
  id: string;
  filter: MessageFilter;
  callback: MessageCallback;
}

export type ChannelStatus = {
  name: string;
  state: "closed" | "errored" | "joined" | "joining" | "leaving";
  type: "help_request" | "help_request_staff" | "help_queue" | "help_queues" | "class_staff";
  help_request_id?: number;
  help_queue_id?: number;
};

export type ConnectionStatus = {
  overall: "connected" | "connecting" | "disconnected" | "partial";
  channels: ChannelStatus[];
  lastUpdate: Date;
};

/**
 * Controller for managing office hours realtime channels and subscriptions.
 * Handles the four main channel types from the migration:
 * - help_request:<id> (all help request details)
 * - help_request:<id>:staff (moderation and karma data)
 * - help_queue:<id> (single queue status)
 * - help_queues (all queues with assignments)
 */
export class OfficeHoursRealTimeController {
  private _client: SupabaseClient<Database>;
  private _classId: number;
  private _profileId: string;
  private _isStaff: boolean;

  // Channel management
  private _helpRequestChannels: Map<number, RealtimeChannel> = new Map();
  private _helpRequestStaffChannels: Map<number, RealtimeChannel> = new Map();
  private _helpQueueChannels: Map<number, RealtimeChannel> = new Map();
  private _helpQueuesChannel: RealtimeChannel | null = null;
  private _classStaffChannel: RealtimeChannel | null = null;

  // Subscription management
  private _subscriptions: Map<string, MessageSubscription> = new Map();
  private _subscriptionCounter = 0;
  private _statusChangeListeners: ((status: ConnectionStatus) => void)[] = [];
  private _objDebugId = `${new Date().getTime()}-${Math.random()}`;
  private _closed = false;

  constructor({
    client,
    classId,
    profileId,
    isStaff
  }: {
    client: SupabaseClient<Database>;
    classId: number;
    profileId: string;
    isStaff: boolean;
  }) {
    this._client = client;
    this._classId = classId;
    this._profileId = profileId;
    this._isStaff = isStaff;

    this._initializeGlobalChannels();
  }

  /**
   * Initialize global channels (help_queues and class staff channel)
   */
  private async _initializeGlobalChannels() {
    const accessToken = await this._client.auth.getSession();
    await this._client.realtime.setAuth(accessToken.data.session?.access_token);

    if (this._closed) {
      return;
    }

    // Initialize global help_queues channel
    this._helpQueuesChannel = this._client.channel("help_queues", {
      config: { private: true }
    });

    this._helpQueuesChannel.on("broadcast", { event: "broadcast" }, (message) => {
      this._handleBroadcastMessage(message.payload as BroadcastMessage);
    });

    this._helpQueuesChannel.subscribe((status, err) => {
      console.log(`Help queues channel status: help_queues`, status, err);
      this._notifyStatusChange();
    });

    // Initialize class-level staff channel if user is staff
    // This channel receives broadcasts for student_karma_notes and help_request_moderation
    if (this._isStaff) {
      this._classStaffChannel = this._client.channel(`class:${this._classId}:staff`, {
        config: { private: true }
      });

      this._classStaffChannel.on("broadcast", { event: "broadcast" }, (message) => {
        this._handleBroadcastMessage(message.payload as BroadcastMessage);
      });

      this._classStaffChannel.subscribe((status, err) => {
        console.log(`Class staff channel status: class:${this._classId}:staff`, status, err);
        this._notifyStatusChange();
      });
    }
  }

  /**
   * Ensure help request channels are created for a given help request
   */
  private _ensureHelpRequestChannels(helpRequestId: number) {
    if (this._closed) {
      return;
    }

    // Create main help request channel if it doesn't exist
    if (!this._helpRequestChannels.has(helpRequestId)) {
      const mainChannelName = `help_request:${helpRequestId}`;
      const mainChannel = this._client.channel(mainChannelName, {
        config: { private: true }
      });

      mainChannel.on("broadcast", { event: "broadcast" }, (message) => {
        this._handleBroadcastMessage(message.payload as BroadcastMessage);
      });

      mainChannel.subscribe((status, err) => {
        console.log(`Help request channel status: ${mainChannelName}`, status, err);
        this._notifyStatusChange();
      });

      this._helpRequestChannels.set(helpRequestId, mainChannel);
    }

    // Create staff channel if user is staff and doesn't exist
    if (this._isStaff && !this._helpRequestStaffChannels.has(helpRequestId)) {
      const staffChannelName = `help_request:${helpRequestId}:staff`;
      const staffChannel = this._client.channel(staffChannelName, {
        config: { private: true }
      });

      staffChannel.on("broadcast", { event: "broadcast" }, (message) => {
        this._handleBroadcastMessage(message.payload as BroadcastMessage);
      });

      staffChannel.subscribe((status, err) => {
        console.log(`Help request staff channel status: ${staffChannelName}`, status, err);
        this._notifyStatusChange();
      });

      this._helpRequestStaffChannels.set(helpRequestId, staffChannel);
    }
  }

  /**
   * Ensure help queue channel is created for a given help queue
   */
  private _ensureHelpQueueChannel(helpQueueId: number) {
    if (this._closed) {
      return;
    }

    if (!this._helpQueueChannels.has(helpQueueId)) {
      const channelName = `help_queue:${helpQueueId}`;
      const channel = this._client.channel(channelName, {
        config: { private: true }
      });

      channel.on("broadcast", { event: "broadcast" }, (message) => {
        this._handleBroadcastMessage(message.payload as BroadcastMessage);
      });

      channel.subscribe((status, err) => {
        console.log(`Help queue channel status: ${channelName}`, status, err);
        this._notifyStatusChange();
      });

      this._helpQueueChannels.set(helpQueueId, channel);
    }
  }

  /**
   * Handle incoming broadcast messages and route them to relevant subscriptions
   */
  private _handleBroadcastMessage(message: BroadcastMessage) {
    console.log("Received office hours broadcast message:", message);

    // Skip system messages like channel_created
    if (message.type === "channel_created" || message.type === "system") {
      return;
    }

    // Notify all relevant subscriptions
    for (const subscription of this._subscriptions.values()) {
      if (this._messageMatchesFilter(message, subscription.filter)) {
        subscription.callback(message);
      }
    }
  }

  /**
   * Check if a message matches the given filter
   */
  private _messageMatchesFilter(message: BroadcastMessage, filter: MessageFilter): boolean {
    if (filter.type && message.type !== filter.type) {
      return false;
    }

    if (filter.table && message.table !== filter.table) {
      return false;
    }

    if (filter.help_request_id && message.help_request_id !== filter.help_request_id) {
      return false;
    }

    if (filter.help_queue_id && message.help_queue_id !== filter.help_queue_id) {
      return false;
    }

    if (filter.student_profile_id && message.student_profile_id !== filter.student_profile_id) {
      return false;
    }

    return true;
  }

  /**
   * Subscribe to broadcast messages with optional filtering
   */
  subscribe(filter: MessageFilter, callback: MessageCallback): () => void {
    if (this._closed) {
      throw new Error("Cannot subscribe to office hours channels after they have been closed");
    }

    const subscriptionId = `sub_${++this._subscriptionCounter}`;

    this._subscriptions.set(subscriptionId, {
      id: subscriptionId,
      filter,
      callback
    });

    // Ensure relevant channels are created based on filter
    if (filter.help_request_id) {
      this._ensureHelpRequestChannels(filter.help_request_id);
    }

    if (filter.help_queue_id) {
      this._ensureHelpQueueChannel(filter.help_queue_id);
    }

    // Return unsubscribe function
    return () => {
      this._subscriptions.delete(subscriptionId);
    };
  }

  /**
   * Subscribe to all messages for a specific help request
   */
  subscribeToHelpRequest(helpRequestId: number, callback: MessageCallback): () => void {
    return this.subscribe({ help_request_id: helpRequestId }, callback);
  }

  /**
   * Subscribe to staff data changes for a help request
   */
  subscribeToHelpRequestStaffData(helpRequestId: number, callback: MessageCallback): () => void {
    if (!this._isStaff) {
      return () => {};
    }

    return this.subscribe(
      {
        type: "staff_data_change",
        help_request_id: helpRequestId
      },
      callback
    );
  }

  /**
   * Subscribe to help queue changes
   */
  subscribeToHelpQueue(helpQueueId: number, callback: MessageCallback): () => void {
    return this.subscribe({ help_queue_id: helpQueueId }, callback);
  }

  /**
   * Subscribe to all help queues changes
   */
  subscribeToAllHelpQueues(callback: MessageCallback): () => void {
    return this.subscribe({ type: "queue_change" }, callback);
  }

  /**
   * Subscribe to messages for a specific table
   */
  subscribeToTable(table: string, callback: MessageCallback): () => void {
    return this.subscribe({ table }, callback);
  }

  /**
   * Get current connection status
   */
  getConnectionStatus(): ConnectionStatus {
    const channels: ChannelStatus[] = [];

    // Add help_queues channel
    if (this._helpQueuesChannel) {
      channels.push({
        name: "help_queues",
        state: this._helpQueuesChannel.state,
        type: "help_queues"
      });
    }

    // Add class staff channel
    if (this._classStaffChannel) {
      channels.push({
        name: `class:${this._classId}:staff`,
        state: this._classStaffChannel.state,
        type: "class_staff"
      });
    }

    // Add help request channels
    for (const [helpRequestId, channel] of this._helpRequestChannels.entries()) {
      channels.push({
        name: `help_request:${helpRequestId}`,
        state: channel.state,
        type: "help_request",
        help_request_id: helpRequestId
      });
    }

    // Add help request staff channels
    for (const [helpRequestId, channel] of this._helpRequestStaffChannels.entries()) {
      channels.push({
        name: `help_request:${helpRequestId}:staff`,
        state: channel.state,
        type: "help_request_staff",
        help_request_id: helpRequestId
      });
    }

    // Add help queue channels
    for (const [helpQueueId, channel] of this._helpQueueChannels.entries()) {
      channels.push({
        name: `help_queue:${helpQueueId}`,
        state: channel.state,
        type: "help_queue",
        help_queue_id: helpQueueId
      });
    }

    // Calculate overall status
    const connectedCount = channels.filter((c) => c.state === "joined").length;
    const totalCount = channels.length;

    let overall: ConnectionStatus["overall"];
    if (totalCount === 0) {
      overall = "connecting";
    } else if (connectedCount === totalCount) {
      overall = "connected";
    } else if (connectedCount === 0) {
      overall = "disconnected";
    } else {
      overall = "partial";
    }

    return {
      overall,
      channels,
      lastUpdate: new Date()
    };
  }

  /**
   * Subscribe to status changes
   */
  subscribeToStatus(callback: (status: ConnectionStatus) => void): () => void {
    this._statusChangeListeners.push(callback);
    return () => {
      this._statusChangeListeners = this._statusChangeListeners.filter((l) => l !== callback);
    };
  }

  /**
   * Notify status change listeners
   */
  private _notifyStatusChange() {
    const status = this.getConnectionStatus();
    this._statusChangeListeners.forEach((listener) => listener(status));
  }

  /**
   * Check if the controller is ready (channels subscribed)
   */
  get isReady(): boolean {
    const helpQueuesReady = !this._helpQueuesChannel || this._helpQueuesChannel.state === "joined";
    const classStaffReady = !this._classStaffChannel || this._classStaffChannel.state === "joined";

    const helpRequestChannelsReady = Array.from(this._helpRequestChannels.values()).every(
      (channel) => channel.state === "joined"
    );

    const helpRequestStaffChannelsReady = Array.from(this._helpRequestStaffChannels.values()).every(
      (channel) => channel.state === "joined"
    );

    const helpQueueChannelsReady = Array.from(this._helpQueueChannels.values()).every(
      (channel) => channel.state === "joined"
    );

    return (
      helpQueuesReady &&
      classStaffReady &&
      helpRequestChannelsReady &&
      helpRequestStaffChannelsReady &&
      helpQueueChannelsReady
    );
  }

  /**
   * Wait for channels to be ready
   */
  async waitForReady(): Promise<void> {
    return new Promise((resolve) => {
      const checkReady = () => {
        if (this.isReady) {
          resolve();
        } else {
          setTimeout(checkReady, 100);
        }
      };
      checkReady();
    });
  }

  /**
   * Clean up channels and subscriptions
   */
  close() {
    this._closed = true;
    this._subscriptions.clear();
    this._statusChangeListeners = [];

    if (this._helpQueuesChannel) {
      this._helpQueuesChannel.unsubscribe();
      this._helpQueuesChannel = null;
    }

    if (this._classStaffChannel) {
      this._classStaffChannel.unsubscribe();
      this._classStaffChannel = null;
    }

    // Clean up help request channels
    for (const channel of this._helpRequestChannels.values()) {
      channel.unsubscribe();
    }
    this._helpRequestChannels.clear();

    // Clean up help request staff channels
    for (const channel of this._helpRequestStaffChannels.values()) {
      channel.unsubscribe();
    }
    this._helpRequestStaffChannels.clear();

    // Clean up help queue channels
    for (const channel of this._helpQueueChannels.values()) {
      channel.unsubscribe();
    }
    this._helpQueueChannels.clear();
  }

  /**
   * Get debug info about current state
   */
  getDebugInfo() {
    return {
      classId: this._classId,
      profileId: this._profileId,
      isStaff: this._isStaff,
      helpQueuesChannelState: this._helpQueuesChannel?.state,
      classStaffChannelState: this._classStaffChannel?.state,
      helpRequestChannelCount: this._helpRequestChannels.size,
      helpRequestStaffChannelCount: this._helpRequestStaffChannels.size,
      helpQueueChannelCount: this._helpQueueChannels.size,
      subscriptionCount: this._subscriptions.size,
      subscriptions: Array.from(this._subscriptions.values()).map((sub) => ({
        id: sub.id,
        filter: sub.filter
      }))
    };
  }
}
