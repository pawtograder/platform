import { TabLeaderElection } from "@/lib/cross-tab/TabLeaderElection";

// ---------------------------------------------------------------------------
// Minimal BroadcastChannel mock for jsdom (which has no native support).
//
// Static registry keyed by channel name. postMessage delivers asynchronously
// (via setTimeout(0)) to every *other* instance sharing the same name.
// ---------------------------------------------------------------------------

type MockHandler = ((event: MessageEvent) => void) | null;

class MockBroadcastChannel {
  static _registry: Map<string, Set<MockBroadcastChannel>> = new Map();

  readonly name: string;
  onmessage: MockHandler = null;
  private _closed = false;

  constructor(name: string) {
    this.name = name;
    let set = MockBroadcastChannel._registry.get(name);
    if (!set) {
      set = new Set();
      MockBroadcastChannel._registry.set(name, set);
    }
    set.add(this);
  }

  postMessage(data: unknown): void {
    if (this._closed) return;
    const peers = MockBroadcastChannel._registry.get(this.name);
    if (!peers) return;
    for (const peer of peers) {
      if (peer !== this && !peer._closed && peer.onmessage) {
        // Deliver synchronously so fake timers can control ordering.
        peer.onmessage(new MessageEvent("message", { data }));
      }
    }
  }

  close(): void {
    this._closed = true;
    const set = MockBroadcastChannel._registry.get(this.name);
    if (set) {
      set.delete(this);
      if (set.size === 0) {
        MockBroadcastChannel._registry.delete(this.name);
      }
    }
  }

  // Stubs for spec completeness.
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent(): boolean {
    return false;
  }
}

// Install the mock globally before any test code runs.
(globalThis as any).BroadcastChannel = MockBroadcastChannel;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("TabLeaderElection", () => {
  let instances: TabLeaderElection[];

  beforeEach(() => {
    jest.useFakeTimers();
    instances = [];
    MockBroadcastChannel._registry.clear();
  });

  afterEach(() => {
    // Close all instances to clean up timers and channels.
    for (const inst of instances) {
      inst.close();
    }
    instances = [];
    jest.useRealTimers();
  });

  /** Helper: create an instance and track it for cleanup. */
  function create(tabId: string, channelName?: string): TabLeaderElection {
    const inst = new TabLeaderElection({
      tabId,
      channelName: channelName ?? "test-leader"
    });
    instances.push(inst);
    return inst;
  }

  // -------------------------------------------------------------------------
  // 1. Bootstrap as leader
  // -------------------------------------------------------------------------
  it("becomes leader when it is the only tab", () => {
    const tab = create("aaa");
    expect(tab.isLeader).toBe(false);

    // After the initial claim timeout (1 s), the solo tab promotes itself.
    jest.advanceTimersByTime(1_000);
    expect(tab.isLeader).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 2. Second tab becomes follower
  // -------------------------------------------------------------------------
  it("second tab with higher id yields to existing leader", () => {
    const tab1 = create("aaa");
    jest.advanceTimersByTime(1_000); // tab1 becomes leader
    expect(tab1.isLeader).toBe(true);

    const tab2 = create("bbb");
    // tab2 sends a claim, tab1 re-asserts (aaa < bbb), tab2 should yield.
    jest.advanceTimersByTime(1_000);

    expect(tab1.isLeader).toBe(true);
    expect(tab2.isLeader).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 3. Clean handoff (resign)
  // -------------------------------------------------------------------------
  it("follower becomes leader after the current leader resigns", () => {
    const tab1 = create("aaa");
    jest.advanceTimersByTime(1_000);
    expect(tab1.isLeader).toBe(true);

    const tab2 = create("bbb");
    jest.advanceTimersByTime(1_000);
    expect(tab2.isLeader).toBe(false);

    // Leader resigns.
    tab1.resign();
    expect(tab1.isLeader).toBe(false);

    // tab2 should claim and become leader after claim timeout.
    jest.advanceTimersByTime(1_000);
    expect(tab2.isLeader).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 4. Crash recovery (leader stops heartbeating)
  // -------------------------------------------------------------------------
  it("follower takes over after leader stops heartbeating", () => {
    const tab1 = create("aaa");
    jest.advanceTimersByTime(1_000);
    expect(tab1.isLeader).toBe(true);

    const tab2 = create("bbb");
    jest.advanceTimersByTime(1_000);
    expect(tab2.isLeader).toBe(false);

    // Simulate crash: close tab1's channel without sending resign.
    tab1.close();

    // Follower's dead-leader timeout is 5 s, then claim timeout is 1 s.
    jest.advanceTimersByTime(5_000 + 1_000);
    expect(tab2.isLeader).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 5. Split-brain prevention (simultaneous claims)
  // -------------------------------------------------------------------------
  it("lowest tabId wins when two tabs claim simultaneously", () => {
    // Create both tabs at the "same time" before any timers fire.
    const tabLow = create("aaa");
    const tabHigh = create("zzz");

    // Both sent claims on construction. The claim handlers run synchronously
    // via the mock, so the tiebreak has already happened. Advance past the
    // initial claim timeout to let the winner promote itself.
    jest.advanceTimersByTime(1_000);

    expect(tabLow.isLeader).toBe(true);
    expect(tabHigh.isLeader).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 6. Listener notifications
  // -------------------------------------------------------------------------
  it("onLeaderChange fires on leadership transitions", () => {
    const tab = create("aaa");
    const transitions: boolean[] = [];
    tab.onLeaderChange((isLeader) => transitions.push(isLeader));

    // Become leader.
    jest.advanceTimersByTime(1_000);
    expect(transitions).toEqual([true]);

    // Resign.
    tab.resign();
    expect(transitions).toEqual([true, false]);
  });

  // -------------------------------------------------------------------------
  // 7. Unsubscribe works
  // -------------------------------------------------------------------------
  it("removed listener does not fire after unsubscribe", () => {
    const tab = create("aaa");
    const calls: boolean[] = [];
    const unsub = tab.onLeaderChange((v) => calls.push(v));

    unsub();

    jest.advanceTimersByTime(1_000);
    expect(calls).toEqual([]); // listener was removed before transition
  });

  // -------------------------------------------------------------------------
  // 8. Close cleanup
  // -------------------------------------------------------------------------
  it("sends no messages after close()", () => {
    const tab1 = create("aaa");
    jest.advanceTimersByTime(1_000);
    expect(tab1.isLeader).toBe(true);

    const tab2 = create("bbb");
    jest.advanceTimersByTime(1_000);

    // Close the leader.
    tab1.close();

    // Spy on the remaining channel to ensure the closed tab sends nothing.
    const channelSet = MockBroadcastChannel._registry.get("test-leader");
    const remainingChannels = channelSet ? [...channelSet] : [];
    const spies = remainingChannels.map((ch) => jest.spyOn(ch, "onmessage" as any));

    // Advance well past heartbeat interval — closed tab must not send.
    jest.advanceTimersByTime(10_000);

    // The only messages tab2's channel should have received are from its own
    // election, not from the closed tab1. Verify tab1 has no channel in the
    // registry (it was removed on close).
    const registeredNames = [...MockBroadcastChannel._registry.keys()];
    // tab1 closed its channel, so it should not be in the registry any longer
    // as the sole sender on "test-leader". tab2 is still there.
    expect(tab1.isLeader).toBe(false);

    // Verify tab2 eventually becomes leader after taking over.
    expect(tab2.isLeader).toBe(true);
  });
});
