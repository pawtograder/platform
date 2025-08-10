import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/realtime-js";
import { RealtimeChannelManager } from "./RealtimeChannelManager";
import { OfficeHoursBroadcastMessage } from "@/utils/supabase/DatabaseTypes";
import { createLogger } from "./DebugLogger";

const log = createLogger("OfficeHoursRTC");

type MessageFilter = {
  type?: OfficeHoursBroadcastMessage["type"];
  table?: string;
  help_request_id?: number;
  help_queue_id?: number;
  student_profile_id?: string;
};

type MessageCallback = (message: OfficeHoursBroadcastMessage) => void;

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
  private _channelManager: RealtimeChannelManager;
  private _channelUnsubscribers: Map<string, () => void> = new Map();

  // Subscription management
  private _subscriptions: Map<string, MessageSubscription> = new Map();
  private _subscriptionCounter = 0;
  private _statusChangeListeners: ((status: ConnectionStatus) => void)[] = [];
  private _objDebugId = `${new Date().getTime()}-${Math.random()}`;
  private _closed = false;
  private _started = false;
  private _initializationPromise: Promise<void>;

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
    this._channelManager = RealtimeChannelManager.getInstance();

    log.info("construct", { classId, profileId, isStaff });

    // Set the client on the channel manager
    this._channelManager.setClient(client);

    // Start async initialization immediately
    this._initializationPromise = this._initializeGlobalChannels();
  }

  /**
   * Start the realtime controller
   * Returns true when initialization is complete
   */
  async start(): Promise<boolean> {
    if (this._started) {
      await this._initializationPromise;
      return true;
    }

    this._started = true;

    // Wait for initialization that started in constructor
    await this._initializationPromise;

    return true;
  }

  /**
   * Initialize global channels (help_queues and class staff channel)
   */
  private async _initializeGlobalChannels() {
    console.log(
      `Initializing global channels for class ${this._classId} with profile ${this._profileId} (Staff: ${this._isStaff})`
    );

    if (this._closed) {
      return;
    }

    log.info("init globals");

    // Session refresh is now handled by the channel manager

    // Initialize global help_queues channel
    const helpQueuesUnsubscriber = await this._channelManager.subscribe(
      "help_queues",
      (message: OfficeHoursBroadcastMessage) => {
        this._handleBroadcastMessage(message);
      },
      async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
        console.log(`Help queues channel status: help_queues`, status, err);
        log.debug("status", { topic: "help_queues", status, err: err?.message });
        this._notifyStatusChange();
      }
    );

    this._channelUnsubscribers.set("help_queues", helpQueuesUnsubscriber);

    // Initialize class-level staff channel if user is staff
    // This channel receives broadcasts for student_karma_notes and help_request_moderation
    if (this._isStaff) {
      const staffChannelTopic = `class:${this._classId}:staff`;
      const staffUnsubscriber = await this._channelManager.subscribe(
        staffChannelTopic,
        (message: OfficeHoursBroadcastMessage) => {
          this._handleBroadcastMessage(message);
        },
        async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
          console.log(`Class staff channel status: ${staffChannelTopic}`, status, err);
          log.debug("status", { topic: staffChannelTopic, status, err: err?.message });
          this._notifyStatusChange();
        }
      );

      this._channelUnsubscribers.set(staffChannelTopic, staffUnsubscriber);
    }
  }

  /**
   * Ensure help request channels are created for a given help request
   */
  private async _ensureHelpRequestChannels(helpRequestId: number) {
    if (this._closed) {
      return;
    }

    // Create main help request channel if it doesn't exist
    const mainChannelName = `help_request:${helpRequestId}`;
    if (!this._channelUnsubscribers.has(mainChannelName)) {
      const mainUnsubscriber = await this._channelManager.subscribe(
        mainChannelName,
        (message: OfficeHoursBroadcastMessage) => {
          this._handleBroadcastMessage(message);
        },
        async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
          console.log(`Help request channel status: ${mainChannelName}`, status, err);
          log.debug("status", { topic: mainChannelName, status, err: err?.message });
          this._notifyStatusChange();
        }
      );

      this._channelUnsubscribers.set(mainChannelName, mainUnsubscriber);
    }

    // Create staff channel if user is staff and doesn't exist
    if (this._isStaff) {
      const staffChannelName = `help_request:${helpRequestId}:staff`;
      if (!this._channelUnsubscribers.has(staffChannelName)) {
        const staffUnsubscriber = await this._channelManager.subscribe(
          staffChannelName,
          (message: OfficeHoursBroadcastMessage) => {
            this._handleBroadcastMessage(message);
          },
          async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
            console.log(`Help request staff channel status: ${staffChannelName}`, status, err);
            log.debug("status", { topic: staffChannelName, status, err: err?.message });
            this._notifyStatusChange();
          }
        );

        this._channelUnsubscribers.set(staffChannelName, staffUnsubscriber);
      }
    }
  }

  /**
   * Ensure help queue channel is created for a given help queue
   */
  private async _ensureHelpQueueChannel(helpQueueId: number) {
    if (this._closed) {
      return;
    }

    const channelName = `help_queue:${helpQueueId}`;
    if (!this._channelUnsubscribers.has(channelName)) {
      const unsubscriber = await this._channelManager.subscribe(
        channelName,
        (message: OfficeHoursBroadcastMessage) => {
          this._handleBroadcastMessage(message);
        },
        async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
          console.log(`Help queue channel status: ${channelName}`, status, err);
          log.debug("status", { topic: channelName, status, err: err?.message });
          this._notifyStatusChange();
        }
      );

      this._channelUnsubscribers.set(channelName, unsubscriber);
    }
  }

  /**
   * Handle incoming broadcast messages and route them to relevant subscriptions
   */
  private _handleBroadcastMessage(message: OfficeHoursBroadcastMessage) {
    console.log("Received office hours broadcast message:", message);

    // Skip system messages like channel_created
    if (message.type === "channel_created" || message.type === "system") {
      return;
    }

    log.debug("broadcast", { type: message.type, table: message.table, op: message.operation, row_id: message.row_id });

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
  private _messageMatchesFilter(message: OfficeHoursBroadcastMessage, filter: MessageFilter): boolean {
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

    // Ensure relevant channels are created based on filter (fire and forget)
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
    if (this._closed) {
      throw new Error("Cannot subscribe to office hours channels after they have been closed");
    }
    // Ensure submission channels are created (fire and forget)
    this._ensureHelpRequestChannels(helpRequestId);

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
    if (this._closed) {
      throw new Error("Cannot subscribe to office hours channels after they have been closed");
    }
    // Ensure help queue channel is created (fire and forget)
    this._ensureHelpQueueChannel(helpQueueId);

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
    const managerInfo = this._channelManager.getDebugInfo();

    // Map managed channels to our status format
    for (const channelInfo of managerInfo.channels) {
      const topic = channelInfo.topic;
      let type: ChannelStatus["type"];
      let help_request_id: number | undefined;
      let help_queue_id: number | undefined;

      // Check if this channel is relevant to this controller
      if (topic === "help_queues") {
        type = "help_queues";
      } else if (topic === `class:${this._classId}:staff` && this._isStaff) {
        type = "class_staff";
      } else if (topic.startsWith("help_request:") && topic.includes(":staff") && this._isStaff) {
        type = "help_request_staff";
        help_request_id = parseInt(topic.split(":")[1]);
      } else if (topic.startsWith("help_request:") && !topic.includes(":staff")) {
        type = "help_request";
        help_request_id = parseInt(topic.split(":")[1]);
      } else if (topic.startsWith("help_queue:")) {
        type = "help_queue";
        help_queue_id = parseInt(topic.split(":")[1]);
      } else {
        continue; // Skip channels that don't belong to this controller
      }

      channels.push({
        name: topic,
        state: channelInfo.state as ChannelStatus["state"],
        type,
        help_request_id,
        help_queue_id
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
    const status = this.getConnectionStatus();
    return status.overall === "connected";
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

    // Unsubscribe from all channels using the stored unsubscribe functions
    for (const unsubscriber of this._channelUnsubscribers.values()) {
      unsubscriber();
    }
    this._channelUnsubscribers.clear();

    this._started = false;
  }

  /**
   * Get debug info about current state
   */
  getDebugInfo() {
    return {
      classId: this._classId,
      profileId: this._profileId,
      isStaff: this._isStaff,
      started: this._started,
      closed: this._closed,
      channelUnsubscribers: Array.from(this._channelUnsubscribers.keys()),
      subscriptionCount: this._subscriptions.size,
      subscriptions: Array.from(this._subscriptions.values()).map((sub) => ({
        id: sub.id,
        filter: sub.filter
      })),
      channelManagerInfo: this._channelManager.getDebugInfo()
    };
  }
}
