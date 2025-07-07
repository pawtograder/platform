import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ChimeSDKMeetings } from "npm:@aws-sdk/client-chime-sdk-meetings";
import { assertUserIsInCourse, NotFoundError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import type { LiveMeetingEndRequest } from "../_shared/FunctionTypes.d.ts";

async function handleRequest(req: Request) {
  const { courseId, helpRequestId } = (await req.json()) as LiveMeetingEndRequest;
  const { enrollment } = await assertUserIsInCourse(courseId, req.headers.get("Authorization")!);

  // Verify user has permission to end meetings (instructors/graders only)
  if (enrollment.role !== "instructor" && enrollment.role !== "grader") {
    throw new Error("Only instructors and graders can end meetings");
  }

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  const { data: helpRequest } = await adminSupabase.from("help_requests").select("*").eq("id", helpRequestId).single();

  if (!helpRequest) {
    throw new NotFoundError("Help request not found");
  }

  // Get the active meeting session
  const { data: activeMeeting } = await adminSupabase
    .from("video_meeting_sessions")
    .select("*")
    .eq("help_request_id", helpRequest.id)
    .is("ended", null)
    .not("chime_meeting_id", "is", null)
    .single();

  if (!activeMeeting) {
    // No active meeting to end, but still update the help request status
    await adminSupabase
      .from("help_requests")
      .update({
        is_video_live: false
      })
      .eq("id", helpRequestId);

    return { message: "No active meeting found for this help request" };
  }

  const chime = new ChimeSDKMeetings({
    region: "us-east-1",
    credentials: {
      accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
      secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!
    }
  });

  let meetingDeleted = false;
  try {
    // Delete the Chime meeting - this will end it for all participants
    await chime.deleteMeeting({
      MeetingId: activeMeeting.chime_meeting_id!
    });
    meetingDeleted = true;
    console.log(`Successfully deleted Chime meeting: ${activeMeeting.chime_meeting_id}`);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "name" in error && error.name === "NotFoundException") {
      console.log(`Chime meeting ${activeMeeting.chime_meeting_id} was already deleted or doesn't exist`);
      meetingDeleted = true; // Consider it "deleted" since it doesn't exist
    } else {
      console.error("Error deleting meeting:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
      throw new Error(`Failed to delete meeting: ${errorMessage}`);
    }
  }

  // Update the video meeting session and help request in the database
  await adminSupabase
    .from("video_meeting_sessions")
    .update({
      ended: new Date().toISOString()
    })
    .eq("id", activeMeeting.id);

  await adminSupabase
    .from("help_requests")
    .update({
      is_video_live: false
    })
    .eq("id", helpRequestId);

  return {
    message: meetingDeleted
      ? "Meeting ended successfully for all participants"
      : "Meeting session cleaned up (meeting was already ended)"
  };
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
