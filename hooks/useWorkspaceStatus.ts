"use client";

import { WorkspaceClient, WorkspaceState } from "@/lib/workspaceStatus";
import { useCallback, useEffect, useRef, useState } from "react";

/** First poll delay while starting. Each later poll waits 1.5x longer, up to the maximum. */
export const POLL_MIN_MS = 2000;
export const POLL_MAX_MS = 10_000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Tracks one assignment's workspace. While it is starting, polls with a backoff, one request at a
 * time, and skips polls while the tab is hidden. Once ready or failed it stops polling, and checks
 * again only when the tab becomes visible, so a workspace stopped while the student was away
 * doesn't keep offering the editor.
 */
export function useWorkspaceStatus(client: WorkspaceClient, assignmentId: number) {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  // Numbers every request (each status check and each `open()`), and is bumped again on unmount.
  // Only the reply to the newest request is applied, so a slow poll can't overwrite what a newer
  // `open()` or tab-visible check returned, whether it resolves with an older state or rejects.
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++latestRequest.current;
    try {
      const next = await client.getStatus(assignmentId);
      if (seq !== latestRequest.current) return;
      setState(next);
      setError(null);
    } catch (e) {
      if (seq !== latestRequest.current) return;
      setError(errorMessage(e));
    }
  }, [client, assignmentId]);

  // Runs a user action (Open, Retry, Try again) with a pending flag, ignoring repeat clicks.
  const runAction = useCallback(async (action: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      await action();
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return () => {
      // A counter, not a DOM ref: bumping it here is what drops replies after unmount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      latestRequest.current++;
    };
  }, [refresh]);

  const isStarting = state?.status === "starting";
  useEffect(() => {
    if (!isStarting) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MIN_MS;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (!document.hidden) {
          await refresh();
          delay = Math.min(delay * 1.5, POLL_MAX_MS);
        }
        if (!stopped) schedule();
      }, delay);
    };
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [isStarting, refresh]);

  const hasState = state !== null;
  useEffect(() => {
    if (!hasState) return;
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [hasState, refresh]);

  const open = useCallback(
    () =>
      runAction(async () => {
        const seq = ++latestRequest.current;
        setError(null);
        try {
          const next = await client.open(assignmentId);
          if (seq === latestRequest.current) setState(next);
        } catch (e) {
          if (seq === latestRequest.current) setError(errorMessage(e));
        }
      }),
    [runAction, client, assignmentId]
  );

  /** Checks the status again, for when the first lookup failed. */
  const reload = useCallback(() => runAction(refresh), [runAction, refresh]);

  return { state, error, pending, open, reload };
}
