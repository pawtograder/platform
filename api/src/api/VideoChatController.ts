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
        networkType: string;
        externalMeetingId: string;
        mediaRegion: string;
        transitionReason: string;
        attendeeCount: number;
    };
};

@Route("/api/help-queue/")
export class VideoChatController {
    async processSNSMessage(message: ChimeSNSMessage): Promise<void> {
        console.log(JSON.stringify(message, null, 2));
        if (message.detail.eventType === "chime:AttendeeLeft") {
            const remainingAttendees = message.detail.attendeeCount;
            if (remainingAttendees === 0) {
                const chime = new ChimeSDKMeetings({
                    region: "us-east-1",
                });
                await chime.deleteMeeting({
                    MeetingId: message.detail.meetingId,
                });
            }
        } else if (message.detail.eventType === "chime:MeetingEnded") {
            //format: `video-meeting-session-${newSession.class_id}-${newSession.help_request_id}-${newSession.id}`,
            const match = message.detail.externalMeetingId.match(
                /video-meeting-session-(.*)-(.*)-(.*)/,
            );
            if (!match) {
                throw new Error("Invalid external meeting ID");
            }
            const sessionID = parseInt(match[3]);
            const helpRequestID = parseInt(match[2]);
            await supabase.from("video_meeting_sessions").update({
                ended: new Date().toISOString(),
            }).eq("id", sessionID);
            await supabase.from("help_requests").update({
                is_video_live: false,
            }).eq("id", helpRequestID);
        } else if (message.detail.eventType === "chime:MeetingStarted") {
            const match = message.detail.externalMeetingId.match(
                /video-meeting-session-(.*)-(.*)-(.*)/,
            );
            if (!match) {
                throw new Error("Invalid external meeting ID");
            }
            await supabase.from("help_requests").update({
                is_video_live: true,
            }).eq("id", parseInt(match[2]));
        }
    }
    async getActiveMeeting(
        helpRequest: HelpRequest,
    ): Promise<VideoMeetingSession> {
        const activeMeeting = await supabase.from("video_meeting_sessions")
            .select("*").eq(
                "help_request_id",
                helpRequest.id,
            )
            .is("ended", null)
            .not("chime_meeting_id", "is", null).single();
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
                ExternalMeetingId:
                    `video-meeting-session-${newSession.class_id}-${newSession.help_request_id}-${newSession.id}`,
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
