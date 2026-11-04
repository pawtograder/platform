"use client";

import { WorkspaceClient, WorkspaceState } from "@/lib/workspaceStatus";
import { useCallback, useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 1000;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Tracks one assignment's workspace. Polls while it is starting and stops once it is ready or has
 * failed, so a finished workspace costs no requests.
 */
export function useWorkspaceStatus(client: WorkspaceClient, assignmentId: number) {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  // Every successful reply clears the error, so one failed poll doesn't leave "Could not reach
  // your workspace" on screen after the workspace recovers.
  const refresh = useCallback(async () => {
    try {
      const next = await client.getStatus(assignmentId);
      if (!mounted.current) return;
      setState(next);
      setError(null);
    } catch (e) {
      if (!mounted.current) return;
      setError(errorMessage(e));
    }
  }, [client, assignmentId]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const isStarting = state?.status === "starting";
  useEffect(() => {
    if (!isStarting) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isStarting, refresh]);

  const open = useCallback(async () => {
    setError(null);
    try {
      setState(await client.open(assignmentId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [client, assignmentId]);

  return { state, error, open, reload: refresh };
}
