import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { SupabaseClient } from "@supabase/supabase-js";
import { RealtimeChannelManager } from "./RealtimeChannelManager";
import { BroadcastMessage } from "./TableController";
import { PawtograderRealTimeController, ChannelStatus, ConnectionStatus } from "./PawtograderRealTimeController";

type MessageFilter = {
  type?: BroadcastMessage["type"];
  table?: string;
  discussion_thread_root_id?: number;
};

type MessageCallback = (message: BroadcastMessage) => void;

interface MessageSubscription {
  id: string;
  filter: MessageFilter;
  callback: MessageCallback;
}

/**
 * Controller for managing per-thread realtime channels.
 * Subscribes to discussion_thread:$root_id channels for targeted realtime updates.
 *
 * This controller manages subscriptions to specific discussion thread channels,
 * enabling efficient realtime updates for users viewing/watching specific threads
 * without broadcasting all thread activity to all students in the class.
 */
export class DiscussionThreadRealTimeController implements PawtograderRealTimeController {
  private _client: SupabaseClient<Database>;
  private _threadRootId: number;
  private _channelManager: RealtimeChannelManager;
  private _channelUnsubscriber?: () => void;

  // Subscription management
  private _subscriptions: Map<string, MessageSubscription> = new Map();
  private _subscriptionCounter = 0;
  private _statusChangeListeners: ((status: ConnectionStatus) => void)[] = [];
  private _statusNotifyTimer?: ReturnType<typeof setTimeout>;
  private _closed = false;
  private _started = false;
  private _initializationPromise: Promise<void>;

  constructor({ client, threadRootId }: { client: SupabaseClient<Database>; threadRootId: number }) {
    this._client = client;
    this._threadRootId = threadRootId;
    this._channelManager = RealtimeChannelManager.getInstance();

    // Start async initialization immediately
    this._initializationPromise = this._initializeThreadChannel();
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
   * Initialize the thread-specific channel
   */
  private async _initializeThreadChannel() {
    if (this._closed) {
      return;
    }

    const channelTopic = `discussion_thread:${this._threadRootId}`;
    const unsubscriber = await this._channelManager.subscribe(
      channelTopic,
      this._client,
      (message: BroadcastMessage) => {
        this._handleBroadcastMessage(message);
      },
      async () => {
        this._notifyStatusChange();
      }
    );

    this._channelUnsubscriber = unsubscriber;
  }

  /**
   * Handle incoming broadcast messages and route to subscribers
   */
  private _handleBroadcastMessage(message: BroadcastMessage) {
    if (this._closed) {
      return;
    }

    // Notify all matching subscriptions
    for (const subscription of this._subscriptions.values()) {
      if (this._messageMatchesFilter(message, subscription.filter)) {
        subscription.callback(message);
      }
    }
  }

  /**
   * Check if a message matches a subscription filter
   */
  private _messageMatchesFilter(message: BroadcastMessage, filter: MessageFilter): boolean {
    if (filter.type && message.type !== filter.type) {
      return false;
    }

    if (filter.table && message.table !== filter.table) {
      return false;
    }

    if (
      filter.discussion_thread_root_id !== undefined &&
      ("discussion_thread_root_id" in message
        ? message.discussion_thread_root_id !== filter.discussion_thread_root_id
        : true)
    ) {
      return false;
    }

    return true;
  }

  /**
   * Subscribe to table changes within this thread
   */
  subscribeToTable(table: string, callback: MessageCallback): () => void {
    const subscriptionId = `${table}-${this._subscriptionCounter++}`;

    const subscription: MessageSubscription = {
      id: subscriptionId,
      filter: { table },
      callback
    };

    this._subscriptions.set(subscriptionId, subscription);

    return () => {
      this._subscriptions.delete(subscriptionId);
    };
  }

  /**
   * Subscribe to connection status changes
   */
  subscribeToStatus(callback: (status: ConnectionStatus) => void): () => void {
    this._statusChangeListeners.push(callback);

    // Immediately notify with current status
    callback(this.getConnectionStatus());

    return () => {
      this._statusChangeListeners = this._statusChangeListeners.filter((l) => l !== callback);
    };
  }

  /**
   * Get current connection status
   */
  getConnectionStatus(): ConnectionStatus {
    const channelTopic = `discussion_thread:${this._threadRootId}`;
    const managerInfo = this._channelManager.getDebugInfo();

    // Find our channel in the manager's channels
    const channelInfo = managerInfo.channels.find((ch) => ch.topic === channelTopic);

    const channelStatus: ChannelStatus = {
      name: channelTopic,
      state: (channelInfo?.state as ChannelStatus["state"]) || "closed",
      type: "discussion_thread_root",
      discussionThreadRootId: this._threadRootId
    };

    const overall =
      channelStatus.state === "joined"
        ? "connected"
        : channelStatus.state === "joining"
          ? "connecting"
          : "disconnected";

    return {
      overall,
      channels: [channelStatus],
      lastUpdate: new Date()
    };
  }

  /**
   * Notify status change listeners (debounced)
   */
  private _notifyStatusChange() {
    if (this._statusNotifyTimer) {
      clearTimeout(this._statusNotifyTimer);
    }

    this._statusNotifyTimer = setTimeout(() => {
      const status = this.getConnectionStatus();
      this._statusChangeListeners.forEach((listener) => listener(status));
    }, 100);
  }

  /**
   * Close the controller and clean up all subscriptions
   */
  async close() {
    if (this._closed) {
      return;
    }

    this._closed = true;

    // Clear status timer
    if (this._statusNotifyTimer) {
      clearTimeout(this._statusNotifyTimer);
    }

    // Unsubscribe from channel
    if (this._channelUnsubscriber) {
      this._channelUnsubscriber();
      this._channelUnsubscriber = undefined;
    }

    // Clear all subscriptions and listeners
    this._subscriptions.clear();
    this._statusChangeListeners = [];
  }
}
