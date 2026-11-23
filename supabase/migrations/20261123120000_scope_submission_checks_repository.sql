-- Preserve SHA index lookup and invoker RLS, but exclude other student repositories.
CREATE OR REPLACE FUNCTION public.get_submission_checks(p_submission_id bigint)
RETURNS SETOF public.workflow_events
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT we.*
  FROM public.workflow_events we
  WHERE we.head_sha = (
    SELECT coalesce(s.head_sha, s.sha)
    FROM public.submissions s
    WHERE s.id = p_submission_id
  )
  AND (we.repository_id IS NULL OR we.repository_id = (
    SELECT s.repository_id FROM public.submissions s WHERE s.id = p_submission_id
  ));
$$;
