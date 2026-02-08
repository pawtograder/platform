import { ChimeSDKMeetings } from "npm:@aws-sdk/client-chime-sdk-meetings";
import { Database } from "./SupabaseTypes.d.ts";
// import { jwtDecode } from "npm:jwt-decode"; // Currently unused
import { UserVisibleError } from "./HandlerUtils.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

function uuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0,
      v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
// type JoinMeetingResponse = { // Currently unused
//   Meeting: CreateMeetingCommandOutput;
//   Attendee: CreateAttendeeCommandOutput;
// };

type VideoMeetingSession = Database["public"]["Tables"]["video_meeting_sessions"]["Row"];
type HelpRequest = Database["public"]["Tables"]["help_requests"]["Row"];

export type ChimeSNSMessage = {
  id: string;
  version: string;
  "detail-type": string;
  source: string;
  account: string;
  time: string;
  region: string;
  resources: string[];
  detail: {
    version: string;
    eventType: string;
    meetingId: string;
    attendeeId: string;
    externalUserId?: string; // This contains the private_profile_id
    networkType: string;
    externalMeetingId: string;
    mediaRegion: string;
    transitionReason: string;
    attendeeCount: number;
  };
};

export async function processSNSMessage(message: ChimeSNSMessage, scope?: Sentry.Scope): Promise<void> {
  scope?.setTag("chime_operation", "process_sns_message");
  scope?.setTag("chime_event_type", message.detail.eventType);
  scope?.setTag("chime_meeting_id", message.detail.meetingId);
  scope?.setTag("chime_attendee_count", message.detail.attendeeCount.toString());

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  if (message.detail.eventType === "chime:AttendeeJoined") {
    // Track user joining the meeting
    await handleAttendeeJoined(message, adminSupabase, scope);
  } else if (message.detail.eventType === "chime:AttendeeLeft") {
    // Track user leaving the meeting
    await handleAttendeeLeft(message, adminSupabase, scope);

    const remainingAttendees = message.detail.attendeeCount;
    if (remainingAttendees === 0) {
      const chime = new ChimeSDKMeetings({
        region: "us-east-1"
      });
      await chime.deleteMeeting({
        MeetingId: message.detail.meetingId
      });
    }
  } else if (message.detail.eventType === "chime:MeetingEnded") {
    //format: `video-meeting-session-${newSession.class_id}-${newSession.help_request_id}-${newSession.id}`,
    const match = message.detail.externalMeetingId.match(/video-meeting-session-(.*)-(.*)-(.*)/);
    if (!match) {
      throw new Error("Invalid external meeting ID");
    }
    const sessionID = parseInt(match[3]);
    const helpRequestID = parseInt(match[2]);
    await adminSupabase
      .from("video_meeting_sessions")
      .update({
        ended: new Date().toISOString()
      })
      .eq("id", sessionID);
    await adminSupabase
      .from("help_requests")
      .update({
        is_video_live: false
      })
      .eq("id", helpRequestID);
  } else if (message.detail.eventType === "chime:MeetingStarted") {
    const match = message.detail.externalMeetingId.match(/video-meeting-session-(.*)-(.*)-(.*)/);
    if (!match) {
      throw new Error("Invalid external meeting ID");
    }
    await adminSupabase
      .from("help_requests")
      .update({
        is_video_live: true
      })
      .eq("id", parseInt(match[2]));
  }
}

async function handleAttendeeJoined(
  message: ChimeSNSMessage,
  adminSupabase: SupabaseClient<Database>,
  scope?: Sentry.Scope
): Promise<void> {
  scope?.setTag("chime_operation", "handle_attendee_joined");
  scope?.setTag("chime_attendee_id", message.detail.attendeeId);
  scope?.setTag("chime_external_user_id", message.detail.externalUserId);

  try {
    // Parse the external meeting ID to get session info
    const match = message.detail.externalMeetingId.match(/video-meeting-session-(.*)-(.*)-(.*)/);
    if (!match) {
      console.error("Invalid external meeting ID for attendee joined:", message.detail.externalMeetingId);
      return;
    }

    const classId = parseInt(match[1]);
    const helpRequestId = parseInt(match[2]);
    const sessionId = parseInt(match[3]);

    // Get the private_profile_id from the externalUserId
    const privateProfileId = message.detail.externalUserId;
    if (!privateProfileId) {
      console.error("Missing externalUserId in attendee joined event");
      return;
    }

    // Record the user joining the meeting (upsert to handle reconnections)
    const { error: insertError } = await adminSupabase.from("video_meeting_session_users").upsert(
      {
        video_meeting_session_id: sessionId,
        class_id: classId,
        private_profile_id: privateProfileId,
        chime_attendee_id: message.detail.attendeeId,
        joined_at: new Date().toISOString(),
        left_at: null // Reset left_at on rejoin
      },
      {
        onConflict: "video_meeting_session_id,chime_attendee_id",
        ignoreDuplicates: false
      }
    );

    if (insertError) {
      console.error("Failed to record user joined meeting:", insertError);
      Sentry.captureException(insertError, scope);
    } else {
      console.log(`Recorded user ${privateProfileId} joined meeting session ${sessionId}`);
    }
  } catch (error) {
    console.error("Error handling attendee joined:", error);
    Sentry.captureException(error, scope);
  }
}

async function handleAttendeeLeft(
  message: ChimeSNSMessage,
  adminSupabase: SupabaseClient<Database>,
  scope?: Sentry.Scope
): Promise<void> {
  scope?.setTag("chime_operation", "handle_attendee_left");
  scope?.setTag("chime_attendee_id", message.detail.attendeeId);

  try {
    // Parse the external meeting ID to get session info
    const match = message.detail.externalMeetingId.match(/video-meeting-session-(.*)-(.*)-(.*)/);
    if (!match) {
      console.error("Invalid external meeting ID for attendee left:", message.detail.externalMeetingId);
      return;
    }

    const sessionId = parseInt(match[3]);

    // Update the left_at timestamp for this attendee
    const { error: updateError } = await adminSupabase
      .from("video_meeting_session_users")
      .update({
        left_at: new Date().toISOString()
      })
      .eq("video_meeting_session_id", sessionId)
      .eq("chime_attendee_id", message.detail.attendeeId)
      .is("left_at", null); // Only update if they haven't already left

    if (updateError) {
      console.error("Failed to update attendee left time:", updateError);
      Sentry.captureException(updateError, scope);
    } else {
      console.log(`Attendee ${message.detail.attendeeId} left meeting session ${sessionId}`);
    }
  } catch (error) {
    console.error("Error handling attendee left:", error);
    Sentry.captureException(error, scope);
  }
}
export async function getActiveMeeting(helpRequest: HelpRequest, scope?: Sentry.Scope): Promise<VideoMeetingSession> {
  scope?.setTag("chime_operation", "get_active_meeting");
  scope?.setTag("help_request_id", helpRequest.id.toString());
  scope?.setTag("class_id", helpRequest.class_id.toString());

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const activeMeeting = await adminSupabase
    .from("video_meeting_sessions")
    .select("*")
    .eq("help_request_id", helpRequest.id)
    .is("ended", null)
    .not("chime_meeting_id", "is", null)
    .single();
  if (!activeMeeting.data) {
    // Create new video meeting session record
    //TODO: This could race for two users trying to join the meeting concurrently
    // Fix it by creating a unique constraint on help_request_id and meeting_id
    // If it races, the second insert will get an error, which should assume that the other
    // user has already created the meeting, and after a short delay, get the meeting from supabase

    const { data: newSession, error: sessionError } = await adminSupabase
      .from("video_meeting_sessions")
      .insert({
        help_request_id: helpRequest.id,
        class_id: helpRequest.class_id,
        started: new Date().toISOString()
      })
      .select()
      .single();

    if (sessionError || !newSession) {
      throw new UserVisibleError("Failed to create video meeting session" + sessionError?.message);
    }

    const chime = new ChimeSDKMeetings({
      region: "us-east-1",
      credentials: {
        accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
        secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!
      }
    });
    const newMeeting = await chime.createMeeting({
      ClientRequestToken: uuid(),
      MediaRegion: "us-east-1",
      ExternalMeetingId: `video-meeting-session-${newSession.class_id}-${newSession.help_request_id}-${newSession.id}`,
      NotificationsConfiguration: {
        SqsQueueArn: Deno.env.get("AWS_CHIME_SQS_QUEUE_ARN")!
      }
    });
    if (!newMeeting) {
      throw new Error("Chime SDK Meeting Creation Failed");
    }
    //Enable transcription
    // await chime.startMeetingTranscription({
    //     MeetingId: newMeeting.Meeting?.MeetingId!,
    //     TranscriptionConfiguration: {
    //         EngineTranscribeSettings: {
    //             Region: "us-east-1",
    //             LanguageCode: "en-US",
    //         },
    //     },
    // });
    //Update the video meeting session with the meeting id
    const { error: updateError } = await adminSupabase
      .from("video_meeting_sessions")
      .update({
        chime_meeting_id: newMeeting.Meeting?.MeetingId
      })
      .eq("id", newSession.id);
    if (updateError) {
      throw new UserVisibleError("Video Meeting Session Update Failed" + updateError?.message);
    }
    newSession.chime_meeting_id = newMeeting.Meeting?.MeetingId || null; //MUST be string or null
    return newSession;
  } else {
    return activeMeeting.data;
  }
}
