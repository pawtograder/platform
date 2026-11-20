/**
 * @jest-environment jsdom
 *
 * After a reconnect, the replacement channel needs its lease registered again. Without that, a
 * class's only live subscriber stops counting as a subscriber once the lease expires, and
 * safe_broadcast stops sending class updates to it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { RealtimeChannelManager } from "@/lib/RealtimeChannelManager";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type StatusCallback = (status: string, err?: Error) => void;

const internals = (manager: RealtimeChannelManager) =>
  manager as unknown as Record<string, (...args: unknown[]) => unknown>;

function makeClient() {
  const channel: { on: jest.Mock; subscribe: jest.Mock; unsubscribe: jest.Mock; state: string } = {
    on: jest.fn(() => channel),
    subscribe: jest.fn((callback?: StatusCallback) => {
      callback?.("SUBSCRIBED");
      return channel;
    }),
    unsubscribe: jest.fn(),
    state: "joined"
  };
  const client = {
    channel: jest.fn(() => channel),
    removeChannel: jest.fn(),
    auth: {
      getSession: jest.fn(async () => ({ data: { session: { access_token: "t" } }, error: null })),
      getUser: jest.fn(async () => ({ data: { user: { id: "u" } }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } }))
    },
    realtime: { accessTokenValue: "t" },
    rpc: jest.fn(async () => ({ data: null, error: null }))
  };
  return client as unknown as SupabaseClient<Database>;
}

describe("RealtimeChannelManager reconnect", () => {
  afterEach(() => {
    RealtimeChannelManager.getInstance().cleanup();
    jest.restoreAllMocks();
  });

  it("registers the lease again and restarts its refresh when a channel resubscribes", async () => {
    const manager = RealtimeChannelManager.getInstance();
    const client = makeClient();
    const topic = "class:7:students";
    await manager.subscribe(
      topic,
      client,
      () => {},
      () => {}
    );

    const registerLease = jest.spyOn(internals(manager), "_registerLease").mockImplementation(async () => undefined);
    const startLeaseRefresh = jest.spyOn(internals(manager), "_startLeaseRefresh").mockImplementation(() => {});

    await (manager as unknown as { _resubscribeToChannel(topic: string): Promise<void> })._resubscribeToChannel(topic);

    expect(registerLease).toHaveBeenCalledTimes(1);
    expect(startLeaseRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("RealtimeChannelManager lease refresh after reconnect", () => {
  afterEach(() => {
    RealtimeChannelManager.getInstance().cleanup();
    jest.restoreAllMocks();
  });

  it("stops the lease refresh when the reconnected channel closes", async () => {
    const manager = RealtimeChannelManager.getInstance();
    const topic = "class:7:students";
    await manager.subscribe(
      topic,
      makeClient(),
      () => {},
      () => {}
    );
    const managed = (manager as unknown as { _channels: Map<string, { leaseTimer: unknown }> })._channels.get(topic)!;
    const timer = setInterval(() => {}, 1_000_000);
    managed.leaseTimer = timer;
    const clearInt = jest.spyOn(global, "clearInterval");

    (manager as unknown as { _handleReconnectionStateEvent(t: string, s: string): void })._handleReconnectionStateEvent(
      topic,
      "CLOSED"
    );

    expect(clearInt).toHaveBeenCalledWith(timer);
    expect(managed.leaseTimer).toBeNull();
  });

  it("does not start the lease refresh for a channel torn down while registering", async () => {
    const manager = RealtimeChannelManager.getInstance();
    const client = makeClient();
    const topic = "class:7:students";
    const unsubscribe = await manager.subscribe(
      topic,
      client,
      () => {},
      () => {}
    );

    let finishRegistration: () => void = () => {};
    jest
      .spyOn(internals(manager), "_registerLease")
      .mockImplementation(() => new Promise<void>((resolve) => (finishRegistration = resolve)) as unknown);
    const startLeaseRefresh = jest.spyOn(internals(manager), "_startLeaseRefresh").mockImplementation(() => {});

    await (manager as unknown as { _resubscribeToChannel(topic: string): Promise<void> })._resubscribeToChannel(topic);
    unsubscribe();
    finishRegistration();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startLeaseRefresh).not.toHaveBeenCalled();
  });
});

describe("RealtimeChannelManager lease refresh after a rejoin", () => {
  afterEach(() => {
    RealtimeChannelManager.getInstance().cleanup();
    jest.restoreAllMocks();
  });

  it("restarts the lease refresh when a replacement channel rejoins after timing out", async () => {
    const manager = RealtimeChannelManager.getInstance();
    const client = makeClient();
    const topic = "class:7:students";
    await manager.subscribe(
      topic,
      client,
      () => {},
      () => {}
    );

    // The replacement channel joins, times out, then rejoins on the same channel object.
    const rejoining: { on: jest.Mock; subscribe: jest.Mock; unsubscribe: jest.Mock; state: string } = {
      on: jest.fn(() => rejoining),
      subscribe: jest.fn((callback?: StatusCallback) => {
        callback?.("SUBSCRIBED");
        callback?.("TIMED_OUT");
        callback?.("SUBSCRIBED");
        return rejoining;
      }),
      unsubscribe: jest.fn(),
      state: "joined"
    };
    (client.channel as unknown as jest.Mock).mockImplementation(() => rejoining);
    jest.spyOn(internals(manager), "_registerLease").mockImplementation(async () => undefined);
    const startLeaseRefresh = jest.spyOn(internals(manager), "_startLeaseRefresh").mockImplementation(() => {});

    await (manager as unknown as { _resubscribeToChannel(topic: string): Promise<void> })._resubscribeToChannel(topic);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startLeaseRefresh).toHaveBeenCalledTimes(2);
  });
});

describe("RealtimeChannelManager lease refresh when a timeout overlaps registration", () => {
  afterEach(() => {
    RealtimeChannelManager.getInstance().cleanup();
    jest.restoreAllMocks();
  });

  it("does not start the lease refresh if the channel times out while its lease is registering", async () => {
    const manager = RealtimeChannelManager.getInstance();
    const client = makeClient();
    const topic = "class:7:students";
    await manager.subscribe(
      topic,
      client,
      () => {},
      () => {}
    );

    // The replacement channel joins, then times out before its lease registration finishes.
    const timingOut: { on: jest.Mock; subscribe: jest.Mock; unsubscribe: jest.Mock; state: string } = {
      on: jest.fn(() => timingOut),
      subscribe: jest.fn((callback?: StatusCallback) => {
        callback?.("SUBSCRIBED");
        callback?.("TIMED_OUT");
        return timingOut;
      }),
      unsubscribe: jest.fn(),
      state: "joined"
    };
    (client.channel as unknown as jest.Mock).mockImplementation(() => timingOut);
    let finishRegistration: () => void = () => {};
    jest
      .spyOn(internals(manager), "_registerLease")
      .mockImplementation(() => new Promise<void>((resolve) => (finishRegistration = resolve)) as unknown);
    const startLeaseRefresh = jest.spyOn(internals(manager), "_startLeaseRefresh").mockImplementation(() => {});

    await (manager as unknown as { _resubscribeToChannel(topic: string): Promise<void> })._resubscribeToChannel(topic);
    finishRegistration();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(startLeaseRefresh).not.toHaveBeenCalled();
  });
});
