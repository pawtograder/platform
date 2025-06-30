import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { ChimeSDKMeetings, CreateMeetingCommandOutput } from "npm:@aws-sdk/client-chime-sdk-meetings";
import * as chimeUtils from "../_shared/ChimeWrapper.ts";
import { assertUserIsInCourse, NotFoundError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { LiveMeetingForHelpRequestRequest } from "../_shared/FunctionTypes.d.ts";

async function handleRequest(req: Request) {
  const { courseId, helpRequestId } = (await req.json()) as LiveMeetingForHelpRequestRequest;
  const { supabase, enrollment } = await assertUserIsInCourse(courseId, req.headers.get("Authorization")!);
  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("User not found");
  }
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
    // Try to re-recreate the meeting
    await supabase
      .from("video_meeting_sessions")
      .update({
        ended: new Date().toISOString()
      })
      .eq("id", activeMeeting.id);
    Meeting = await chime.getMeeting({
      MeetingId: (await chimeUtils.getActiveMeeting(helpRequest)).chime_meeting_id!
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
