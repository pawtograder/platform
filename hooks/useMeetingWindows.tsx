/**
 * Custom hook to manage meeting window references and automatically close them
 * when meetings end or participants leave
 */
"use client";

import { useCallback, useEffect, useRef } from "react";
import { createClient } from "@/utils/supabase/client";
import type { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { useCreate } from "@refinedev/core";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";

type MeetingWindow = {
  window: Window;
  helpRequestId: number;
  courseId: number;
};

export function useMeetingWindows() {
  const meetingWindows = useRef<Map<string, MeetingWindow>>(new Map());
  const supabase = createClient();
  const { private_profile_id } = useClassProfiles();
  const allHelpRequestStudents = useHelpRequestStudents();

  // Hook for logging student activity
  const { mutateAsync: createStudentActivity } = useCreate({
    resource: "student_help_activity"
  });

  // Helper function to log video left activity for the current user
  const logVideoLeftActivity = useCallback(
    async (helpRequestId: number, courseId: number) => {
      if (!private_profile_id) return;

      // Check if current user is a student in this help request
      const isStudentInRequest = allHelpRequestStudents.some(
        (student) => student.help_request_id === helpRequestId && student.profile_id === private_profile_id
      );

      // Only log activity for students who are part of the request
      if (isStudentInRequest) {
        try {
          await createStudentActivity({
            values: {
              student_profile_id: private_profile_id,
              class_id: courseId,
              help_request_id: helpRequestId,
              activity_type: "video_left",
              activity_description: "User left video call by closing meeting window"
            }
          });
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(`Failed to log video_left activity:`, error);
        }
      }
    },
    [private_profile_id, allHelpRequestStudents, createStudentActivity]
  );

  /**
   * Opens a meeting window and tracks it for automatic cleanup
   */
  const openMeetingWindow = useCallback(
    (courseId: number, helpRequestId: number, queueId?: number) => {
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
            // Log video left activity when user manually closes the meeting window
            logVideoLeftActivity(helpRequestId, courseId);

            meetingWindows.current.delete(windowKey);
            clearInterval(checkClosed);
          }
        }, 1000);
      }

      return meetingWindow;
    },
    [logVideoLeftActivity]
  );

  /**
   * Closes a specific meeting window
   */
  const closeMeetingWindow = useCallback(
    (courseId: number, helpRequestId: number) => {
      const windowKey = `${courseId}-${helpRequestId}`;
      const meetingWindow = meetingWindows.current.get(windowKey);

      if (meetingWindow && !meetingWindow.window.closed) {
        meetingWindow.window.close();
        meetingWindows.current.delete(windowKey);

        // Log video left activity when window is programmatically closed
        logVideoLeftActivity(helpRequestId, courseId);
      }
    },
    [logVideoLeftActivity]
  );

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
