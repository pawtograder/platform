"use client";

import { useState, useEffect } from "react";
import { useOfficeHoursController } from "./useOfficeHoursRealtime";
import type { OfficeHoursConnectionStatus } from "@/utils/supabase/DatabaseTypes";

export interface UseConnectionStatusReturn {
  // Connection states
  isConnected: boolean;
  isValidating: boolean;
  isAuthorized: boolean;
  connectionError: string | null;

  // Detailed status
  connectionStatus: OfficeHoursConnectionStatus | null;

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

  // Calculate derived connection states
  const isConnected = connectionStatus?.overall === "connected";
  const isValidating = connectionStatus?.overall === "connecting";
  const isAuthorized = connectionStatus?.overall !== "disconnected" || connectionError === null;
  const isLoading = !controller.isReady;

  return {
    isConnected,
    isValidating,
    isAuthorized,
    connectionError,
    connectionStatus,
    isLoading
  };
}
