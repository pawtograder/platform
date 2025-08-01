"use client";

/**
 * Hook for monitoring realtime connection status across class and office hours functionality.
 *
 * This module provides:
 * - Combined status monitoring for class realtime controller and office hours realtime controller
 * - Automatic detection and inclusion of office hours status when on office hours pages
 * - Unified channel status reporting with support for all channel types:
 *   - Class channels: staff, user, submission_graders, submission_user
 *   - Office hours channels: help_queues, help_request, help_request_staff, help_queue
 */

import { useState, useEffect } from "react";
import { usePathname, useParams } from "next/navigation";
import { useCourseController } from "./useCourseController";
import { ConnectionStatus } from "@/lib/ClassRealTimeController";
import {
  OfficeHoursRealTimeController,
  ConnectionStatus as OfficeHoursConnectionStatus
} from "@/lib/OfficeHoursRealTimeController";
import { useConnectionStatus } from "./useOfficeHoursRealtime";

/**
 * Combined connection status that includes both class and office hours realtime connections
 */
export interface CombinedConnectionStatus {
  overall: "connected" | "connecting" | "disconnected" | "partial";
  channels: CombinedChannelStatus[];
  lastUpdate: Date;
}

export interface CombinedChannelStatus {
  name: string;
  state: string;
  type:
    | "staff"
    | "user"
    | "submission_graders"
    | "submission_user"
    | "help_queues"
    | "help_request"
    | "help_request_staff"
    | "help_queue";
  submissionId?: number;
  help_request_id?: number;
  help_queue_id?: number;
}

export interface UseRealtimeConnectionStatusOptions {
  /**
   * Optional office hours controller to include in status monitoring.
   * This allows combining class realtime status with office hours realtime status.
   *
   * Example usage:
   * ```tsx
   * // Connection status is automatically detected based on current page context
   * const status = useAutomaticRealtimeConnectionStatus();
   * ```
   */
  officeHoursController?: OfficeHoursRealTimeController | null;
}

/**
 * Hook to monitor realtime connection status for both class and office hours functionality.
 *
 * Returns a combined status that includes channels from:
 * - Class realtime controller (staff/user data, submission channels)
 * - Office hours realtime controller (help requests, help queues) - optional
 *
 * @param options Configuration options including optional office hours controller
 * @returns Combined connection status with all active channels
 */
export function useRealtimeConnectionStatus(
  options: UseRealtimeConnectionStatusOptions = {}
): CombinedConnectionStatus | null {
  const [status, setStatus] = useState<CombinedConnectionStatus | null>(null);
  const courseController = useCourseController();
  const classRealTimeController = courseController.classRealTimeController;
  const { officeHoursController } = options;

  useEffect(() => {
    // Get initial status
    const updateCombinedStatus = () => {
      const classStatus = classRealTimeController.getConnectionStatus();
      const officeHoursStatus = officeHoursController?.getConnectionStatus();

      const combinedStatus = combineConnectionStatuses(classStatus, officeHoursStatus);
      setStatus(combinedStatus);
    };

    // Set initial status
    updateCombinedStatus();

    // Subscribe to class status changes
    const unsubscribeClass = classRealTimeController.subscribeToStatus((newClassStatus) => {
      const officeHoursStatus = officeHoursController?.getConnectionStatus();
      const combinedStatus = combineConnectionStatuses(newClassStatus, officeHoursStatus);
      setStatus(combinedStatus);
    });

    // Subscribe to office hours status changes if controller is available
    let unsubscribeOfficeHours: (() => void) | undefined;
    if (officeHoursController) {
      unsubscribeOfficeHours = officeHoursController.subscribeToStatus((newOfficeHoursStatus) => {
        const classStatus = classRealTimeController.getConnectionStatus();
        const combinedStatus = combineConnectionStatuses(classStatus, newOfficeHoursStatus);
        setStatus(combinedStatus);
      });
    }

    return () => {
      unsubscribeClass();
      if (unsubscribeOfficeHours) {
        unsubscribeOfficeHours();
      }
    };
  }, [classRealTimeController, officeHoursController]);

  return status;
}

/**
 * Combine connection statuses from class and office hours controllers
 */
function combineConnectionStatuses(
  classStatus: ConnectionStatus,
  officeHoursStatus?: OfficeHoursConnectionStatus
): CombinedConnectionStatus {
  // Convert class channels to combined format
  const classChannels: CombinedChannelStatus[] = classStatus.channels.map((channel) => ({
    name: channel.name,
    state: channel.state,
    type: channel.type as CombinedChannelStatus["type"],
    submissionId: "submissionId" in channel ? channel.submissionId : undefined
  }));

  // Convert office hours channels to combined format (if available)
  const officeHoursChannels: CombinedChannelStatus[] = officeHoursStatus
    ? officeHoursStatus.channels.map((channel) => ({
        name: channel.name,
        state: channel.state,
        type: channel.type as CombinedChannelStatus["type"],
        help_request_id: "help_request_id" in channel ? channel.help_request_id : undefined,
        help_queue_id: "help_queue_id" in channel ? channel.help_queue_id : undefined
      }))
    : [];

  // Combine all channels
  const allChannels = [...classChannels, ...officeHoursChannels];

  // Calculate overall status
  let overall: CombinedConnectionStatus["overall"];
  if (allChannels.length === 0) {
    overall = "connecting";
  } else {
    const connectedCount = allChannels.filter((c) => c.state === "joined").length;
    const totalCount = allChannels.length;

    if (connectedCount === totalCount) {
      overall = "connected";
    } else if (connectedCount === 0) {
      overall = "disconnected";
    } else {
      overall = "partial";
    }
  }

  return {
    overall,
    channels: allChannels,
    lastUpdate: new Date()
  };
}

/**
 * Automatic version of useRealtimeConnectionStatus that detects office hours context
 * and automatically includes office hours realtime status when on office hours pages.
 *
 * This hook is useful for global components like the ConnectionStatusIndicator
 * that should show comprehensive status across different areas of the app.
 *
 * @returns Combined connection status with automatic office hours integration
 */
export function useAutomaticRealtimeConnectionStatus(): CombinedConnectionStatus | null {
  const pathname = usePathname();
  const params = useParams();

  // Detect if we're in office hours context and have a valid course ID
  const isInOfficeHours = pathname?.includes("/office-hours") ?? false;
  const courseId = params?.course_id ? parseInt(params.course_id as string, 10) : undefined;
  const shouldEnableOfficeHours = isInOfficeHours && courseId && !isNaN(courseId) && courseId > 0;

  // Get connection status from our individual hook when in office hours context
  const { connectionStatus: officeHoursConnectionStatus } = useConnectionStatus();

  // Use the base hook with class controller only
  const classConnectionStatus = useRealtimeConnectionStatus({});

  // If not in office hours context, just return class status
  if (!shouldEnableOfficeHours) {
    return classConnectionStatus;
  }

  // Combine class and office hours connection status manually
  const combinedStatus: CombinedConnectionStatus = {
    overall: classConnectionStatus?.overall === "connected" &&
             officeHoursConnectionStatus?.overall === "connected"
             ? "connected"
             : classConnectionStatus?.overall === "disconnected" ||
               officeHoursConnectionStatus?.overall === "disconnected"
             ? "disconnected"
             : "partial",
    channels: [
      ...(classConnectionStatus?.channels || []),
      // Add a synthetic office hours channel status
      {
        name: "office-hours",
        state: officeHoursConnectionStatus?.overall === "connected" ? "joined" : "closed",
        type: "help_queues" as const
      }
    ],
    lastUpdate: new Date()
  };

  return combinedStatus;
}
