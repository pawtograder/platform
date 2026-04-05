"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Insert mutation for lab_section_leaders.
 */
export function useLabSectionLeaderInsert() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "lab_section_leaders",
    queryKey: ["course", courseId, "lab_section_leaders"],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for lab_section_leaders.
 */
export function useLabSectionLeaderUpdate() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "lab_section_leaders",
    queryKey: ["course", courseId, "lab_section_leaders"],
    mutationType: "update",
    supabase
  });
}

/**
 * Delete mutation for lab_section_leaders.
 */
export function useLabSectionLeaderDelete() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "lab_section_leaders",
    queryKey: ["course", courseId, "lab_section_leaders"],
    mutationType: "delete",
    supabase
  });
}
