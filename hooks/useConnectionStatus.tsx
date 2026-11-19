"use client";

import { useState, useEffect } from "react";
import { useOfficeHoursController } from "./useOfficeHoursRealtime";

/**
 * Connection status for office hours realtime controller
 */
export type OfficeHoursChannelStatus = {
  name: string;
  state: "closed" | "errored" | "joined" | "joining" | "leaving";
  type: "help_request" | "help_request_staff" | "help_queue" | "help_queues";
  help_request_id?: number;
  help_queue_id?: number;
};

export type OfficeHoursConnectionStatus = {
  overall: "connected" | "connecting" | "disconnected" | "partial";
  channels: OfficeHoursChannelStatus[];
  lastUpdate: Date;
};

export interface UseConnectionStatusReturn {
  // Connection states
  isConnected: boolean;
  isValidating: boolean;
  isAuthorized: boolean;
  connectionError: string | null;

  // Detailed status
  connectionStatus: OfficeHoursConnectionStatus | null;

  // True once a channel has errored or closed, until every channel joins again
  connectionFailed: boolean;

  // Loading state
  isLoading: boolean;
}

/**
 * Hook for monitoring real-time connection status in office hours functionality.
 * Provides simplified connection state booleans and detailed status information.
 *
 * This hook replaces the connection status functionality from useOfficeHoursRealtime.
 */
export function useConnectionStatus(): UseConnectionStatusReturn {
  const controller = useOfficeHoursController();
  const [connectionStatus, setConnectionStatus] = useState<OfficeHoursConnectionStatus | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  useEffect(() => {
    const updateStatus = () => {
      try {
        const status = controller.getConnectionStatus() as OfficeHoursConnectionStatus;
        setConnectionStatus(status);
        setConnectionError(null);
      } catch (error) {
        console.error("Failed to get connection status:", error);
        setConnectionError(error instanceof Error ? error.message : "Unknown connection error");
      }
    };

    // Get initial status
    updateStatus();

    // Subscribe to status changes if available
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = controller.officeHoursRealTimeController?.subscribeToStatus?.(updateStatus);
    } catch (error) {
      console.warn("Could not subscribe to status changes:", error);
    }

    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [controller]);

  // A channel that is retrying passes back through "joining", which would make a
  // warning flicker on every attempt. Hold the failure until the channels rejoin,
  // or until there are no channels left to fail.
  const [connectionFailed, setConnectionFailed] = useState(false);
  useEffect(() => {
    if (connectionStatus?.overall === "connected" || connectionStatus?.channels.length === 0) {
      setConnectionFailed(false);
    } else if (connectionStatus?.channels.some((c) => c.state === "errored" || c.state === "closed")) {
      setConnectionFailed(true);
    }
  }, [connectionStatus]);

  // Calculate derived connection states
  const isConnected = connectionStatus?.overall === "connected";
  const isValidating = connectionStatus?.overall === "connecting";
  const isAuthorized = connectionStatus?.overall !== "disconnected" && connectionError === null;
  const isLoading = !controller.isReady;

  return {
    isConnected,
    isValidating,
    isAuthorized,
    connectionError,
    connectionStatus,
    connectionFailed,
    isLoading
  };
}
