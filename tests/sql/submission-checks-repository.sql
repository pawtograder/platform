-- Isolated PostgreSQL fixture: run in an empty disposable database, never production.
BEGIN;
CREATE TABLE public.submissions (id bigint, head_sha text, sha text, repository_id bigint);
CREATE TABLE public.workflow_events (id bigint, head_sha text, repository_id bigint);
\ir ../../supabase/migrations/20261123125000_scope_submission_checks_repository.sql
INSERT INTO public.submissions VALUES (1, 'shared', 'old', 10), (2, NULL, 'shared', 20);
INSERT INTO public.workflow_events VALUES (1, 'shared', 10), (2, 'shared', 20), (3, 'shared', NULL), (4, 'other', 10);
DO $$
BEGIN
  IF (SELECT array_agg(id ORDER BY id) FROM public.get_submission_checks(1)) <> ARRAY[1,3]::bigint[] THEN
    RAISE EXCEPTION 'repository 10 leaked another repository or lost null-repository event';
  END IF;
  IF (SELECT array_agg(id ORDER BY id) FROM public.get_submission_checks(2)) <> ARRAY[2,3]::bigint[] THEN
    RAISE EXCEPTION 'fallback SHA matching failed';
  END IF;
  IF EXISTS (SELECT FROM public.get_submission_checks(999)) THEN
    RAISE EXCEPTION 'missing submission returned events';
  END IF;
END $$;
ROLLBACK;
