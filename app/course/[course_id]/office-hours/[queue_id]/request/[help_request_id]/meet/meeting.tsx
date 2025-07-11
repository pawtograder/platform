import Roster from "@/components/videocall/roster";
import VideoGrid from "@/components/videocall/videogrid";
import useUserProfiles from "@/hooks/useUserProfiles";
import MeetingControls from "@/lib/aws-chime-sdk-meeting/containers/MeetingControls";
import { NavigationProvider } from "@/lib/aws-chime-sdk-meeting/providers/NavigationProvider";
import { VideoTileGridProvider } from "@/lib/aws-chime-sdk-meeting/providers/VideoTileGridProvider";
import {
  BackgroundBlurProvider,
  BackgroundReplacementProvider,
  GlobalStyles,
  MeetingProvider,
  UserActivityProvider,
  VoiceFocusProvider,
  lightTheme,
  useMeetingManager
} from "amazon-chime-sdk-component-library-react";
import { MeetingSessionConfiguration } from "amazon-chime-sdk-js";
import { useEffect, useRef } from "react";
import { StyleSheetManager, ThemeProvider } from "styled-components";
import { useParams } from "next/navigation";
import { liveMeetingForHelpRequest } from "@/lib/edgeFunctions";
import { createClient } from "@/utils/supabase/client";
import type { HelpRequest } from "@/utils/supabase/DatabaseTypes";
const MeetingProviderWrapper = ({ children }: { children: React.ReactNode }) => {
  return (
    <ThemeProvider theme={lightTheme}>
      <GlobalStyles />
      <MeetingProvider>
        <StyleSheetManager>
          <NavigationProvider>
            <VoiceFocusProvider>
              <BackgroundBlurProvider options={{ filterCPUUtilization: 0 }}>
                <BackgroundReplacementProvider>
                  <VideoTileGridProvider>
                    <UserActivityProvider>{children}</UserActivityProvider>
                  </VideoTileGridProvider>
                </BackgroundReplacementProvider>
              </BackgroundBlurProvider>
            </VoiceFocusProvider>
          </NavigationProvider>
        </StyleSheetManager>
      </MeetingProvider>
    </ThemeProvider>
  );
};

function HelpMeeting() {
  const meetingManager = useMeetingManager();
  const { users } = useUserProfiles();
  const { help_request_id, course_id } = useParams();
  const supabase = createClient();

  useEffect(() => {
    meetingManager.getAttendee = async (chimeAttendeeId: string, externalUserId?: string) => {
      const user = users.find((user) => user.id === externalUserId);
      if (!user) {
        throw new Error("User not found");
      }
      return { chimeAttendeeId, externalUserId, name: user.name! };
    };
  }, [users, meetingManager]);

  const initialized = useRef(false);

  // Set up real-time subscription to detect when meeting ends externally
  useEffect(() => {
    if (!help_request_id) return;

    const channel = supabase
      .channel("meeting-end-detection")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "help_requests",
          filter: `id=eq.${help_request_id}`
        },
        (payload) => {
          const updatedRequest = payload.new as HelpRequest;

          // If the meeting is no longer live, close this window
          if (!updatedRequest.is_video_live) {
            window.close();
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [help_request_id, supabase]);

  useEffect(() => {
    const joinMeeting = async () => {
      // Fetch the meeting and attendee data from your server application
      const supabase = createClient();
      const { Meeting, Attendee } = await liveMeetingForHelpRequest(
        { courseId: parseInt(course_id as string), helpRequestId: parseInt(help_request_id as string) },
        supabase
      );
      const meetingSessionConfiguration = new MeetingSessionConfiguration(Meeting, Attendee);
      await meetingManager.join(meetingSessionConfiguration);

      // At this point you could let users setup their devices, or by default
      // the SDK will select the first device in the list for the kind indicated
      // by `deviceLabels` (the default value is DeviceLabels.AudioAndVideo)
      // ...

      // Start the `MeetingSession` to join the meeting
      await meetingManager.start();
    };
    if (!initialized.current) {
      initialized.current = true;
      joinMeeting().catch(console.error);
    }
    return () => {
      meetingManager.leave();
    };
  }, [meetingManager, course_id, help_request_id]);
  return (
    <>
      <Roster />
      <VideoGrid />
      <MeetingControls />
      {/* <Controls /> */}
    </>
  );
}

export default function MeetingWrapper() {
  return (
    <>
      <MeetingProviderWrapper>
        <HelpMeeting />
      </MeetingProviderWrapper>
    </>
  );
}
