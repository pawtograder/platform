"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type DiscordChannel = Database["public"]["Tables"]["discord_channels"]["Row"];

/**
 * Fetches Discord channels for the current course with cross-tab realtime sync.
 * Staff-only (enforced by RLS).
 * Replaces: CourseController.discordChannels
 */
export function useDiscordChannelsQuery() {
  const { courseId, supabase, classRtc, isStaff, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"discord_channels", DiscordChannel>({
    queryKey: ["course", courseId, "discord_channels"],
    table: "discord_channels",
    queryFn: () => supabase.from("discord_channels").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class",
    enabled: isStaff,
    realtimeFilter: (row) => (row as Record<string, unknown>).class_id === courseId,
    initialData: initialData?.discordChannels
  });
}
