/**
 * Custom hook to manage meeting window references and automatically close them
 * when meetings end or participants leave
 */
"use client";

import { useRef, useEffect, useCallback } from "react";
import { createClient } from "@/utils/supabase/client";
import type { HelpRequest } from "@/utils/supabase/DatabaseTypes";

type MeetingWindow = {
  window: Window;
  helpRequestId: number;
  courseId: number;
};

export function useMeetingWindows() {
  const meetingWindows = useRef<Map<string, MeetingWindow>>(new Map());
  const supabase = createClient();

  /**
   * Opens a meeting window and tracks it for automatic cleanup
   */
  const openMeetingWindow = useCallback((courseId: number, helpRequestId: number, queueId?: number) => {
    const windowKey = `${courseId}-${helpRequestId}`;

    // Close existing window for this help request if it exists
    const existingWindow = meetingWindows.current.get(windowKey);
    if (existingWindow && !existingWindow.window.closed) {
      existingWindow.window.close();
    }

    // Open new meeting window
    const meetingWindow = window.open(
      `/course/${courseId}/office-hours/${queueId || "queue"}/request/${helpRequestId}/meet`,
      "_blank",
      "width=1200,height=800,resizable=yes,scrollbars=yes"
    );

    if (meetingWindow) {
      // Store window reference
      meetingWindows.current.set(windowKey, {
        window: meetingWindow,
        helpRequestId,
        courseId
      });

      // Clean up reference when window is manually closed
      const checkClosed = setInterval(() => {
        if (meetingWindow.closed) {
          meetingWindows.current.delete(windowKey);
          clearInterval(checkClosed);
        }
      }, 1000);
    }

    return meetingWindow;
  }, []);

  /**
   * Closes a specific meeting window
   */
  const closeMeetingWindow = useCallback((courseId: number, helpRequestId: number) => {
    const windowKey = `${courseId}-${helpRequestId}`;
    const meetingWindow = meetingWindows.current.get(windowKey);

    if (meetingWindow && !meetingWindow.window.closed) {
      meetingWindow.window.close();
      meetingWindows.current.delete(windowKey);
    }
  }, []);

  /**
   * Closes all meeting windows
   */
  const closeAllMeetingWindows = useCallback(() => {
    meetingWindows.current.forEach((meetingWindow) => {
      if (!meetingWindow.window.closed) {
        meetingWindow.window.close();
      }
    });
    meetingWindows.current.clear();
  }, []);

  /**
   * Set up real-time subscription to detect meeting state changes
   */
  useEffect(() => {
    const channel = supabase
      .channel("meeting-windows-cleanup")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "help_requests",
          filter: "is_video_live=eq.false"
        },
        (payload) => {
          const updatedRequest = payload.new as HelpRequest;

          // Close the meeting window for this help request
          closeMeetingWindow(updatedRequest.class_id, updatedRequest.id);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase, closeMeetingWindow]);

  /**
   * Clean up all windows when component unmounts
   */
  useEffect(() => {
    return () => {
      closeAllMeetingWindows();
    };
  }, [closeAllMeetingWindows]);

  return {
    openMeetingWindow,
    closeMeetingWindow,
    closeAllMeetingWindows
  };
}
