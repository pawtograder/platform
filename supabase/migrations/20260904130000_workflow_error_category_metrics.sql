-- Bounded replacement for metrics_workflow_errors_by_name.
--
-- WHY: web_workflow_errors_recent carried workflow_run_error.name as a
-- Prometheus label. That column is FREE TEXT — it is the student-visible
-- sentence, capped only at 500 characters by workflow_run_error_name_length
-- (20250801174131), and several producers embed a commit sha in it
-- (supabase/functions/_shared/tooLargeErrorName.ts,
--  github-repo-webhook/index.ts recordRejectedPush). Every oversized or
-- late push therefore mints a brand-new label value.
--
-- The old LIMIT 200 did NOT bound that. It caps the rows returned by ONE call,
-- not the label domain over time: refreshWorkflowMetrics() resets the gauge and
-- may pick a different top-200 on every pass, while Prometheus retains every
-- series it has ever seen. An error storm with distinct messages churned
-- hundreds of new series per refresh interval — worst exactly when monitoring
-- is under load. The cap was also a global top-N, so one noisy class could
-- push every other class out of the gauge.
--
-- WHAT: group by a CLOSED category instead. Every branch of the CASE below
-- yields a string literal from a fixed list, so the label domain is bounded by
-- the FUNCTION, not by the data or by a row limit. New producers land in
-- 'other' until someone deliberately adds them here, which is a reviewed edit
-- rather than a label that quietly appears in production.
--
-- The categories come from workflow_run_error.data, not from the message:
--   * data->>'error_type' — written by github-repo-webhook for the rejection
--     paths. REJECTION_ERROR_TYPES in that file is the same closed set plus
--     'missing_grader_result'.
--   * data->>'type' = 'grader' — written by autograder-submit-feedback for
--     errors reported by the grading container itself.
--   * anything else (including a NULL data column, and the pass-through data
--     from autograder-create-submission, which is caller-supplied and therefore
--     must NOT be trusted as a label) → 'other'.
--
-- Cardinality: classes x 7 categories, with no top-N, so no class can be
-- crowded out of the gauge by a noisy neighbour. At 100 classes that is 700
-- series, replacing a 200-series cap that leaked without limit over time.
--
-- metrics_workflow_errors_by_name is left in place (unused by the app after
-- this migration) rather than dropped: dropping it would break a rollback to
-- the previous web image mid-deploy, and it costs nothing to keep.

CREATE OR REPLACE FUNCTION public.metrics_workflow_errors_by_category(window_hours numeric DEFAULT 1)
RETURNS TABLE (class_id text, category text, count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT class_id::text,
         category,
         COUNT(*)::bigint AS count
  FROM (
    SELECT class_id,
           CASE
             WHEN data->>'error_type' IN (
                    'file_too_large',
                    'submission_too_large',
                    'empty_submission',
                    'after_due_date',
                    'missing_grader_result'
                  )
               THEN data->>'error_type'
             WHEN data->>'type' = 'grader' THEN 'grader'
             ELSE 'other'
           END AS category
    FROM public.workflow_run_error
    WHERE created_at > NOW() - make_interval(hours => window_hours::int)
  ) c
  GROUP BY class_id, category
$$;

COMMENT ON FUNCTION public.metrics_workflow_errors_by_category(numeric) IS
  'workflow_run_error rows in the last N hours, grouped by class and a CLOSED error category derived from data->>''error_type'' / data->>''type''. Replaces metrics_workflow_errors_by_name, whose `name` label was free text and unbounded over time. Driver for web_workflow_errors_recent.';

GRANT EXECUTE ON FUNCTION public.metrics_workflow_errors_by_category(numeric) TO service_role;

COMMENT ON FUNCTION public.metrics_workflow_errors_by_name(numeric) IS
  'SUPERSEDED by metrics_workflow_errors_by_category. The `name` column is free text (500-char cap only) and several producers embed a commit sha in it, so using it as a Prometheus label is unbounded cardinality; the LIMIT 200 here caps one call, not the label domain over time. Kept only so a rollback to an older web image still works. Do not add new callers.';
