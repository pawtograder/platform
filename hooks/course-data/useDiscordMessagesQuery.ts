"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type DiscordMessage = Database["public"]["Tables"]["discord_messages"]["Row"];

/**
 * Fetches Discord messages for the current course with cross-tab realtime sync.
 * Staff-only (enforced by RLS).
 * Replaces: CourseController.discordMessages
 */
export function useDiscordMessagesQuery() {
  const { courseId, supabase, classRtc, isStaff, initialData } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"discord_messages", DiscordMessage>({
    queryKey: ["course", courseId, "discord_messages"],
    table: "discord_messages",
    queryFn: () => supabase.from("discord_messages").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class",
    enabled: isStaff,
    realtimeFilter: (row) => (row as Record<string, unknown>).class_id === courseId,
    initialData: initialData?.discordMessages
  });
}
