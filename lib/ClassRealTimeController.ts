import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { REALTIME_SUBSCRIBE_STATES } from '@supabase/realtime-js';

type DatabaseTableTypes = Database["public"]["Tables"];
type TablesThatHaveAnIDField = {
  [K in keyof DatabaseTableTypes]: DatabaseTableTypes[K]["Row"] extends { id: number | string } ? K : never;
}[keyof DatabaseTableTypes];

type BroadcastMessage = {
  type: "table_change" | "channel_created" | "system";
  operation?: "INSERT" | "UPDATE" | "DELETE";
  table?: TablesThatHaveAnIDField;
  row_id?: number | string;
  data?: Record<string, unknown>;
  submission_id?: number;
  class_id: number;
  target_audience?: "user" | "staff";
  timestamp: string;
};

type MessageFilter = {
  table?: TablesThatHaveAnIDField;
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

/**
 * Determines if the provided error relates to an expired token.
 */
const isTokenExpiredError = (err: Error) => {
  // For some reason, message has sometimes been undefined. Adding a ? just in case.
  return err.message?.startsWith('"Token has expired');
};

export class ClassRealTimeController {
  private _client: SupabaseClient<Database>;
  private _classId: number;
  private _profileId: string;
  private _isStaff: boolean;
  private _staffChannel: RealtimeChannel | null = null;
  private _userChannel: RealtimeChannel | null = null;
  private _submissionChannels: Map<number, { graders?: RealtimeChannel; user?: RealtimeChannel }> = new Map();
  private _subscriptions: Map<string, MessageSubscription> = new Map();
  private _subscriptionCounter = 0;
  private _statusChangeListeners: ((status: ConnectionStatus) => void)[] = [];
  private _objDebugId = Math.random().toString(36).substring(2, 15);
  private _closed = false;
  
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
    console.log("Creating ClassRealTimeController" + this._objDebugId);
    this._client = client;
    this._classId = classId;
    this._profileId = profileId;
    this._isStaff = isStaff;

    if (config?.inactiveTabTimeoutSeconds) {
      this._inactiveTabTimeoutSeconds = config.inactiveTabTimeoutSeconds;
    }

    // Start async initialization immediately
    this._initializationPromise = this._initializeChannels();
  }

  /**
   * Start the realtime controller with enhanced features
   * Returns true when initialization is complete
   */
  async start(): Promise<boolean> {
    if (this._started) {
      console.warn('ClassRealTimeController has already been started. Ignoring subsequent start call.');
      // Still wait for initialization if it's not done yet
      await this._initializationPromise;
      return true;
    }

    this._started = true;
    this._addOnVisibilityChangeListener();
    
    // Wait for initialization that started in constructor
    await this._initializationPromise;

    return true;
  }

  /**
   * Get cleanup function to close the controller
   */
  getCleanup(): () => void {
    return () => {
      this.close();
    };
  }

  private async _initializeChannels() {
    console.log("Initializing channels", this._objDebugId);
    
    if (this._closed) {
      console.log("Channels already closed", this._objDebugId);
      return;
    }

    await this._refreshSessionIfNeeded();

    // Initialize staff channel if user is staff
    if (this._isStaff) {
      console.log("initializing staff channel");
      this._staffChannel = this._client.channel(`class:${this._classId}:staff`, {
        config: { private: true }
      });

      this._staffChannel.on("broadcast", { event: "broadcast" }, (message) => {
        this._handleBroadcastMessage(message.payload as BroadcastMessage);
      });

      this._staffChannel.subscribe(async (status, err) => {
        console.log(`Staff channel status: class:${this._classId}:staff`, status, err);
        await this._handleSubscriptionStateEvent(this._staffChannel!, status, err);
      });
    }

    // Initialize user channel (all users get their own channel)
    this._userChannel = this._client.channel(`class:${this._classId}:user:${this._profileId}`, {
      config: { private: true }
    });

    this._userChannel.on("broadcast", { event: "broadcast" }, (message) => {
      this._handleBroadcastMessage(message.payload as BroadcastMessage);
    });

    this._userChannel.subscribe(async (status, err) => {
      console.log(`User channel status: class:${this._classId}:user:${this._profileId}`, status, err);
      await this._handleSubscriptionStateEvent(this._userChannel!, status, err);
    });
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
        // We'll just reconnect when the tab becomes visible again.
        // If the tab is hidden, we don't really care about reconnection
        if (document.hidden) {
          console.debug(`Channel error in '${channelName}', but tab is hidden. Removing channel.`);
          await this._client.removeChannel(channel);
          this._removeChannelFromTracking(channel);
          return;
        } else if (err && isTokenExpiredError(err)) {
          console.debug(`Token expired causing channel error in '${channelName}'. Refreshing session.`);
          await this._resubscribeToChannel(channel);
        } else {
          console.warn(`Channel error in '${channelName}': `, err?.message);
        }
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
   * Refreshes the session token if needed and sets the token for Supabase Realtime.
   */
  private async _refreshSessionIfNeeded() {
    const { data, error } = await this._client.auth.getSession();
    if (error) {
      throw error;
    }
    if (!data.session) {
      throw new Error('Session not found');
    }
    if (this._client.realtime.accessTokenValue !== data.session.access_token) {
      await this._client.realtime.setAuth(data.session.access_token);
    }
  }

  /**
   * Add visibility change listener for enhanced reconnection handling
   */
  private _addOnVisibilityChangeListener() {
    const handler = () => this._handleVisibilityChange();
    document.addEventListener('visibilitychange', handler);

    this._visibilityChangeListener = () => {
      document.removeEventListener('visibilitychange', handler);
    };
  }

  /**
   * Handle visibility changes - disconnect when inactive, reconnect when visible
   */
  private _handleVisibilityChange() {
    if (document.hidden) {
      if (!this._inactiveTabTimer) {
        this._inactiveTabTimer = setTimeout(async () => {
          console.log(
            `Tab inactive for ${this._inactiveTabTimeoutSeconds} seconds. Disconnecting from realtime.`
          );
          this._disconnectAllChannels();
        }, this._inactiveTabTimeoutSeconds * 1000);
      }
    } else {
      if (this._inactiveTabTimer) {
        clearTimeout(this._inactiveTabTimer);
        this._inactiveTabTimer = undefined;
      }

      this._resubscribeToAllChannels();
    }
  }

  /**
   * Disconnect all channels without removing them from tracking
   */
  private _disconnectAllChannels() {
    if (this._staffChannel) {
      this._client.removeChannel(this._staffChannel);
    }

    if (this._userChannel) {
      this._client.removeChannel(this._userChannel);
    }

    // Disconnect submission channels
    for (const channels of this._submissionChannels.values()) {
      if (channels.graders) {
        this._client.removeChannel(channels.graders);
      }
      if (channels.user) {
        this._client.removeChannel(channels.user);
      }
    }

    this._notifyStatusChange();
  }

  /**
   * Resubscribe to all channels that should be active
   */
  private async _resubscribeToAllChannels() {
    if (this._closed) return;

    await this._refreshSessionIfNeeded();

    // Recreate and resubscribe to staff channel
    if (this._isStaff && this._staffChannel) {
      await this._resubscribeToStaffChannel();
    }

    // Recreate and resubscribe to user channel
    if (this._userChannel) {
      await this._resubscribeToUserChannel();
    }

    // Recreate and resubscribe to submission channels
    for (const [submissionId, channels] of this._submissionChannels.entries()) {
      if (channels.graders && this._isStaff) {
        await this._resubscribeToSubmissionGradersChannel(submissionId);
      }
      if (channels.user) {
        await this._resubscribeToSubmissionUserChannel(submissionId);
      }
    }
  }

  /**
   * Resubscribe to a specific channel
   */
  private async _resubscribeToChannel(channel: RealtimeChannel) {
    const topic = channel.topic;
    
    // Determine channel type and resubscribe accordingly
    if (topic === `class:${this._classId}:staff`) {
      await this._resubscribeToStaffChannel();
    } else if (topic === `class:${this._classId}:user:${this._profileId}`) {
      await this._resubscribeToUserChannel();
    } else if (topic.startsWith('submission:') && topic.includes(':graders')) {
      const submissionId = parseInt(topic.split(':')[1]);
      await this._resubscribeToSubmissionGradersChannel(submissionId);
    } else if (topic.startsWith('submission:') && topic.includes(':profile_id:')) {
      const submissionId = parseInt(topic.split(':')[1]);
      await this._resubscribeToSubmissionUserChannel(submissionId);
    }
  }

  private async _resubscribeToStaffChannel() {
    if (!this._isStaff) return;

    this._staffChannel = this._client.channel(`class:${this._classId}:staff`, {
      config: { private: true }
    });

    this._staffChannel.on("broadcast", { event: "broadcast" }, (message) => {
      this._handleBroadcastMessage(message.payload as BroadcastMessage);
    });

    this._staffChannel.subscribe(async (status, err) => {
      console.log(`Staff channel status: class:${this._classId}:staff`, status, err);
      await this._handleSubscriptionStateEvent(this._staffChannel!, status, err);
    });
  }

  private async _resubscribeToUserChannel() {
    this._userChannel = this._client.channel(`class:${this._classId}:user:${this._profileId}`, {
      config: { private: true }
    });

    this._userChannel.on("broadcast", { event: "broadcast" }, (message) => {
      this._handleBroadcastMessage(message.payload as BroadcastMessage);
    });

    this._userChannel.subscribe(async (status, err) => {
      console.log(`User channel status: class:${this._classId}:user:${this._profileId}`, status, err);
      await this._handleSubscriptionStateEvent(this._userChannel!, status, err);
    });
  }

  private async _resubscribeToSubmissionGradersChannel(submissionId: number) {
    if (!this._isStaff) return;

    const channels = this._submissionChannels.get(submissionId) || {};
    const gradersChannelName = `submission:${submissionId}:graders`;
    
    channels.graders = this._client.channel(gradersChannelName, {
      config: { private: true }
    });

    channels.graders.on("broadcast", { event: "broadcast" }, (message) => {
      this._handleBroadcastMessage(message.payload as BroadcastMessage);
    });

    channels.graders.subscribe(async (status, err) => {
      console.log(`Submission graders channel status: ${gradersChannelName}`, status, err);
      await this._handleSubscriptionStateEvent(channels.graders!, status, err);
    });

    this._submissionChannels.set(submissionId, channels);
  }

  private async _resubscribeToSubmissionUserChannel(submissionId: number) {
    const channels = this._submissionChannels.get(submissionId) || {};
    const userChannelName = `submission:${submissionId}:profile_id:${this._profileId}`;
    
    channels.user = this._client.channel(userChannelName, {
      config: { private: true }
    });

    channels.user.on("broadcast", { event: "broadcast" }, (message) => {
      this._handleBroadcastMessage(message.payload as BroadcastMessage);
    });

    channels.user.subscribe(async (status, err) => {
      console.log(`Submission user channel status: ${userChannelName}`, status, err);
      await this._handleSubscriptionStateEvent(channels.user!, status, err);
    });

    this._submissionChannels.set(submissionId, channels);
  }

  /**
   * Remove a channel from internal tracking
   */
  private _removeChannelFromTracking(channel: RealtimeChannel) {
    const topic = channel.topic;
    
    if (topic === `class:${this._classId}:staff`) {
      this._staffChannel = null;
    } else if (topic === `class:${this._classId}:user:${this._profileId}`) {
      this._userChannel = null;
    } else if (topic.startsWith('submission:')) {
      // Find and remove from submission channels
      for (const [submissionId, channels] of this._submissionChannels.entries()) {
        if (channels.graders?.topic === topic) {
          channels.graders = undefined;
        }
        if (channels.user?.topic === topic) {
          channels.user = undefined;
        }
        
        // Remove empty submission channel entries
        if (!channels.graders && !channels.user) {
          this._submissionChannels.delete(submissionId);
        }
      }
    }
  }

  /**
   * Get display name for a channel
   */
  private _getChannelDisplayName(channel: RealtimeChannel): string {
    return channel.topic;
  }

  private _handleBroadcastMessage(message: BroadcastMessage) {
    console.log("Received broadcast message:", message);

    // Skip system messages like channel_created
    if (message.type !== "table_change") {
      return;
    }

    // Notify all relevant subscriptions
    for (const subscription of this._subscriptions.values()) {
      if (this._messageMatchesFilter(message, subscription.filter)) {
        subscription.callback(message);
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
  subscribeToTable(table: TablesThatHaveAnIDField, callback: MessageCallback): () => void {
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
    // Ensure submission channels are created
    this._ensureSubmissionChannels(submissionId);

    return this.subscribe({ table, submission_id: submissionId }, callback);
  }

  /**
   * Subscribe to all messages for a specific submission (any table)
   */
  subscribeToSubmission(submissionId: number, callback: MessageCallback): () => void {
    if (this._closed) {
      throw new Error("Cannot subscribe to channels after they have been closed");
    }
    return this.subscribe({ submission_id: submissionId }, callback);
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
   */
  private _ensureSubmissionChannels(submissionId: number) {
    if (this._submissionChannels.has(submissionId)) {
      return; // Already created
    }

    const channels: { graders?: RealtimeChannel; user?: RealtimeChannel } = {};

    // Create graders channel if user is staff
    if (this._isStaff) {
      const gradersChannelName = `submission:${submissionId}:graders`;
      channels.graders = this._client.channel(gradersChannelName, {
        config: { private: true }
      });

      channels.graders.on("broadcast", { event: "broadcast" }, (message) => {
        this._handleBroadcastMessage(message.payload as BroadcastMessage);
      });

      channels.graders.subscribe(async (status, err) => {
        console.log(`Submission graders channel status: ${gradersChannelName}`, status, err);
        await this._handleSubscriptionStateEvent(channels.graders!, status, err);
      });
    }

    // Create user channel for this submission
    const userChannelName = `submission:${submissionId}:profile_id:${this._profileId}`;
    channels.user = this._client.channel(userChannelName, {
      config: { private: true }
    });

    channels.user.on("broadcast", { event: "broadcast" }, (message) => {
      this._handleBroadcastMessage(message.payload as BroadcastMessage);
    });

    channels.user.subscribe(async (status, err) => {
      console.log(`Submission user channel status: ${userChannelName}`, status, err);
      await this._handleSubscriptionStateEvent(channels.user!, status, err);
    });

    this._submissionChannels.set(submissionId, channels);
  }

  /**
   * Clean up channels and subscriptions
   */
  close() {
    console.log("Closing ClassRealTimeController channels", this._objDebugId);
    this._closed = true;
    this._started = false;
    this._subscriptions.clear();
    this._statusChangeListeners = [];

    // Clear timers and listeners
    if (this._inactiveTabTimer) {
      clearTimeout(this._inactiveTabTimer);
      this._inactiveTabTimer = undefined;
    }

    if (this._visibilityChangeListener) {
      this._visibilityChangeListener();
      this._visibilityChangeListener = undefined;
    }

    if (this._staffChannel) {
      this._client.removeChannel(this._staffChannel);
      this._staffChannel = null;
    }

    if (this._userChannel) {
      this._client.removeChannel(this._userChannel);
      this._userChannel = null;
    }

    // Clean up submission channels
    for (const channels of this._submissionChannels.values()) {
      if (channels.graders) {
        this._client.removeChannel(channels.graders);
      }
      if (channels.user) {
        this._client.removeChannel(channels.user);
      }
    }
    this._submissionChannels.clear();
  }

  /**
   * Subscribe to connection status changes
   */
  subscribeToStatus(callback: (status: ConnectionStatus) => void): () => void {
    console.log("Subscribing to status changes", this._objDebugId, this._statusChangeListeners);
    this._statusChangeListeners.push(callback);

    return () => {
      this._statusChangeListeners = this._statusChangeListeners.filter((cb) => cb !== callback);
      console.log("After unsubscribing from status changes", this._objDebugId, this._statusChangeListeners);
    };
  }

  /**
   * Get current connection status
   */
  getConnectionStatus(): ConnectionStatus {
    const channels: ChannelStatus[] = [];

    // Add class-level channels
    if (this._staffChannel) {
      channels.push({
        name: `class:${this._classId}:staff`,
        state: this._staffChannel.state,
        type: "staff"
      });
    }

    if (this._userChannel) {
      channels.push({
        name: `class:${this._classId}:user:${this._profileId}`,
        state: this._userChannel.state,
        type: "user"
      });
    }

    // Add submission channels
    for (const [submissionId, submissionChannels] of this._submissionChannels.entries()) {
      if (submissionChannels.graders) {
        channels.push({
          name: `submission:${submissionId}:graders`,
          state: submissionChannels.graders.state,
          type: "submission_graders",
          submissionId
        });
      }

      if (submissionChannels.user) {
        channels.push({
          name: `submission:${submissionId}:profile_id:${this._profileId}`,
          state: submissionChannels.user.state,
          type: "submission_user",
          submissionId
        });
      }
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
    console.log("Notifying status change listeners", this._objDebugId, status);
    console.log("Status change listeners", this._objDebugId, this._statusChangeListeners);
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
      staffChannelState: this._staffChannel?.state,
      userChannelState: this._userChannel?.state,
      submissionChannels: Array.from(this._submissionChannels.entries()).map(([submissionId, channels]) => ({
        submissionId,
        gradersChannelState: channels.graders?.state,
        userChannelState: channels.user?.state
      })),
      subscriptionCount: this._subscriptions.size,
      subscriptions: Array.from(this._subscriptions.values()).map((sub) => ({
        id: sub.id,
        filter: sub.filter
      }))
    };
  }
}
