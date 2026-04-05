"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useCourseDataContext } from "./useCourseDataContext";

/**
 * Insert mutation for lab_sections.
 * Optimistically adds a row and invalidates the cache on settle.
 */
export function useLabSectionInsert() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "lab_sections",
    queryKey: ["course", courseId, "lab_sections"],
    mutationType: "insert",
    supabase
  });
}

/**
 * Update mutation for lab_sections.
 */
export function useLabSectionUpdate() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "lab_sections",
    queryKey: ["course", courseId, "lab_sections"],
    mutationType: "update",
    supabase
  });
}

/**
 * Delete mutation for lab_sections.
 */
export function useLabSectionDelete() {
  const { courseId, supabase } = useCourseDataContext();
  return useSupabaseRealtimeMutation({
    table: "lab_sections",
    queryKey: ["course", courseId, "lab_sections"],
    mutationType: "delete",
    supabase
  });
}
