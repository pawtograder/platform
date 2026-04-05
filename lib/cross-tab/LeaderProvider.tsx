"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { TabLeaderElection } from "./TabLeaderElection";
import { RealtimeDiffChannel } from "./RealtimeDiffChannel";

export type LeaderContextValue = {
  isLeader: boolean;
  leader: TabLeaderElection | null;
  diffChannel: RealtimeDiffChannel | null;
  tabId: string;
};

const LeaderContext = createContext<LeaderContextValue>({
  isLeader: false,
  leader: null,
  diffChannel: null,
  tabId: ""
});

export function useLeaderContext(): LeaderContextValue {
  return useContext(LeaderContext);
}

export function LeaderProvider({ children }: { children: React.ReactNode }) {
  const [isLeader, setIsLeader] = useState(false);

  // Create instances once and keep them stable across re-renders.
  // Guard against SSR: only create if window is available.
  const leaderRef = useRef<TabLeaderElection | null>(null);
  const diffChannelRef = useRef<RealtimeDiffChannel | null>(null);

  if (typeof window !== "undefined" && leaderRef.current === null) {
    const leader = new TabLeaderElection();
    leaderRef.current = leader;
    diffChannelRef.current = new RealtimeDiffChannel(leader.tabId);
  }

  useEffect(() => {
    const leader = leaderRef.current;
    if (!leader) return;

    // Sync initial state in case the election resolved before the effect ran.
    setIsLeader(leader.isLeader);

    const unsub = leader.onLeaderChange((newIsLeader) => {
      setIsLeader(newIsLeader);
    });

    return () => {
      unsub();
      leader.close();
      diffChannelRef.current?.close();
    };
  }, []);

  const value: LeaderContextValue = {
    isLeader,
    leader: leaderRef.current,
    diffChannel: diffChannelRef.current,
    tabId: leaderRef.current?.tabId ?? ""
  };

  return <LeaderContext.Provider value={value}>{children}</LeaderContext.Provider>;
}
