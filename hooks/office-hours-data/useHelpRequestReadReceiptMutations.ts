"use client";

import { useSupabaseRealtimeMutation } from "@/hooks/useSupabaseRealtimeMutation";
import { useOfficeHoursDataContext } from "./useOfficeHoursDataContext";

/**
 * Insert mutation for help_request_message_read_receipts.
 *
 * The query key includes `helpRequestId` so the optimistic update and
 * invalidation target the correct per-request cache entry created by
 * `useHelpRequestReadReceiptsQuery(helpRequestId)`.
 */
export function useHelpRequestReadReceiptInsert(helpRequestId: number) {
  const { classId, supabase } = useOfficeHoursDataContext();
  return useSupabaseRealtimeMutation({
    table: "help_request_message_read_receipts",
    queryKey: ["office_hours", classId, "help_request_message_read_receipts", helpRequestId],
    mutationType: "insert",
    supabase
  });
}
