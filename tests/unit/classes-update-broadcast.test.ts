/**
 * RealtimeChannelManager.subscribeToClassesUpdate now rides the class students topic.
 * The DB trigger (broadcast_classes_update) sends `classes_update` messages there, so the
 * manager must hand the updated row to the callback for those messages and ignore the rest.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ClassRealTimeController } from "@/lib/ClassRealTimeController";
import { RealtimeChannelManager } from "@/lib/RealtimeChannelManager";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type Handler = (message: { payload: unknown }) => void;

function makeClient() {
  let broadcastHandler: Handler | undefined;
  const channel: { on: jest.Mock; subscribe: jest.Mock; unsubscribe: jest.Mock; state: string } = {
    on: jest.fn((_type: string, _filter: unknown, handler: Handler) => {
      broadcastHandler = handler;
      return channel;
    }),
    subscribe: jest.fn(() => channel),
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
  return {
    client: client as unknown as SupabaseClient<Database>,
    channel,
    channelFn: client.channel,
    deliver: (payload: unknown) => broadcastHandler?.({ payload })
  };
}

describe("RealtimeChannelManager.subscribeToClassesUpdate", () => {
  let manager: RealtimeChannelManager;

  beforeEach(() => {
    manager = RealtimeChannelManager.getInstance();
  });

  afterEach(() => {
    manager.cleanup();
  });

  it("subscribes to the class students topic", async () => {
    const { client, channelFn } = makeClient();

    await manager.subscribeToClassesUpdate(7, client, () => {});

    expect(channelFn).toHaveBeenCalledWith("class:7:students", expect.anything());
  });

  it("passes the updated row from a classes_update message to the callback", async () => {
    const { client, deliver } = makeClient();
    const callback = jest.fn();

    await manager.subscribeToClassesUpdate(7, client, callback);
    deliver({ type: "classes_update", class_id: 7, data: { id: 7, name: "Renamed" }, timestamp: "t" });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith({ id: 7, name: "Renamed" });
  });

  it("ignores other message types on the same topic", async () => {
    const { client, deliver } = makeClient();
    const callback = jest.fn();

    await manager.subscribeToClassesUpdate(7, client, callback);
    deliver({ type: "table_change", table: "help_requests", class_id: 7, data: { id: 7 }, timestamp: "t" });

    expect(callback).not.toHaveBeenCalled();
  });

  it("ignores classes_update messages without a numeric row id", async () => {
    const { client, deliver } = makeClient();
    const callback = jest.fn();

    await manager.subscribeToClassesUpdate(7, client, callback);
    deliver({ type: "classes_update", class_id: 7, data: {}, timestamp: "t" });

    expect(callback).not.toHaveBeenCalled();
  });
});

describe("RealtimeChannelManager shared channel teardown", () => {
  let manager: RealtimeChannelManager;

  beforeEach(() => {
    manager = RealtimeChannelManager.getInstance();
  });

  afterEach(() => {
    manager.cleanup();
  });

  it("keeps the channel open for other subscribers when one unsubscribes", async () => {
    const { client, channel, deliver } = makeClient();
    const classesCallback = jest.fn();
    const otherCallback = jest.fn();

    const unsubscribeClasses = await manager.subscribeToClassesUpdate(7, client, classesCallback);
    await manager.subscribe("class:7:students", client, otherCallback, () => {});
    unsubscribeClasses();

    expect(channel.unsubscribe).not.toHaveBeenCalled();

    deliver({ type: "table_change", table: "help_requests", class_id: 7, data: { id: 1 }, timestamp: "t" });
    expect(otherCallback).toHaveBeenCalledTimes(1);
    expect(classesCallback).not.toHaveBeenCalled();
  });
});

describe("ClassRealTimeController classes_update handling", () => {
  it("does not dispatch classes_update messages to table subscribers, but still dispatches other messages", async () => {
    const { client } = makeClient();
    const controller = new ClassRealTimeController({ client, classId: 7, profileId: "p", isStaff: true });
    const wildcard = jest.fn();
    controller.subscribe({}, wildcard);
    const handle = (message: unknown) =>
      (controller as unknown as { _handleBroadcastMessage(m: unknown): void })._handleBroadcastMessage(message);

    handle({ type: "classes_update", class_id: 7, data: { id: 7 }, timestamp: "t" });
    expect(wildcard).not.toHaveBeenCalled();

    handle({ type: "table_change", table: "help_requests", class_id: 7, data: { id: 1 }, timestamp: "t" });
    expect(wildcard).toHaveBeenCalledTimes(1);

    controller.close();
  });
});
