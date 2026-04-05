"use client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Fetches all video meeting sessions for the current class.
 * Replaces: OfficeHoursController.videoMeetingSessions
 */
export function useVideoMeetingSessionsQuery() {
  const { classId, supabase, classRtc } = useOfficeHoursDataContext();

  return useSupabaseRealtimeQuery<"video_meeting_sessions">({
    queryKey: ["office_hours", classId, "video_meeting_sessions"],
    table: "video_meeting_sessions",
    queryFn: () => supabase.from("video_meeting_sessions").select("*").eq("class_id", classId),
    classRtc,
    supabase,
    scope: "scoped",
    realtimeFilter: (row) => row.class_id === classId
  });
}
