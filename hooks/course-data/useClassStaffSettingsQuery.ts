"use client";

import { useSupabaseRealtimeQuery } from "@/hooks/useSupabaseRealtimeQuery";
import { useCourseDataContext } from "./useCourseDataContext";
import type { Database } from "@/utils/supabase/SupabaseTypes";

type ClassStaffSetting = Database["public"]["Tables"]["class_staff_settings"]["Row"];

/**
 * Fetches staff settings for the current course with cross-tab realtime sync.
 * Staff-only (enforced by RLS).
 * Replaces: CourseController.classStaffSettings
 */
export function useClassStaffSettingsQuery() {
  const { courseId, supabase, classRtc, isStaff } = useCourseDataContext();

  return useSupabaseRealtimeQuery<"class_staff_settings", ClassStaffSetting>({
    queryKey: ["course", courseId, "class_staff_settings"],
    table: "class_staff_settings",
    queryFn: () => supabase.from("class_staff_settings").select("*").eq("class_id", courseId),
    classRtc,
    supabase,
    scope: "class",
    enabled: isStaff,
    realtimeFilter: (row) => (row as Record<string, unknown>).class_id === courseId
  });
}
