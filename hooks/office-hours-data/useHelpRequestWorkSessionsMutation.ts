"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Delete mutation for help_request_work_sessions.
 */
export function useHelpRequestWorkSessionDelete() {
  const { classId, supabase } = useOfficeHoursDataContext();
  return useSupabaseRealtimeMutation({
    table: "help_request_work_sessions",
    queryKey: ["office_hours", classId, "help_request_work_sessions"],
    mutationType: "delete",
    supabase
  });
}
