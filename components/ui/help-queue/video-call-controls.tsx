/**
 * Video Call Controls Component
 * Handles video call lifecycle management for help requests
 */
"use client";

import { useState, useCallback } from "react";
import { Button, Icon, HStack, Badge, Text } from "@chakra-ui/react";
import { BsCameraVideo, BsCameraVideoOff, BsPersonVideo, BsPersonVideo2 } from "react-icons/bs";
import { useUpdate } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { liveMeetingForHelpRequest, liveMeetingEnd } from "@/lib/edgeFunctions";
import type { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { toaster } from "@/components/ui/toaster";
import { useMeetingWindows } from "@/hooks/useMeetingWindows";

type VideoCallControlsProps = {
  request: HelpRequest;
  /** Whether the current user can start video calls (TAs/instructors) */
  canStartCall?: boolean;
  /** Size of the controls */
  size?: "sm" | "md" | "lg";
  /** Whether to show full controls or just join button */
  variant?: "full" | "minimal";
};

/**
 * Component for managing video call controls in help requests.
 * Provides functionality to start, join, and end video calls.
 */
export default function VideoCallControls({
  request,
  canStartCall = false,
  size = "md",
  variant = "full"
}: VideoCallControlsProps) {
  const [isStartingCall, setIsStartingCall] = useState(false);
  const [isEndingCall, setIsEndingCall] = useState(false);
  const supabase = createClient();
  const { openMeetingWindow } = useMeetingWindows();

  const { mutateAsync: updateRequest } = useUpdate<HelpRequest>({
    resource: "help_requests",
    id: request.id
  });

  /**
   * Starts a video call for the help request
   */
  const startVideoCall = useCallback(async () => {
    if (!canStartCall || isStartingCall) return;

    setIsStartingCall(true);
    try {
      // First mark the request as having a live video call
      await updateRequest({
        id: request.id,
        values: {
          is_video_live: true
        }
      });

      // Create the meeting session
      await liveMeetingForHelpRequest(
        {
          courseId: request.class_id,
          helpRequestId: request.id
        },
        supabase
      );

      // Open the video call in a new window for the TA/instructor using managed window
      openMeetingWindow(request.class_id, request.id, request.help_queue);

      toaster.success({
        title: "Video call started",
        description: "Video meeting has been initiated for this help request"
      });
    } catch (error) {
      toaster.error({
        title: "Failed to start video call",
        description: error instanceof Error ? error.message : "An unexpected error occurred"
      });

      // Revert the video live status on error
      await updateRequest({
        id: request.id,
        values: {
          is_video_live: false
        }
      });
    } finally {
      setIsStartingCall(false);
    }
  }, [canStartCall, isStartingCall, updateRequest, request, supabase, openMeetingWindow]);

  /**
   * Joins an existing video call
   */
  const joinVideoCall = useCallback(() => {
    // Use managed window opening
    openMeetingWindow(request.class_id, request.id, request.help_queue);

    toaster.success({
      title: "Joining video call",
      description: "Opening video meeting window"
    });
  }, [request, openMeetingWindow]);

  /**
   * Ends the video call
   */
  const endVideoCall = useCallback(async () => {
    if (isEndingCall) return;

    setIsEndingCall(true);
    try {
      // Call the edge function to properly end the Chime meeting
      await liveMeetingEnd(
        {
          courseId: request.class_id,
          helpRequestId: request.id
        },
        supabase
      );

      toaster.success({
        title: "Video call ended",
        description: "Video meeting has been terminated for all participants"
      });
    } catch (error) {
      toaster.error({
        title: "Failed to end video call",
        description: error instanceof Error ? error.message : "An unexpected error occurred"
      });
    } finally {
      setIsEndingCall(false);
    }
  }, [isEndingCall, request, supabase]);

  const isRequestInactive = request.status === "resolved" || request.status === "closed";
  // TODO:Use auth context to check if current user is instructor or grader
  const currentUserIsInstructorOrGrader = true;

  // Minimal variant - just shows join button when call is live
  if (variant === "minimal") {
    if (!request.is_video_live) return null;

    return (
      <Button size={size} colorPalette="green" onClick={joinVideoCall} disabled={isRequestInactive}>
        <Icon as={BsPersonVideo} />
        Join Video Call
      </Button>
    );
  }

  // Full variant - shows all controls based on permissions and state
  return (
    <HStack gap={2}>
      {/* Video Call Status Badge */}
      {request.is_video_live && (
        <Badge colorPalette="green" variant="solid" size={size}>
          <HStack gap={1}>
            <Icon as={BsPersonVideo2} />
            <Text>Live</Text>
          </HStack>
        </Badge>
      )}

      {/* Video Call Action Buttons */}
      {!request.is_video_live ? (
        // No video call active - show start button for TAs/instructors
        canStartCall && (
          <Button
            size={size}
            onClick={startVideoCall}
            loading={isStartingCall}
            // Only graders and instructors can start video calls
            visibility={isRequestInactive && !currentUserIsInstructorOrGrader ? "hidden" : "visible"}
          >
            <Icon as={BsCameraVideo} />
            Start Video Call
          </Button>
        )
      ) : (
        // Video call is active - show join and end buttons
        <HStack gap={2}>
          <Button size={size} colorPalette="blue" onClick={joinVideoCall} disabled={isRequestInactive}>
            <Icon as={BsPersonVideo} />
            Join Call
          </Button>

          {canStartCall && (
            <Button
              size={size}
              colorPalette="red"
              variant="outline"
              onClick={endVideoCall}
              loading={isEndingCall}
              disabled={isRequestInactive}
            >
              <Icon as={BsCameraVideoOff} />
              End Call
            </Button>
          )}
        </HStack>
      )}
    </HStack>
  );
}
