"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Insert mutation for lab_section_meetings.
 */
export function useLabSectionMeetingInsert() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "lab_section_meetings",
    queryKey: ["course", courseId, "lab_section_meetings"],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for lab_section_meetings.
 */
export function useLabSectionMeetingUpdate() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "lab_section_meetings",
    queryKey: ["course", courseId, "lab_section_meetings"],
    mutationType: "update",
    supabase
  });
}

/**
 * Delete mutation for lab_section_meetings.
 */
export function useLabSectionMeetingDelete() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "lab_section_meetings",
    queryKey: ["course", courseId, "lab_section_meetings"],
    mutationType: "delete",
    supabase
  });
}
