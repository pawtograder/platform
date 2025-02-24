import {
    ChimeSDKMeetings,
    CreateAttendeeCommandOutput,
    CreateMeetingCommandOutput,
} from "@aws-sdk/client-chime-sdk-meetings";
import { createClient, User } from "@supabase/supabase-js";
import {
    Body,
    Controller,
    Get,
    Header,
    Path,
    Post,
    Request,
    Security,
} from "tsoa";
import { Route } from "tsoa";
import { Database } from "../SupabaseTypes.js";
import { jwtDecode } from "jwt-decode";
import { JWTUserRoles } from "./AdminServiceController.js";
import * as express from "express";
import { UserVisibleError } from "../InternalTypes.js";
function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
        /[xy]/g,
        function (c) {
            const r = (Math.random() * 16) | 0,
                v = c === "x" ? r : (r & 0x3) | 0x8;
            return v.toString(16);
        },
    );
}
const supabase = createClient<Database>(
    process.env.SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_ROLE_KEY || "",
);

type JoinMeetingResponse = {
    Meeting: CreateMeetingCommandOutput;
    Attendee: CreateAttendeeCommandOutput;
};

type VideoMeetingSession =
    Database["public"]["Tables"]["video_meeting_sessions"]["Row"];
type HelpRequest = Database["public"]["Tables"]["help_requests"]["Row"];

@Route("/api/help-queue/")
export class VideoChatController {
    async getActiveMeeting(
        helpRequest: HelpRequest,
    ): Promise<VideoMeetingSession> {
        const activeMeeting = await supabase.from("video_meeting_sessions")
            .select("*").eq(
                "help_request_id",
                helpRequest.id,
            ).
            is("ended", null).
            not("chime_meeting_id", "is", null).single();
        if (!activeMeeting.data) {
            // Create new video meeting session record
            //TODO: This could race for two users trying to join the meeting concurrently
            // Fix it by creating a unique constraint on help_request_id and meeting_id
            // If it races, the second insert will get an error, which should assume that the other
            // user has already created the meeting, and after a short delay, get the meeting from supabase

            const { data: newSession, error: sessionError } = await supabase
                .from("video_meeting_sessions")
                .insert({
                    help_request_id: helpRequest.id,
                    class_id: helpRequest.class_id,
                    started: new Date().toISOString(),
                })
                .select()
                .single();

            if (sessionError || !newSession) {
                throw new UserVisibleError(
                    "Failed to create video meeting session" +
                        sessionError?.message,
                );
            }

            console.log(process.env.AWS_ACCESS_KEY_ID!, process.env.AWS_SECRET_ACCESS_KEY!);
            console.log(process.env.CHIME_SNS_TOPIC_ARN);
            const chime = new ChimeSDKMeetings({
                region: "us-east-1",
                credentials: {
                    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
                    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
                },
            });
            const newMeeting = await chime.createMeeting({
                ClientRequestToken: uuid(),
                MediaRegion: "us-east-1",
                NotificationsConfiguration: {
                    SnsTopicArn: process.env.CHIME_SNS_TOPIC_ARN,
                },
                ExternalMeetingId:
                    `video-meeting-session-${newSession.class_id}-${newSession.id}`,
            });
            if (!newMeeting) {
                throw new Error("Chime SDK Meeting Creation Failed");
            }
            //Enable transcription
            await chime.startMeetingTranscription({
                MeetingId: newMeeting.Meeting?.MeetingId!,
                TranscriptionConfiguration: {
                    EngineTranscribeSettings: {
                        Region: "us-east-1",
                    },
                },
            });
            //Update the video meeting session with the meeting id
            const { error: updateError } = await supabase.from(
                "video_meeting_sessions",
            ).update({
                chime_meeting_id: newMeeting.Meeting?.MeetingId,
            }).eq("id", newSession.id);
            if (updateError) {
                throw new UserVisibleError(
                    "Video Meeting Session Update Failed" +
                        updateError?.message,
                );
            }
            newSession.chime_meeting_id = newMeeting.Meeting?.MeetingId!;
            return newSession;
        } else {
            return activeMeeting.data;
        }
    }

    @Security("supabase")
    @Get("/help-request/:requestId")
    async getMeeting(
        @Request() request: express.Request,
        @Path() requestId: number,
    ): Promise<JoinMeetingResponse> {
        console.log("Getting meeting for requestId", requestId);
        const helpRequest = await supabase.from("help_requests").select(
            "*, help_queues(*), video_meeting_sessions(*)",
        ).eq(
            "id",
            requestId,
        ).single();
        if (!helpRequest.data) {
            throw new Error("Help request not found");
        }
        const { user_roles } = jwtDecode(
            request.headers["authorization"] as string,
        ) as { user_roles: JWTUserRoles[] };
        if (
            !user_roles.find((role) =>
                role.role === "admin" ||
                role.class_id === helpRequest.data.class_id
            )
        ) {
            throw new Error("User is not part of class");
        }

        const user = (request as any).user.user as User;

        const chime = new ChimeSDKMeetings({
            region: "us-east-1",
        });

        let Meeting: CreateMeetingCommandOutput | null = null;
        const activeMeeting = await this.getActiveMeeting(helpRequest.data);
        try {
            Meeting = await chime.getMeeting({
                MeetingId: activeMeeting.chime_meeting_id!,
            });
        } catch (error) {
            // Try to re-recreate the meeting
            await supabase.from("video_meeting_sessions").update({
                ended: new Date().toISOString(),
            }).eq("id", activeMeeting.id);
            Meeting = await chime.getMeeting({
                MeetingId: (await this.getActiveMeeting(helpRequest.data))
                    .chime_meeting_id!,
            });
        }
        if (!Meeting) {
            throw new Error("Chime SDK Meeting Not Found");
        }
        const Attendee = await chime.createAttendee({
            MeetingId: Meeting.Meeting?.MeetingId,
            ExternalUserId: user.id,
            Capabilities: {
                Audio: "SendReceive",
                Video: "SendReceive",
                Content: "SendReceive",
            },
        });

        return {
            Meeting,
            Attendee,
        };
    }
}
