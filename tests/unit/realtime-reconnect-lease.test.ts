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

function makeClient() {
  const channel = {
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

    const registerLease = jest.spyOn(manager as never, "_registerLease").mockResolvedValue(undefined);
    const startLeaseRefresh = jest.spyOn(manager as never, "_startLeaseRefresh").mockImplementation(() => {});

    await (manager as unknown as { _resubscribeToChannel(topic: string): Promise<void> })._resubscribeToChannel(topic);

    expect(registerLease).toHaveBeenCalledTimes(1);
    expect(startLeaseRefresh).toHaveBeenCalledTimes(1);
  });
});
