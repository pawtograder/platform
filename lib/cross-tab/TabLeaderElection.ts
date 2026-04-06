/**
 * Cross-tab leader election using BroadcastChannel with heartbeat protocol.
 *
 * One browser tab is elected "leader" and owns shared resources (e.g. WebSocket
 * connections). Other tabs are followers that monitor the leader's heartbeat.
 * If the leader tab closes or crashes, a new election promotes a follower.
 *
 * Protocol messages (all on the same BroadcastChannel):
 *   claim     – a tab is asserting leadership (lowest tabId wins tiebreak)
 *   heartbeat – the current leader is alive
 *   resign    – the current leader is voluntarily stepping down
 */

type MessageType = "claim" | "heartbeat" | "resign";

interface LeaderMessage {
  type: MessageType;
  tabId: string;
  timestamp: number;
}

const HEARTBEAT_INTERVAL_MS = 3_000;
const LEADER_TIMEOUT_MS = 5_000;
const INITIAL_CLAIM_TIMEOUT_MS = 1_000;
const DEFAULT_CHANNEL_NAME = "pawtograder-leader";

export class TabLeaderElection {
  readonly tabId: string;

  private _isLeader: boolean = false;
  private _channel: BroadcastChannel | null = null;
  private _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private _leaderTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private _initialClaimTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private _listeners: Set<(isLeader: boolean) => void> = new Set();
  private _closed: boolean = false;

  private _currentLeaderId: string | null = null;
  private _lastLeaderHeartbeat: number = 0;

  private _boundBeforeUnload: (() => void) | null = null;

  constructor(options?: { tabId?: string; channelName?: string }) {
    this.tabId =
      options?.tabId ??
      (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

    // SSR / environments without BroadcastChannel: become leader immediately.
    if (typeof BroadcastChannel === "undefined") {
      this._setLeader(true, this.tabId);
      return;
    }

    const channelName = options?.channelName ?? DEFAULT_CHANNEL_NAME;
    this._channel = new BroadcastChannel(channelName);
    this._channel.onmessage = (event: MessageEvent<LeaderMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object" || !msg.type || !msg.tabId) return;
      this._handleMessage(msg);
    };

    // Register beforeunload so the leader resigns cleanly on tab close.
    this._boundBeforeUnload = () => this.resign();
    window.addEventListener("beforeunload", this._boundBeforeUnload);

    // Announce ourselves and wait for responses.
    this._sendMessage("claim");

    // If nobody responds within the initial timeout, we are the sole tab.
    this._initialClaimTimeoutId = setTimeout(() => {
      this._initialClaimTimeoutId = null;
      if (!this._closed && !this._isLeader && this._currentLeaderId === null) {
        this._setLeader(true, this.tabId);
        this._startHeartbeat();
      }
    }, INITIAL_CLAIM_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  get isLeader(): boolean {
    return this._isLeader;
  }

  /** Subscribe to leadership changes. Returns an unsubscribe function. */
  onLeaderChange(cb: (isLeader: boolean) => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  /** Voluntarily give up leadership (e.g. tab is closing). */
  resign(): void {
    if (this._closed) return;
    if (this._isLeader) {
      this._sendMessage("resign");
      this._stopHeartbeat();
      this._setLeader(false, null);
    }
  }

  /** Tear down all resources. Safe to call multiple times. */
  close(): void {
    if (this._closed) return;

    // Resign before setting _closed so the resign message can still be sent.
    this.resign();
    this._closed = true;
    this._stopHeartbeat();
    this._clearLeaderTimeout();

    if (this._initialClaimTimeoutId !== null) {
      clearTimeout(this._initialClaimTimeoutId);
      this._initialClaimTimeoutId = null;
    }

    if (this._channel) {
      this._channel.onmessage = null;
      this._channel.close();
      this._channel = null;
    }

    if (this._boundBeforeUnload) {
      window.removeEventListener("beforeunload", this._boundBeforeUnload);
      this._boundBeforeUnload = null;
    }

    this._listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private _handleMessage(msg: LeaderMessage): void {
    if (this._closed || msg.tabId === this.tabId) return;

    switch (msg.type) {
      case "claim":
        this._onClaim(msg);
        break;
      case "heartbeat":
        this._onHeartbeat(msg);
        break;
      case "resign":
        this._onResign(msg);
        break;
    }
  }

  private _onClaim(msg: LeaderMessage): void {
    // Tiebreak: lowest tabId wins.
    if (this._isLeader) {
      if (this.tabId < msg.tabId) {
        // We win — re-assert.
        this._sendMessage("claim");
      } else {
        // We lose — yield.
        this._stopHeartbeat();
        this._setLeader(false, msg.tabId);
        this._resetLeaderTimeout();
      }
    } else {
      if (this.tabId < msg.tabId) {
        // We should be leader.
        this._sendMessage("claim");
      } else {
        // They should be leader — acknowledge and track them.
        this._currentLeaderId = msg.tabId;
        this._lastLeaderHeartbeat = msg.timestamp;
        this._resetLeaderTimeout();

        // Cancel the initial claim timeout since we found a peer.
        if (this._initialClaimTimeoutId !== null) {
          clearTimeout(this._initialClaimTimeoutId);
          this._initialClaimTimeoutId = null;
        }
      }
    }
  }

  private _onHeartbeat(msg: LeaderMessage): void {
    this._currentLeaderId = msg.tabId;
    this._lastLeaderHeartbeat = msg.timestamp;

    // Cancel the initial claim timeout — a leader exists.
    if (this._initialClaimTimeoutId !== null) {
      clearTimeout(this._initialClaimTimeoutId);
      this._initialClaimTimeoutId = null;
    }

    if (!this._isLeader) {
      this._resetLeaderTimeout();
    }
  }

  private _onResign(msg: LeaderMessage): void {
    if (msg.tabId === this._currentLeaderId) {
      this._currentLeaderId = null;
      this._clearLeaderTimeout();
      // Start election.
      this._sendMessage("claim");
      // Use initial timeout to become leader if nobody else claims.
      this._initialClaimTimeoutId = setTimeout(() => {
        this._initialClaimTimeoutId = null;
        if (!this._closed && !this._isLeader) {
          this._setLeader(true, this.tabId);
          this._startHeartbeat();
        }
      }, INITIAL_CLAIM_TIMEOUT_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Leader state
  // ---------------------------------------------------------------------------

  private _setLeader(isLeader: boolean, leaderId: string | null): void {
    this._currentLeaderId = leaderId;
    if (this._isLeader === isLeader) return;
    this._isLeader = isLeader;
    for (const cb of this._listeners) {
      cb(isLeader);
    }
  }

  // ---------------------------------------------------------------------------
  // Heartbeat (leader only)
  // ---------------------------------------------------------------------------

  private _startHeartbeat(): void {
    this._stopHeartbeat();
    this._sendMessage("heartbeat");
    this._heartbeatInterval = setInterval(() => {
      if (this._isLeader && !this._closed) {
        this._sendMessage("heartbeat");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatInterval !== null) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Dead-leader timeout (follower only)
  // ---------------------------------------------------------------------------

  private _resetLeaderTimeout(): void {
    this._clearLeaderTimeout();
    this._leaderTimeoutId = setTimeout(() => {
      this._leaderTimeoutId = null;
      if (!this._closed && !this._isLeader) {
        // Leader seems dead — start election.
        this._currentLeaderId = null;
        this._sendMessage("claim");
        this._initialClaimTimeoutId = setTimeout(() => {
          this._initialClaimTimeoutId = null;
          if (!this._closed && !this._isLeader) {
            this._setLeader(true, this.tabId);
            this._startHeartbeat();
          }
        }, INITIAL_CLAIM_TIMEOUT_MS);
      }
    }, LEADER_TIMEOUT_MS);
  }

  private _clearLeaderTimeout(): void {
    if (this._leaderTimeoutId !== null) {
      clearTimeout(this._leaderTimeoutId);
      this._leaderTimeoutId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  private _sendMessage(type: MessageType): void {
    if (this._closed || !this._channel) return;
    const msg: LeaderMessage = {
      type,
      tabId: this.tabId,
      timestamp: Date.now()
    };
    this._channel.postMessage(msg);
  }
}
