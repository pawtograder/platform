import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/realtime-js";

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

type ChannelSubscription = {
  callback: (message: BroadcastMessage) => void;
  statusCallback: (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => void;
};

type ManagedChannel = {
  channel: RealtimeChannel;
  subscriptions: ChannelSubscription[];
  topic: string;
  reconnectAttempts: number;
  lastReconnectTime: number;
  isReconnecting: boolean;
};

/**
 * Singleton that manages Supabase realtime channel subscriptions and routes messages
 * to multiple ClassRealTimeController instances. This prevents issues where multiple
 * controllers try to subscribe to the same channel (only first subscription works).
 */
export class RealtimeChannelManager {
  private static _instance: RealtimeChannelManager | null = null;
  private _channels: Map<string, ManagedChannel> = new Map();
  private _client: SupabaseClient<Database> | null = null;

  // Network connectivity tracking
  private _isOnline: boolean = navigator.onLine;
  private _wasOffline: boolean = false;
  private _onlineListener: (() => void) | null = null;
  private _offlineListener: (() => void) | null = null;
  private _focusListener: (() => void) | null = null;
  private _blurListener: (() => void) | null = null;
  private _visibilityListener: (() => void) | null = null;
  private _healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private _lastHealthCheck: number = Date.now();

  private constructor() {
    this._setupNetworkAndFocusListeners();
  }

  static getInstance(): RealtimeChannelManager {
    if (!RealtimeChannelManager._instance) {
      RealtimeChannelManager._instance = new RealtimeChannelManager();
    }
    return RealtimeChannelManager._instance;
  }

  /**
   * Set the Supabase client to use for channel operations
   */
  setClient(client: SupabaseClient<Database>) {
    this._client = client;
  }

  /**
   * Set up network connectivity and focus event listeners
   */
  private _setupNetworkAndFocusListeners() {
    // Network connectivity listeners
    this._onlineListener = () => this._handleOnlineEvent();
    this._offlineListener = () => this._handleOfflineEvent();
    
    window.addEventListener('online', this._onlineListener);
    window.addEventListener('offline', this._offlineListener);

    // Focus/blur listeners for window focus changes
    this._focusListener = () => this._handleWindowFocus();
    this._blurListener = () => this._handleWindowBlur();
    
    window.addEventListener('focus', this._focusListener);
    window.addEventListener('blur', this._blurListener);

    // Enhanced visibility change listener
    this._visibilityListener = () => this._handleEnhancedVisibilityChange();
    document.addEventListener('visibilitychange', this._visibilityListener);

    // Start periodic health checks
    this._startHealthChecks();
  }

  /**
   * Handle online event - network connectivity restored
   */
  private _handleOnlineEvent() {
    this._isOnline = true;

    // If we were offline, trigger reconnection to all channels
    if (this._wasOffline) {
      this._wasOffline = false;
      this._lastHealthCheck = Date.now();
      
      // Trigger reconnection after a brief delay to let network stabilize
      setTimeout(() => {
        this.resubscribeToAllChannels();
      }, 2000);
    }
  }

  /**
   * Handle offline event - network connectivity lost
   */
  private _handleOfflineEvent() {
    this._isOnline = false;
    this._wasOffline = true;

    // Notify all channels of disconnection
    for (const managedChannel of this._channels.values()) {
      for (const subscription of managedChannel.subscriptions) {
        try {
          subscription.statusCallback(managedChannel.channel, REALTIME_SUBSCRIBE_STATES.CLOSED);
        } catch (error) {
          console.error('Error notifying subscription of offline event:', error);
        }
      }
    }
  }

  /**
   * Handle window focus - user returned to tab
   */
  private _handleWindowFocus() {
    // Check if we have any channels that might need reconnection
    const channelsNeedingCheck = Array.from(this._channels.values()).filter(channel =>
      channel.reconnectAttempts > 0 || channel.isReconnecting
    );

    if (channelsNeedingCheck.length > 0) {
      // Reset health check and trigger immediate health check
      this._lastHealthCheck = Date.now();
      this._performHealthCheck();
    }
  }

  /**
   * Handle window blur - user left tab
   */
  private _handleWindowBlur() {
    // We already handle this in the existing visibility change logic
  }

  /**
   * Enhanced visibility change handler with network awareness
   */
  private _handleEnhancedVisibilityChange() {
    if (!document.hidden) {
      // Check network connectivity and health
      const wasOnline = this._isOnline;
      this._isOnline = navigator.onLine;
      
      // If we came back online or there's been a long gap, trigger reconnection
      const timeSinceLastCheck = Date.now() - this._lastHealthCheck;
      const shouldReconnect = (!wasOnline && this._isOnline) || timeSinceLastCheck > 60000; // 1 minute
      
      if (shouldReconnect) {
        this.resubscribeToAllChannels();
      }
      
      this._lastHealthCheck = Date.now();
    }
  }

  /**
   * Start periodic health checks
   */
  private _startHealthChecks() {
    // Health check every 30 seconds
    this._healthCheckInterval = setInterval(() => {
      this._performHealthCheck();
    }, 30000);
  }

  /**
   * Perform a health check on connectivity and channels
   */
  private _performHealthCheck() {
    const wasOnline = this._isOnline;
    this._isOnline = navigator.onLine;
    
    if (!wasOnline && this._isOnline) {
      this._handleOnlineEvent();
      return;
    }
    
    if (!this._isOnline) {
      return;
    }

    // Check for channels that might be stuck
    const stuckChannels = Array.from(this._channels.values()).filter(channel => {
      const stuckTime = Date.now() - channel.lastReconnectTime;
      return channel.isReconnecting && stuckTime > 5 * 60 * 1000; // 5 minutes
    });

    if (stuckChannels.length > 0) {
      for (const channel of stuckChannels) {
        channel.isReconnecting = false;
        this._resubscribeToChannelWithBackoff(channel.topic);
      }
    }

    this._lastHealthCheck = Date.now();
  }

  /**
   * Cleanup network and focus listeners
   */
  private _cleanupNetworkAndFocusListeners() {
    if (this._onlineListener) {
      window.removeEventListener('online', this._onlineListener);
      this._onlineListener = null;
    }

    if (this._offlineListener) {
      window.removeEventListener('offline', this._offlineListener);
      this._offlineListener = null;
    }

    if (this._focusListener) {
      window.removeEventListener('focus', this._focusListener);
      this._focusListener = null;
    }

    if (this._blurListener) {
      window.removeEventListener('blur', this._blurListener);
      this._blurListener = null;
    }

    if (this._visibilityListener) {
      document.removeEventListener('visibilitychange', this._visibilityListener);
      this._visibilityListener = null;
    }

    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = null;
    }
  }

  /**
   * Subscribe to a specific channel topic
   */
  async subscribe(
    topic: string,
    messageCallback: (message: BroadcastMessage) => void,
    statusCallback: (channel: RealtimeChannel, status: REALTIME_SUBSCRIBE_STATES, err?: Error) => void
  ): Promise<() => void> {
    if (!this._client) {
      throw new Error("RealtimeChannelManager: Client not set. Call setClient() first.");
    }

    let managedChannel = this._channels.get(topic);

    if (!managedChannel) {
      // Create new channel and subscription
      await this._refreshSessionIfNeeded();
      const channel = this._client.channel(topic, { config: { private: true } });

      managedChannel = {
        channel,
        subscriptions: [],
        topic,
        reconnectAttempts: 0,
        lastReconnectTime: 0,
        isReconnecting: false
      };

      // Set up broadcast message handler
      channel.on("broadcast", { event: "broadcast" }, (message) => {
        this._routeMessage(topic, message.payload as BroadcastMessage);
      });

      // Subscribe to the channel (this should only happen once per topic)
      channel.subscribe(async (status, err) => {
        this._handleSubscriptionStateEvent(topic, status, err);
      });

      this._channels.set(topic, managedChannel);
    }

    // Create the subscription object
    const subscription = {
      callback: messageCallback,
      statusCallback
    };

    // Add this subscription to the array
    managedChannel.subscriptions.push(subscription);

    // Return unsubscribe function that removes this specific subscription
    return () => {
      const index = managedChannel.subscriptions.indexOf(subscription);
      if (index > -1) {
        managedChannel.subscriptions.splice(index, 1);
      }

      // If no more subscriptions, clean up the channel
      if (managedChannel.subscriptions.length === 0) {
        managedChannel.channel.unsubscribe();
        if (this._client) {
          this._client.removeChannel(managedChannel.channel);
        }
        this._channels.delete(topic);
      }
    };
  }

  /**
   * Route broadcast messages to all subscriptions
   */
  private _routeMessage(topic: string, message: BroadcastMessage) {
    const managedChannel = this._channels.get(topic);
    if (!managedChannel) return;

    for (const subscription of managedChannel.subscriptions) {
      try {
        subscription.callback(message);
      } catch (error) {
        console.error('Error routing message to subscription:', error);
      }
    }
  }

  /**
   * Handle subscription state events and notify all subscribed controllers
   */
  private _handleSubscriptionStateEvent(topic: string, status: REALTIME_SUBSCRIBE_STATES, err?: Error) {
    const managedChannel = this._channels.get(topic);
    if (!managedChannel) return;

    // Handle reconnection logic for certain error states
    if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR) {
      // If the tab is hidden, we don't really care about reconnection
      if (document.hidden) {
        return;
      }
        
      // Prevent multiple simultaneous reconnection attempts
      if (managedChannel.isReconnecting) {
        return;
      }
      
      // Check if we should attempt reconnection based on retry policy
      if (this._shouldAttemptReconnection(managedChannel)) {
        this._resubscribeToChannelWithBackoff(topic);
      }
    } else if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
      // Reset reconnection state on successful connection
      if (managedChannel.reconnectAttempts > 0 || managedChannel.isReconnecting) {
        managedChannel.reconnectAttempts = 0;
        managedChannel.isReconnecting = false;
      }
    }

    for (const subscription of managedChannel.subscriptions) {
      try {
        subscription.statusCallback(managedChannel.channel, status, err);
      } catch (error) {
        console.error('Error handling status event for subscription:', error);
      }
    }
  }

  /**
   * Get information about managed channels (for debugging)
   */
  getDebugInfo() {
    return {
      channelCount: this._channels.size,
      channels: Array.from(this._channels.entries()).map(([topic, managed]) => ({
        topic,
        state: managed.channel.state,
        subscriptionCount: managed.subscriptions.length
      }))
    };
  }

  /**
   * Refresh the session token if needed and set it for Supabase Realtime
   */
  private async _refreshSessionIfNeeded() {
    if (!this._client) {
      throw new Error("RealtimeChannelManager: Client not set");
    }

    const { data, error } = await this._client.auth.getSession();
    if (error) {
      throw error;
    }
    if (!data.session) {
      throw new Error("Session not found");
    }
    if (this._client.realtime.accessTokenValue !== data.session.access_token) {
      await this._client.realtime.setAuth(data.session.access_token);
    }
  }

  /**
   * Check if we should attempt reconnection based on retry policy
   */
  private _shouldAttemptReconnection(managedChannel: ManagedChannel): boolean {
    const maxRetries = 5;
    const minRetryInterval = 1000; // 1 second minimum between attempts
    
    // Don't attempt reconnection if already reconnecting
    if (managedChannel.isReconnecting) {
      return false;
    }
    
    if (managedChannel.reconnectAttempts >= maxRetries) {
      return false;
    }
    
    const now = Date.now();
    if (now - managedChannel.lastReconnectTime < minRetryInterval) {
      return false;
    }
    
    return true;
  }
  
  /**
   * Calculate exponential backoff delay
   */
  private _getReconnectDelay(attempts: number): number {
    const baseDelay = 1000; // 1 second
    const maxDelay = 30000; // 30 seconds max
    const delay = Math.min(baseDelay * Math.pow(2, attempts), maxDelay);
    // Add some jitter to prevent thundering herd
    return delay + Math.random() * 1000;
  }

  /**
   * Resubscribe to a specific channel with exponential backoff
   */
  private async _resubscribeToChannelWithBackoff(topic: string) {
    const managedChannel = this._channels.get(topic);
    if (!managedChannel) return;
    
    // Check if reconnection is stuck (been reconnecting for more than 2 minutes)
    const now = Date.now();
    const maxReconnectionTime = 2 * 60 * 1000; // 2 minutes
    if (managedChannel.isReconnecting && (now - managedChannel.lastReconnectTime) > maxReconnectionTime) {
      managedChannel.isReconnecting = false;
    }
    
    if (managedChannel.isReconnecting) return;

    managedChannel.isReconnecting = true;
    managedChannel.reconnectAttempts++;
    managedChannel.lastReconnectTime = Date.now();

    const delay = this._getReconnectDelay(managedChannel.reconnectAttempts - 1);

    setTimeout(async () => {
      try {
        // Add overall timeout for the entire reconnection process
        const reconnectionPromise = this._resubscribeToChannel(topic);
        const timeoutPromise = new Promise<void>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`Reconnection timeout for ${topic}`));
          }, 30000); // 30 second timeout for entire reconnection process
        });
        
        await Promise.race([reconnectionPromise, timeoutPromise]);
        
      } catch (error) {
        console.error('Reconnection failed:', error);
        
        // CRITICAL: Reset reconnecting state so future attempts can be made
        const channel = this._channels.get(topic);
        if (channel) {
          channel.isReconnecting = false;
          
          // Schedule another retry if we haven't exceeded max attempts
          if (this._shouldAttemptReconnection(channel)) {
            setTimeout(() => this._resubscribeToChannelWithBackoff(topic), 5000); // 5 second delay before retry
          }
        }
      }
    }, delay);
  }

  /**
   * Resubscribe to a specific channel (handles token refresh)
   */
  private async _resubscribeToChannel(topic: string): Promise<void> {
    const managedChannel = this._channels.get(topic);
    if (!managedChannel) return;

    try {
      // Refresh session first
      await this._refreshSessionIfNeeded();

      // Remove the old channel
      managedChannel.channel.unsubscribe();
      
      if (this._client) {
        this._client.removeChannel(managedChannel.channel);
      }

      // Create a new channel with the same topic
      if (!this._client) {
        throw new Error(`No client available for ${topic}`);
      }

      const newChannel = this._client.channel(topic, { config: { private: true } });

      // Set up broadcast message handler
      newChannel.on("broadcast", { event: "broadcast" }, (message) => {
        this._routeMessage(topic, message.payload as BroadcastMessage);
      });

      // Subscribe to the new channel with improved error handling
      newChannel.subscribe(async (status, err) => {
        // Use a different handler to prevent infinite recursion
        this._handleReconnectionStateEvent(topic, status, err);
      });

      // Update the managed channel
      managedChannel.channel = newChannel;
      
      // Note: Don't reset isReconnecting here - let the SUBSCRIBED event handler do it
      // This prevents race conditions
      
    } catch (error) {
      console.error('Error during resubscription:', error);
      
      // CRITICAL: Always reset isReconnecting on failure so future attempts can be made
      managedChannel.isReconnecting = false;
      
      // Re-throw the error so the timeout wrapper can handle retries
      throw error;
    }
  }

  /**
   * Handle subscription state events during reconnection (prevents infinite recursion)
   */
  private _handleReconnectionStateEvent(topic: string, status: REALTIME_SUBSCRIBE_STATES, err?: Error) {
    const managedChannel = this._channels.get(topic);
    if (!managedChannel) return;

    switch (status) {
      case REALTIME_SUBSCRIBE_STATES.SUBSCRIBED:
        managedChannel.reconnectAttempts = 0;
        managedChannel.isReconnecting = false;
        break;

      case REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR:
        managedChannel.isReconnecting = false;
        
        // Only retry if we haven't exceeded max attempts
        if (this._shouldAttemptReconnection(managedChannel)) {
          this._resubscribeToChannelWithBackoff(topic);
        }
        break;

      case REALTIME_SUBSCRIBE_STATES.CLOSED:
      case REALTIME_SUBSCRIBE_STATES.TIMED_OUT:
        managedChannel.isReconnecting = false;
        break;
    }

    // Notify all subscriptions of the status change
    for (const subscription of managedChannel.subscriptions) {
      try {
        subscription.statusCallback(managedChannel.channel, status, err);
      } catch (error) {
        console.error('Error handling reconnection status event for subscription:', error);
      }
    }
  }

  /**
   * Resubscribe to all channels (useful for reconnection after tab visibility changes)
   */
  async resubscribeToAllChannels() {
    if (!this._client) return;

    try {
      await this._refreshSessionIfNeeded();

      const topics = Array.from(this._channels.keys());
      
      for (const topic of topics) {
        const managedChannel = this._channels.get(topic);
        if (managedChannel && !managedChannel.isReconnecting) {
          // Reset reconnection state for fresh start
          managedChannel.reconnectAttempts = 0;
          managedChannel.isReconnecting = false;
          await this._resubscribeToChannel(topic);
        }
      }
    } catch (error) {
      console.error("Error resubscribing to all channels:", error);
    }
  }

  /**
   * Disconnect all channels (useful for tab visibility changes)
   */
  disconnectAllChannels() {
    for (const managedChannel of this._channels.values()) {
      // Reset reconnection state
      managedChannel.isReconnecting = false;
      managedChannel.reconnectAttempts = 0;
      
      managedChannel.channel.unsubscribe();
      if (this._client) {
        this._client.removeChannel(managedChannel.channel);
      }
    }

    // Notify all subscriptions of the disconnection
    for (const managedChannel of this._channels.values()) {
      for (const subscription of managedChannel.subscriptions) {
        try {
          subscription.statusCallback(managedChannel.channel, REALTIME_SUBSCRIBE_STATES.CLOSED);
        } catch (error) {
          console.error('Error notifying subscription of disconnection:', error);
        }
      }
    }
  }

  /**
   * Force cleanup of all channels (use with caution)
   */
  cleanup() {
    for (const managedChannel of this._channels.values()) {
      managedChannel.channel.unsubscribe();
      if (this._client) {
        this._client.removeChannel(managedChannel.channel);
      }
    }
    this._channels.clear();
  }
}
