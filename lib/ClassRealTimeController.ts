import { Database } from "@/supabase/functions/_shared/SupabaseTypes";
import { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

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
    
    this._initializeChannels();
  }

  private async _initializeChannels() {
    const accessToken = await this._client.auth.getSession();
    console.log("accessToken", accessToken);
    await this._client.realtime.setAuth(accessToken.data.session?.access_token);
    console.log("setAuth called");
    // Initialize staff channel if user is staff
    if (this._isStaff) {
        console.log("initializing staff channel");
      this._staffChannel = this._client.channel(`class:${this._classId}:staff`, {
        config: { private: true }
      });
      
      this._staffChannel.on("broadcast", { event: "broadcast" }, (message) => {
        this._handleBroadcastMessage(message.payload as BroadcastMessage);
      });
      
      this._staffChannel.subscribe((status, err) => {
        console.log(`Staff channel status: class:${this._classId}:staff`, status, err);
      });
    }

    // Initialize user channel (all users get their own channel)
    this._userChannel = this._client.channel(`class:${this._classId}:user:${this._profileId}`, {
      config: { private: true }
    });
    
    this._userChannel.on("broadcast", { event: "broadcast" }, (message) => {
      this._handleBroadcastMessage(message.payload as BroadcastMessage);
    });
    
    this._userChannel.subscribe((status, err) => {
      console.log(`User channel status: class:${this._classId}:user:${this._profileId}`, status, err);
    });
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
    // Ensure submission channels are created
    this._ensureSubmissionChannels(submissionId);
    
    return this.subscribe({ table, submission_id: submissionId }, callback);
  }

  /**
   * Subscribe to all messages for a specific submission (any table)
   */
  subscribeToSubmission(submissionId: number, callback: MessageCallback): () => void {
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
   * Check if the controller is ready (channels subscribed)
   */
  get isReady(): boolean {
    const staffReady = !this._isStaff || (this._staffChannel?.state === "joined");
    const userReady = this._userChannel?.state === "joined";
    
    // Check submission channels
    const submissionChannelsReady = Array.from(this._submissionChannels.values()).every(channels => {
      const gradersReady = !this._isStaff || !channels.graders || (channels.graders.state === "joined");
      const userChannelReady = !channels.user || (channels.user.state === "joined");
      return gradersReady && userChannelReady;
    });
    
    return staffReady && userReady && submissionChannelsReady;
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
      
      channels.graders.subscribe((status, err) => {
        console.log(`Submission graders channel status: ${gradersChannelName}`, status, err);
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
    
    channels.user.subscribe((status, err) => {
      console.log(`Submission user channel status: ${userChannelName}`, status, err);
    });

    this._submissionChannels.set(submissionId, channels);
  }

  /**
   * Clean up channels and subscriptions
   */
  close() {
    console.log("Closing ClassRealTimeController channels");
    
    this._subscriptions.clear();
    
    if (this._staffChannel) {
      this._staffChannel.unsubscribe();
      this._staffChannel = null;
    }
    
    if (this._userChannel) {
      this._userChannel.unsubscribe();
      this._userChannel = null;
    }

    // Clean up submission channels
    for (const channels of this._submissionChannels.values()) {
      if (channels.graders) {
        channels.graders.unsubscribe();
      }
      if (channels.user) {
        channels.user.unsubscribe();
      }
    }
    this._submissionChannels.clear();
  }

  /**
   * Get debug info about current state
   */
  getDebugInfo() {
    return {
      classId: this._classId,
      profileId: this._profileId,
      isStaff: this._isStaff,
      staffChannelState: this._staffChannel?.state,
      userChannelState: this._userChannel?.state,
      submissionChannels: Array.from(this._submissionChannels.entries()).map(([submissionId, channels]) => ({
        submissionId,
        gradersChannelState: channels.graders?.state,
        userChannelState: channels.user?.state
      })),
      subscriptionCount: this._subscriptions.size,
      subscriptions: Array.from(this._subscriptions.values()).map(sub => ({
        id: sub.id,
        filter: sub.filter
      }))
    };
  }
} 