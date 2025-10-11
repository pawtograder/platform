import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import * as Sentry from "@sentry/nextjs";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/realtime-js";
import { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { RealtimeChannelManager } from "./RealtimeChannelManager";

type DatabaseTableTypes = Database["public"]["Tables"];
type TablesThatHaveAnIDField = {
  [K in keyof DatabaseTableTypes]: DatabaseTableTypes[K]["Row"] extends { id: number | string } ? K : never;
}[keyof DatabaseTableTypes];

// Extend known broadcast tables to include row-level recalculation state
type KnownBroadcastTables = TablesThatHaveAnIDField | "gradebook_row_recalc_state";

export type BroadcastMessage = {
  type: "table_change" | "channel_created" | "system" | "staff_data_change";
  operation?: "INSERT" | "UPDATE" | "DELETE";
  table?: KnownBroadcastTables;
  row_id?: number | string;
  data?: Record<string, unknown>;
  submission_id?: number;
  class_id: number;
  target_audience?: "user" | "staff";
  timestamp: string;
};

type MessageFilter = {
  table?: KnownBroadcastTables;
  submission_id?: number;
  operation?: "INSERT" | "UPDATE" | "DELETE";
};

type MessageCallback = (message: BroadcastMessage) => void;

interface MessageSubscription {
  id: string;
  filter: MessageFilter;
  callback: MessageCallback;
}

export type ChannelStatus = {
  name: string;
  state: string;
  type: "staff" | "user" | "submission_graders" | "submission_user";
  submissionId?: number;
};

export type ConnectionStatus = {
  overall: "connected" | "partial" | "disconnected" | "connecting";
  channels: ChannelStatus[];
  lastUpdate: Date;
};

export type ClassRealTimeControllerConfig = {
  /** The number of milliseconds to wait before disconnecting from realtime when the document is not visible.
   * Default is 10 minutes.
   */
  inactiveTabTimeoutSeconds?: number;
};

export class ClassRealTimeController {
  private _client: SupabaseClient<Database>;
  private _classId: number;
  private _profileId: string;
  private _isStaff: boolean;
  private _channelManager: RealtimeChannelManager;
  private _channelUnsubscribers: Map<string, () => void> = new Map();
  private _subscriptions: Map<string, MessageSubscription> = new Map();
  private _subscriptionCounter = 0;
  private _statusChangeListeners: ((status: ConnectionStatus) => void)[] = [];
  private _closed = false;
  private _submissionChannelRefCounts: Map<number, number> = new Map();

  //Realtime reliability features
  private _inactiveTabTimeoutSeconds = 10 * 60; // 10 minutes default
  private _inactiveTabTimer: ReturnType<typeof setTimeout> | undefined;
  private _visibilityChangeListener: (() => void) | undefined;
  private _started = false;
  private _initializationPromise: Promise<void>;

  constructor({
    client,
    classId,
    profileId,
    isStaff,
    config
  }: {
    client: SupabaseClient<Database>;
    classId: number;
    profileId: string;
    isStaff: boolean;
    config?: ClassRealTimeControllerConfig;
  }) {
    this._client = client;
    this._classId = classId;
    this._profileId = profileId;
    this._isStaff = isStaff;
    this._channelManager = RealtimeChannelManager.getInstance();

    if (config?.inactiveTabTimeoutSeconds) {
      this._inactiveTabTimeoutSeconds = config.inactiveTabTimeoutSeconds;
    }

    // Start async initialization immediately
    this._initializationPromise = this._initializeChannels();
  }

  get isStaff(): boolean {
    return this._isStaff;
  }

  get profileId(): string {
    return this._profileId;
  }
  /**
   * Start the realtime controller with enhanced features
   * Returns true when initialization is complete
   */
  async start(): Promise<boolean> {
    if (this._started) {
      await this._initializationPromise;
      return true;
    }

    this._started = true;
    this._addOnVisibilityChangeListener();

    // Wait for initialization that started in constructor
    await this._initializationPromise;

    return true;
  }

  private _authUnsubscriber?: ReturnType<typeof this._client.auth.onAuthStateChange>;
  private async _initializeChannels() {
    if (this._closed) {
      return;
    }

    this._authUnsubscriber = this._client.auth.onAuthStateChange((event, session) => {
      Sentry.addBreadcrumb({
        category: "realtime",
        message: `Auth state changed: ${event}`,
        data: {
          event,
          session: { userId: session?.user?.id, expiresAt: session?.expires_at }
        }
      });
    });

    await this._subscribeToUserChannel();

    // Initialize staff channel if user is staff
    if (this._isStaff) {
      await this._subscribeToStaffChannel();
    } else {
      await this._subscribeToStudentsChannel();
    }
  }

  /**
   * Enhanced subscription state event handling from RealtimeHandler
   */
  private async _handleSubscriptionStateEvent(
    channel: RealtimeChannel,
    status: REALTIME_SUBSCRIBE_STATES,
    err: Error | undefined
  ) {
    const channelName = this._getChannelDisplayName(channel);

    switch (status) {
      case REALTIME_SUBSCRIBE_STATES.SUBSCRIBED: {
        console.debug(`Successfully subscribed to '${channelName}'`);
        this._notifyStatusChange();
        break;
      }
      case REALTIME_SUBSCRIBE_STATES.CLOSED: {
        console.debug("Class Client debug info:", this.getDebugInfo());
        console.debug(`Channel closed '${channelName}'`);
        this._notifyStatusChange();
        break;
      }
      case REALTIME_SUBSCRIBE_STATES.TIMED_OUT: {
        console.debug(`Channel timed out '${channelName}'`);
        this._notifyStatusChange();
        break;
      }
      case REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR: {
        console.warn(`Channel error in '${channelName}': `, err?.message);
        this._notifyStatusChange();
        break;
      }
      default: {
        const exhaustiveCheck: never = status;
        throw new Error(`Unknown channel status: ${exhaustiveCheck}`);
      }
    }
  }

  /**
   * Add visibility change listener for enhanced reconnection handling
   */
  private _addOnVisibilityChangeListener() {
    const handler = () => this._handleVisibilityChange();
    document.addEventListener("visibilitychange", handler);

    this._visibilityChangeListener = () => {
      document.removeEventListener("visibilitychange", handler);
    };
  }

  /**
   * Handle visibility changes - disconnect when inactive, reconnect when visible
   */
  private _handleVisibilityChange() {
    if (document.hidden) {
      if (!this._inactiveTabTimer) {
        this._inactiveTabTimer = setTimeout(async () => {
          console.log(`Tab inactive for ${this._inactiveTabTimeoutSeconds} seconds. Disconnecting from realtime.`);
          this._channelManager.disconnectAllChannels();
        }, this._inactiveTabTimeoutSeconds * 1000);
      }
    } else {
      if (this._inactiveTabTimer) {
        clearTimeout(this._inactiveTabTimer);
        this._inactiveTabTimer = undefined;
      }

      this._channelManager.resubscribeToAllChannels();
    }
  }

  private async _subscribeToStaffChannel() {
    if (!this._isStaff) return;

    const topic = `class:${this._classId}:staff`;
    const unsubscriber = await this._channelManager.subscribe(
      topic,
      this._client,
      (message: BroadcastMessage) => {
        this._handleBroadcastMessage(message);
      },
      async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
        await this._handleSubscriptionStateEvent(channel, status, err);
      }
    );

    this._channelUnsubscribers.set(topic, unsubscriber);
  }

  private async _subscribeToStudentsChannel() {
    if (this._isStaff) return;

    const topic = `class:${this._classId}:students`;
    const unsubscriber = await this._channelManager.subscribe(
      topic,
      this._client,
      (message: BroadcastMessage) => {
        this._handleBroadcastMessage(message);
      },
      async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
        await this._handleSubscriptionStateEvent(channel, status, err);
      }
    );

    this._channelUnsubscribers.set(topic, unsubscriber);
  }

  private async _subscribeToUserChannel() {
    const topic = `class:${this._classId}:user:${this._profileId}`;
    const unsubscriber = await this._channelManager.subscribe(
      topic,
      this._client,
      (message: BroadcastMessage) => {
        this._handleBroadcastMessage(message);
      },
      async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
        await this._handleSubscriptionStateEvent(channel, status, err);
      }
    );

    this._channelUnsubscribers.set(topic, unsubscriber);
  }

  private async _subscribeToSubmissionGradersChannel(submissionId: number) {
    if (!this._isStaff) return;

    const topic = `submission:${submissionId}:graders`;
    const unsubscriber = await this._channelManager.subscribe(
      topic,
      this._client,
      (message: BroadcastMessage) => {
        this._handleBroadcastMessage(message);
      },
      async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
        await this._handleSubscriptionStateEvent(channel, status, err);
      }
    );

    // Check if refcount is still > 0, if not immediately unsubscribe
    const currentRefCount = this._submissionChannelRefCounts.get(submissionId) || 0;
    if (currentRefCount <= 0) {
      // Refcount is 0 or negative, immediately unsubscribe and don't store
      unsubscriber();
    } else {
      // Refcount > 0, replace placeholder with real unsubscriber
      this._channelUnsubscribers.set(topic, unsubscriber);
    }
  }

  private async _subscribeToSubmissionUserChannel(submissionId: number) {
    const topic = `submission:${submissionId}:profile_id:${this._profileId}`;
    const unsubscriber = await this._channelManager.subscribe(
      topic,
      this._client,
      (message: BroadcastMessage) => {
        this._handleBroadcastMessage(message);
      },
      async (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => {
        await this._handleSubscriptionStateEvent(channel, status, err);
      }
    );

    // Check if refcount is still > 0, if not immediately unsubscribe
    const currentRefCount = this._submissionChannelRefCounts.get(submissionId) || 0;
    if (currentRefCount <= 0) {
      // Refcount is 0 or negative, immediately unsubscribe and don't store
      unsubscriber();
    } else {
      // Refcount > 0, replace placeholder with real unsubscriber
      this._channelUnsubscribers.set(topic, unsubscriber);
    }
  }

  /**
   * Get display name for a channel
   */
  private _getChannelDisplayName(channel: RealtimeChannel): string {
    return channel.topic;
  }

  private static broadcastCounter = new Map<string, number>();

  private _handleBroadcastMessage(message: BroadcastMessage) {
    const key = `${message.type}-${message.table || "unknown"}-${message.operation || "none"}`;
    const current = ClassRealTimeController.broadcastCounter.get(key) || 0;
    ClassRealTimeController.broadcastCounter.set(key, current + 1);

    // Log summary every 100 broadcasts
    const total = Array.from(ClassRealTimeController.broadcastCounter.values()).reduce((sum, count) => sum + count, 0);

    if (total % 100 === 0) {
      console.log("Broadcast Summary:", Object.fromEntries(ClassRealTimeController.broadcastCounter));
    }

    // Normalize custom payload types from SQL functions to the standard type expected by listeners
    // SQL may emit type "staff_data_change"; treat it as "table_change" for downstream consumers
    const normalized: BroadcastMessage =
      message.type === "staff_data_change"
        ? ({ ...(message as BroadcastMessage), type: "table_change" } as BroadcastMessage)
        : message;

    // Skip system and channel lifecycle messages
    if (normalized.type === "system" || normalized.type === "channel_created") {
      return;
    }

    // Notify all relevant subscriptions
    for (const subscription of this._subscriptions.values()) {
      if (this._messageMatchesFilter(normalized, subscription.filter)) {
        subscription.callback(normalized);
      }
    }
  }

  private _messageMatchesFilter(message: BroadcastMessage, filter: MessageFilter): boolean {
    // Check table filter
    if (filter.table && message.table !== filter.table) {
      return false;
    }

    // Check submission_id filter
    if (filter.submission_id && message.submission_id !== filter.submission_id) {
      return false;
    }

    // Check operation filter
    if (filter.operation && message.operation !== filter.operation) {
      return false;
    }

    return true;
  }

  /**
   * Subscribe to broadcast messages with optional filtering
   */
  subscribe(filter: MessageFilter, callback: MessageCallback): () => void {
    if (this._closed) {
      throw new Error("Cannot subscribe to channels after they have been closed");
    }
    const subscriptionId = `sub_${++this._subscriptionCounter}`;

    this._subscriptions.set(subscriptionId, {
      id: subscriptionId,
      filter,
      callback
    });

    // Return unsubscribe function
    return () => {
      this._subscriptions.delete(subscriptionId);
    };
  }

  /**
   * Subscribe to all messages for a specific table
   */
  subscribeToTable(table: KnownBroadcastTables, callback: MessageCallback): () => void {
    return this.subscribe({ table }, callback);
  }

  /**
   * Subscribe to all messages for a specific table and submission
   */
  subscribeToTableForSubmission(
    table: TablesThatHaveAnIDField,
    submissionId: number,
    callback: MessageCallback
  ): () => void {
    if (this._closed) {
      throw new Error("Cannot subscribe to channels after they have been closed");
    }

    // Ensure submission channels are created and increment ref count
    this._ensureSubmissionChannels(submissionId);

    // Create the message filter subscription
    const filterUnsubscriber = this.subscribe({ table, submission_id: submissionId }, callback);

    // Return unsubscriber that cleans up both filter subscription and submission channels
    return () => {
      filterUnsubscriber();
      this._cleanupSubmissionChannels(submissionId);
    };
  }

  /**
   * Subscribe to all messages for a specific submission (any table)
   */
  subscribeToSubmission(submissionId: number, callback: MessageCallback): () => void {
    if (this._closed) {
      throw new Error("Cannot subscribe to channels after they have been closed");
    }

    // Ensure submission channels are created and increment ref count
    this._ensureSubmissionChannels(submissionId);

    // Create the message filter subscription
    const filterUnsubscriber = this.subscribe({ submission_id: submissionId }, callback);

    // Return unsubscriber that cleans up both filter subscription and submission channels
    return () => {
      filterUnsubscriber();
      this._cleanupSubmissionChannels(submissionId);
    };
  }

  /**
   * Get the appropriate channel name for broadcasting (used by server-side functions)
   */
  getStaffChannelName(): string {
    return `class:${this._classId}:staff`;
  }

  getUserChannelName(): string {
    return `class:${this._classId}:user:${this._profileId}`;
  }

  /**
   * Ensure submission-specific channels are created for a given submission
   * Increments reference count for tracking
   */
  private _ensureSubmissionChannels(submissionId: number) {
    const currentRefCount = this._submissionChannelRefCounts.get(submissionId) || 0;

    // Only create channels if this is the first subscription
    if (currentRefCount === 0) {
      // Create graders channel if user is staff
      if (this._isStaff) {
        const gradersChannelKey = `submission:${submissionId}:graders`;
        // Set placeholder unsubscriber immediately
        this._channelUnsubscribers.set(gradersChannelKey, () => {
          // Placeholder is a no-op, real unsubscriber will be set when async resolves
        });
        this._subscribeToSubmissionGradersChannel(submissionId);
      }

      // Create user channel for this submission
      const userChannelKey = `submission:${submissionId}:profile_id:${this._profileId}`;
      // Set placeholder unsubscriber immediately
      this._channelUnsubscribers.set(userChannelKey, () => {
        // Placeholder is a no-op, real unsubscriber will be set when async resolves
      });
      this._subscribeToSubmissionUserChannel(submissionId);
    }

    // Increment reference count
    this._submissionChannelRefCounts.set(submissionId, currentRefCount + 1);
  }

  /**
   * Clean up submission-specific channels when no longer needed
   * Decrements reference count and removes channels when count reaches 0
   */
  private _cleanupSubmissionChannels(submissionId: number) {
    const currentRefCount = this._submissionChannelRefCounts.get(submissionId) || 0;

    if (currentRefCount <= 1) {
      // Last reference, unsubscribe from channels
      const gradersChannelKey = `submission:${submissionId}:graders`;
      const userChannelKey = `submission:${submissionId}:profile_id:${this._profileId}`;

      const gradersUnsubscriber = this._channelUnsubscribers.get(gradersChannelKey);
      if (gradersUnsubscriber) {
        gradersUnsubscriber();
        this._channelUnsubscribers.delete(gradersChannelKey);
      }

      const userUnsubscriber = this._channelUnsubscribers.get(userChannelKey);
      if (userUnsubscriber) {
        userUnsubscriber();
        this._channelUnsubscribers.delete(userChannelKey);
      }

      this._submissionChannelRefCounts.delete(submissionId);
    } else {
      // Decrement reference count
      this._submissionChannelRefCounts.set(submissionId, currentRefCount - 1);
    }
  }

  /**
   * Clean up channels and subscriptions
   */
  async close() {
    this._subscriptions.clear();
    this._statusChangeListeners = [];
    this._submissionChannelRefCounts.clear();

    // Clear timers and listeners
    if (this._inactiveTabTimer) {
      clearTimeout(this._inactiveTabTimer);
      this._inactiveTabTimer = undefined;
    }

    if (this._visibilityChangeListener) {
      this._visibilityChangeListener();
      this._visibilityChangeListener = undefined;
    }

    // Unsubscribe from all channels using the stored unsubscribe functions
    for (const unsubscriber of this._channelUnsubscribers.values()) {
      unsubscriber();
    }
    this._channelUnsubscribers.clear();

    if (this._authUnsubscriber) {
      this._authUnsubscriber.data.subscription.unsubscribe();
      this._authUnsubscriber = undefined;
    }

    this._closed = true;
    this._started = false;
  }

  /**
   * Subscribe to connection status changes
   */
  subscribeToStatus(callback: (status: ConnectionStatus) => void): () => void {
    this._statusChangeListeners.push(callback);

    return () => {
      this._statusChangeListeners = this._statusChangeListeners.filter((cb) => cb !== callback);
    };
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
      let submissionId: number | undefined;

      // Check if this channel is relevant to this controller
      if (topic === `class:${this._classId}:staff` && this._isStaff) {
        type = "staff";
      } else if (topic === `class:${this._classId}:user:${this._profileId}`) {
        type = "user";
      } else if (topic.startsWith("submission:") && topic.includes(":graders") && this._isStaff) {
        type = "submission_graders";
        submissionId = parseInt(topic.split(":")[1]);
      } else if (topic.startsWith("submission:") && topic.includes(`:profile_id:${this._profileId}`)) {
        type = "submission_user";
        submissionId = parseInt(topic.split(":")[1]);
      } else {
        continue; // Skip channels that don't belong to this controller
      }

      channels.push({
        name: topic,
        state: channelInfo.state,
        type,
        submissionId
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
   * Notify status change listeners
   */
  private _notifyStatusChange() {
    const status = this.getConnectionStatus();
    Sentry.addBreadcrumb({
      category: "realtime",
      message: "Connection status changed",
      data: {
        status
      }
    });
    this._statusChangeListeners.forEach((callback) => callback(status));
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
      inactiveTabTimeoutSeconds: this._inactiveTabTimeoutSeconds,
      hasInactiveTabTimer: !!this._inactiveTabTimer,
      hasVisibilityChangeListener: !!this._visibilityChangeListener,
      channelUnsubscribers: Array.from(this._channelUnsubscribers.keys()),
      subscriptionCount: this._subscriptions.size,
      subscriptions: Array.from(this._subscriptions.values()).map((sub) => ({
        id: sub.id,
        filter: sub.filter
      })),
      submissionChannelRefCounts: Object.fromEntries(this._submissionChannelRefCounts),
      channelManagerInfo: this._channelManager.getDebugInfo()
    };
  }
}
