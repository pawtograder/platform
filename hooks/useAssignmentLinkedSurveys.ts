"use client";

import { useEffect, useMemo, useState } from "react";

import { getStudentFacingErrorMessage } from "@/lib/studentFacingErrorMessages";
import type { Survey } from "@/types/survey";
import { createClient } from "@/utils/supabase/client";

/** The columns the survey tab gate needs — not the whole survey row (`json` is large). */
export type LinkedSurveySummary = Pick<Survey, "id" | "title" | "status" | "available_at" | "due_date">;

export type UseAssignmentLinkedSurveysResult = {
  surveys: LinkedSurveySummary[];
  loading: boolean;
  error: string | null;
};

/**
 * Surveys linked to an assignment (`surveys.assignment_id`) that a student could be
 * expected to answer: not deleted, and published or closed rather than draft.
 *
 * RLS already limits the rows to surveys the viewer may see, so staff and students run
 * the same query. Do not add a role filter here — it would duplicate the policy and
 * drift from it.
 *
 * This powers the tab gate on the submission view. The survey panel itself calls
 * `get_survey_responses_for_submission`, which returns the survey JSON and the roster.
 */
export function useAssignmentLinkedSurveys(assignmentId: number | null | undefined): UseAssignmentLinkedSurveysResult {
  const supabase = useMemo(() => createClient(), []);
  const [surveys, setSurveys] = useState<LinkedSurveySummary[]>([]);
  const [loading, setLoading] = useState(assignmentId != null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (assignmentId == null) {
      setSurveys([]);
      setLoading(false);
      setError(null);
      return;
    }
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      const { data, error: queryError } = await supabase
        .from("surveys")
        .select("id,title,status,available_at,due_date")
        .eq("assignment_id", assignmentId)
        .is("deleted_at", null)
        .in("status", ["published", "closed"]);
      if (!mounted) {
        return;
      }
      if (queryError) {
        setError(getStudentFacingErrorMessage(queryError));
        setSurveys([]);
      } else {
        setSurveys(data ?? []);
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [supabase, assignmentId]);

  return { surveys, loading, error };
}
