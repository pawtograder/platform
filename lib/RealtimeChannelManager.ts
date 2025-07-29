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
};

/**
 * Determines if the provided error relates to an expired token.
 */
const isTokenExpiredError = (err: Error) => {
  return err.message?.startsWith('"Token has expired');
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

  private constructor() {}

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
        topic
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
        console.error(`Error routing message to subscription:`, error);
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
        console.debug(`Channel error in '${topic}', but tab is hidden. Will reconnect when visible.`);
        return;
      } else if (err && isTokenExpiredError(err)) {
        console.debug(`Token expired causing channel error in '${topic}'. Refreshing session and resubscribing.`);
        this._resubscribeToChannel(topic);
        return;
      } else {
        console.warn(`Channel error in '${topic}': `, err?.message);
      }
    }

    for (const subscription of managedChannel.subscriptions) {
      try {
        subscription.statusCallback(managedChannel.channel, status, err);
      } catch (error) {
        console.error(`Error handling status event for subscription:`, error);
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
   * Resubscribe to a specific channel (handles token refresh)
   */
  private async _resubscribeToChannel(topic: string) {
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
      if (!this._client) return;

      const newChannel = this._client.channel(topic, { config: { private: true } });

      // Set up broadcast message handler
      newChannel.on("broadcast", { event: "broadcast" }, (message) => {
        this._routeMessage(topic, message.payload as BroadcastMessage);
      });

      // Subscribe to the new channel
      newChannel.subscribe(async (status, err) => {
        this._handleSubscriptionStateEvent(topic, status, err);
      });

      // Update the managed channel
      managedChannel.channel = newChannel;
    } catch (error) {
      console.error(`Error resubscribing to channel ${topic}:`, error);
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
        await this._resubscribeToChannel(topic);
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
          console.error(`Error notifying subscription of disconnection:`, error);
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
