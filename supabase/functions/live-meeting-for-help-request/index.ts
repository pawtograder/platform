import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

import { ChimeSDKMeetings, CreateMeetingCommandOutput } from "npm:@aws-sdk/client-chime-sdk-meetings";
import * as chimeUtils from "../_shared/ChimeWrapper.ts";
import { assertUserIsInCourse, NotFoundError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { LiveMeetingForHelpRequestRequest } from "../_shared/FunctionTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { courseId, helpRequestId } = (await req.json()) as LiveMeetingForHelpRequestRequest;
  scope?.setTag("function", "live-meeting-for-help-request");
  scope?.setTag("courseId", courseId.toString());
  scope?.setTag("helpRequestId", helpRequestId.toString());
  const { enrollment } = await assertUserIsInCourse(courseId, req.headers.get("Authorization")!);
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data: helpRequest } = await adminSupabase.from("help_requests").select("*").eq("id", helpRequestId).single();
  if (!helpRequest) {
    throw new NotFoundError("Help request not found");
  }
  const chime = new ChimeSDKMeetings({
    region: "us-east-1"
  });

  let Meeting: CreateMeetingCommandOutput | null = null;
  const activeMeeting = await chimeUtils.getActiveMeeting(helpRequest);
  try {
    Meeting = await chime.getMeeting({
      MeetingId: activeMeeting.chime_meeting_id!
    });
  } catch (error) {
    console.log("Chime meeting not found, marking session as ended and creating new one:", error);
    // Mark the current session as ended since the Chime meeting no longer exists
    await adminSupabase
      .from("video_meeting_sessions")
      .update({
        ended: new Date().toISOString()
      })
      .eq("id", activeMeeting.id);

    // Get a new active meeting (this will create a new session)
    const newActiveMeeting = await chimeUtils.getActiveMeeting(helpRequest);
    Meeting = await chime.getMeeting({
      MeetingId: newActiveMeeting.chime_meeting_id!
    });
  }
  if (!Meeting) {
    throw new Error("Chime SDK Meeting Not Found");
  }
  const Attendee = await chime.createAttendee({
    MeetingId: Meeting.Meeting?.MeetingId,
    ExternalUserId: enrollment.private_profile_id,
    Capabilities: {
      Audio: "SendReceive",
      Video: "SendReceive",
      Content: "SendReceive"
    }
  });

  return {
    Meeting,
    Attendee
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
