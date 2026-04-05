"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

/** Row type alias to avoid collision with the browser Notification API. */
type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];

/**
 * Fetches and subscribes to notifications for the current user in the current course.
 * User-scoped — no SSR initialData.
 */
export function useNotificationsQuery() {
  const { courseId, userId, supabase, classRtc } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"notifications", NotificationRow>({
    queryKey: ["course", courseId, "notifications", userId],
    table: "notifications",
    queryFn: () => supabase.from("notifications").select("*").eq("class_id", courseId).eq("user_id", userId),
    classRtc,
    supabase,
    scope: "class"
    // No initialData — user-specific, not available from SSR
  });
}
