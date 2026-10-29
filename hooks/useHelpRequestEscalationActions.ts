"use client";

import { toaster } from "@/components/ui/toaster";
import { useOfficeHoursController } from "@/hooks/useOfficeHoursRealtime";
import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import { createClient } from "@/utils/supabase/client";
import { useCallback, useMemo } from "react";

/**
 * Calls the escalation RPCs (20261029120000_help_request_escalation.sql). Each call refetches the
 * request afterwards so the acting user sees the change before the realtime broadcast arrives.
 * Returns true on success; failures are reported with a toast.
 */
export function useHelpRequestEscalationActions() {
  const controller = useOfficeHoursController();

  const run = useCallback(
    async (requestId: number, call: () => PromiseLike<{ error: unknown }>, failureTitle: string) => {
      const { error } = await call();
      if (error) {
        toaster.error({ title: failureTitle, description: getStudentFacingErrorMessage(error) });
        return false;
      }
      await controller.helpRequests.refetchByIds([requestId]);
      return true;
    },
    [controller]
  );

  return useMemo(() => {
    const supabase = createClient();
    return {
      /** Assigned staff member hands the ticket back to the queue, flagged, mid-help. */
      escalate: (requestId: number, note: string) =>
        run(
          requestId,
          () => supabase.rpc("escalate_help_request", { p_help_request_id: requestId, p_note: note }),
          "Could not escalate request"
        ),
      /** Staff Resolve (student gets a check-in) or End ticket (final, no more escalations). */
      finish: (requestId: number, endTicket: boolean) =>
        run(
          requestId,
          () => supabase.rpc("finish_help_request", { p_help_request_id: requestId, p_end_ticket: endTicket }),
          endTicket ? "Could not end ticket" : "Could not resolve request"
        ),
      /** Student's answer to "Did your problem get fixed?". A note is required when it was not. */
      answerCheckIn: (requestId: number, fixed: boolean, note?: string) =>
        run(
          requestId,
          () =>
            supabase.rpc("answer_help_request_check_in", {
              p_help_request_id: requestId,
              p_fixed: fixed,
              p_note: note
            }),
          fixed ? "Could not close your request" : "Could not escalate your request"
        )
    };
  }, [run]);
}
