/**
 * Video Call Controls Component
 * Handles video call lifecycle management for help requests
 */
"use client";

import { useState, useCallback } from "react";
import { Button, Icon, HStack, Badge, Text } from "@chakra-ui/react";
import { BsCameraVideo, BsCameraVideoOff, BsPersonVideo, BsPersonVideo2 } from "react-icons/bs";
import { useUpdate, useCreate } from "@refinedev/core";
import { createClient } from "@/utils/supabase/client";
import { liveMeetingForHelpRequest, liveMeetingEnd } from "@/lib/edgeFunctions";
import type { HelpRequest } from "@/utils/supabase/DatabaseTypes";
import { toaster } from "@/components/ui/toaster";
import { useMeetingWindows } from "@/hooks/useMeetingWindows";
import { useClassProfiles } from "@/hooks/useClassProfiles";
import { useHelpRequestStudents } from "@/hooks/useOfficeHoursRealtime";

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
  const [isJoiningCall, setIsJoiningCall] = useState(false);
  const [isEndingCall, setIsEndingCall] = useState(false);
  const supabase = createClient();
  const { openMeetingWindow } = useMeetingWindows();
  const { private_profile_id } = useClassProfiles();
  const allHelpRequestStudents = useHelpRequestStudents();

  const { mutateAsync: updateRequest } = useUpdate<HelpRequest>({
    resource: "help_requests",
    id: request.id
  });

  // Hook for logging student activity
  const { mutateAsync: createStudentActivity } = useCreate({
    resource: "student_help_activity"
  });

  // Helper function to log activity for the current user if they're a student in the request
  const logVideoActivity = useCallback(
    async (activityType: "video_joined" | "video_left", description: string) => {
      if (!private_profile_id) return;

      // Check if current user is a student in this help request
      const isStudentInRequest = allHelpRequestStudents.some(
        (student) => student.help_request_id === request.id && student.profile_id === private_profile_id
      );

      // Only log activity for students who are part of the request
      if (isStudentInRequest) {
        try {
          await createStudentActivity({
            values: {
              student_profile_id: private_profile_id,
              class_id: request.class_id,
              help_request_id: request.id,
              activity_type: activityType,
              activity_description: description
            }
          });
        } catch (error) {
          toaster.error({
            title: "Failed to log activity",
            description: `Failed to log ${activityType} activity: ${error instanceof Error ? error.message : "Unknown error"}`
          });
        }
      }
    },
    [private_profile_id, allHelpRequestStudents, request, createStudentActivity]
  );

  // Helper function to log activity for all students in the request
  const logVideoActivityForAllStudents = useCallback(
    async (activityType: "video_joined" | "video_left", description: string) => {
      const requestStudents = allHelpRequestStudents.filter((student) => student.help_request_id === request.id);

      for (const student of requestStudents) {
        try {
          await createStudentActivity({
            values: {
              student_profile_id: student.profile_id,
              class_id: request.class_id,
              help_request_id: request.id,
              activity_type: activityType,
              activity_description: description
            }
          });
        } catch (error) {
          toaster.error({
            title: "Failed to log activity",
            description: `Failed to log ${activityType} activity for student: ${error instanceof Error ? error.message : "Unknown error"}`
          });
        }
      }
    },
    [allHelpRequestStudents, request, createStudentActivity]
  );

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

      // Log video join activity for the instructor/TA who started the call
      await logVideoActivity("video_joined", "Instructor/TA started and joined video call");

      toaster.success({
        title: "Video call started",
        description: "Video meeting has been initiated for this help request. Please wait for the student(s) to join."
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
  }, [canStartCall, isStartingCall, updateRequest, request, supabase, openMeetingWindow, logVideoActivity]);

  /**
   * Joins an existing video call
   */
  const joinVideoCall = useCallback(async () => {
    setIsJoiningCall(true);
    // Use managed window opening
    openMeetingWindow(request.class_id, request.id, request.help_queue);

    // Log video join activity for the current user
    await logVideoActivity("video_joined", "User joined video call");

    toaster.success({
      title: "Joining video call",
      description: "Opening video meeting window"
    });
    setIsJoiningCall(false);
  }, [request, openMeetingWindow, logVideoActivity]);

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

      // Log video left activity for all students who were in the call
      await logVideoActivityForAllStudents("video_left", "Video call ended by instructor");

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
  }, [isEndingCall, request, supabase, logVideoActivityForAllStudents]);

  const isRequestInactive = request.status === "resolved" || request.status === "closed";
  const currentUserIsInstructorOrGrader = true;

  // Minimal variant - just shows join button when call is live
  if (variant === "minimal") {
    if (!request.is_video_live) return null;

    return (
      <Button
        size={size}
        colorPalette="green"
        onClick={joinVideoCall}
        disabled={isRequestInactive}
        loading={isJoiningCall}
      >
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
            colorPalette="blue"
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
            Join Video Call
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
