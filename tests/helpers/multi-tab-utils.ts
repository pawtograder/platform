/**
 * Utility functions for simulating multi-tab scenarios in integration tests.
 *
 * Uses MockBroadcastChannel, TabLeaderElection, RealtimeDiffChannel, and
 * separate QueryClient instances to model independent browser tabs.
 */

import { QueryClient } from "@tanstack/react-query";
import { TabLeaderElection } from "@/lib/cross-tab/TabLeaderElection";
import { RealtimeDiffChannel } from "@/lib/cross-tab/RealtimeDiffChannel";

export type SimulatedTab = {
  id: string;
  queryClient: QueryClient;
  leader: TabLeaderElection;
  diffChannel: RealtimeDiffChannel;
};

/** Create N simulated tabs with deterministic IDs. */
export function createTabs(count: number, channelPrefix = "test"): SimulatedTab[] {
  const tabs: SimulatedTab[] = [];
  for (let i = 0; i < count; i++) {
    const id = `tab-${String.fromCharCode(97 + i)}`; // tab-a, tab-b, tab-c, ...
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false }
      }
    });
    const leader = new TabLeaderElection({
      tabId: id,
      channelName: `${channelPrefix}-leader`
    });
    const diffChannel = new RealtimeDiffChannel(id, {
      channelName: `${channelPrefix}-diffs`
    });
    tabs.push({ id, queryClient, leader, diffChannel });
  }
  return tabs;
}

/** Clean up all tabs (close leaders, diff channels, clear query clients). */
export function closeTabs(tabs: SimulatedTab[]): void {
  for (const tab of tabs) {
    tab.leader.close();
    tab.diffChannel.close();
    tab.queryClient.clear();
  }
}

/**
 * Wait for exactly one tab to become leader (using jest fake timers).
 * Returns the tab that won the election.
 */
export function electLeader(tabs: SimulatedTab[]): SimulatedTab {
  // Advance past INITIAL_CLAIM_TIMEOUT_MS (1000ms) to resolve the election
  jest.advanceTimersByTime(1_500);

  const leaders = tabs.filter((t) => t.leader.isLeader);
  if (leaders.length !== 1) {
    throw new Error(`Expected exactly 1 leader, got ${leaders.length}`);
  }
  return leaders[0];
}
