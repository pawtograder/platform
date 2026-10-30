"use client";

import { WorkspaceClient, WorkspaceState } from "@/lib/workspaceStatus";
import { useCallback, useEffect, useState } from "react";

const POLL_INTERVAL_MS = 1000;

/**
 * Tracks one assignment's workspace. Polls while it is starting and stops once it is ready or has
 * failed, so a finished workspace costs no requests.
 */
export function useWorkspaceStatus(client: WorkspaceClient, assignmentId: number) {
  const [state, setState] = useState<WorkspaceState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .getStatus(assignmentId)
      .then((s) => !cancelled && setState(s))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [client, assignmentId]);

  const isStarting = state?.status === "starting";
  useEffect(() => {
    if (!isStarting) return;
    const timer = setInterval(() => {
      client
        .getStatus(assignmentId)
        .then(setState)
        .catch((e: Error) => setError(e.message));
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [client, assignmentId, isStarting]);

  const open = useCallback(async () => {
    setError(null);
    try {
      setState(await client.open(assignmentId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client, assignmentId]);

  return { state, error, open };
}
