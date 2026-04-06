"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Insert mutation for help_request_messages.
 *
 * The query key includes `helpRequestId` so the optimistic update and
 * invalidation target the correct per-request cache entry created by
 * `useHelpRequestMessagesQuery(helpRequestId)`.
 */
export function useHelpRequestMessageInsert(helpRequestId: number) {
  const { classId, supabase } = useOfficeHoursDataContext();
  return useSupabaseRealtimeMutation({
    table: "help_request_messages",
    queryKey: ["office_hours", classId, "help_request_messages", helpRequestId],
    mutationType: "insert",
    supabase
  });
}
