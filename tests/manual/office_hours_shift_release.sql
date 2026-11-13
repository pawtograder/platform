-- Manual check for 20261111120000_office_hours_release_on_shift_end.sql.
-- Run against a local database with the migration applied. Everything is rolled back.
--   psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -f tests/manual/office_hours_shift_release.sql

BEGIN;

DO $$
DECLARE
  v_class bigint := 1;
  v_queue bigint := 3;
  v_ta uuid := '49b17f76-ad02-41c6-ae4b-7f51b682ae26';
  v_other uuid;
  v_status text;
  v_assignee uuid;
  v_other_status text;
BEGIN
  -- Flag off: the shift ends and nothing is released.
  UPDATE public.classes SET features = '[]'::jsonb WHERE id = v_class;
  UPDATE public.help_requests SET status = 'in_progress', assignee = v_ta WHERE id = 1;
  UPDATE public.help_queue_assignments SET ended_at = now()
    WHERE ta_profile_id = v_ta AND help_queue_id = v_queue AND ended_at IS NULL;
  SELECT status, assignee INTO v_status, v_assignee FROM public.help_requests WHERE id = 1;
  IF v_status <> 'in_progress' OR v_assignee IS DISTINCT FROM v_ta THEN
    RAISE EXCEPTION 'flag off: expected request 1 untouched, got status=% assignee=%', v_status, v_assignee;
  END IF;
  RAISE NOTICE 'PASS flag off: request left in_progress';

  -- Reset the assignment so the next shift end is a real transition.
  UPDATE public.help_queue_assignments SET ended_at = NULL
    WHERE ta_profile_id = v_ta AND help_queue_id = v_queue;

  -- Flag on: the TA's request goes back to the queue, and another TA's request is untouched.
  UPDATE public.classes SET features = '[{"name":"office-hours-shift-release","enabled":true}]'::jsonb WHERE id = v_class;
  SELECT assignee INTO v_other FROM public.help_requests WHERE id = 2;
  UPDATE public.help_requests SET status = 'in_progress', assignee = v_ta WHERE id = 1;
  UPDATE public.help_requests SET status = 'in_progress', assignee = NULL WHERE id = 2;
  UPDATE public.help_requests SET status = 'in_progress', assignee = v_other WHERE id = 2 AND v_other IS NOT NULL;
  UPDATE public.help_queue_assignments SET ended_at = now()
    WHERE ta_profile_id = v_ta AND help_queue_id = v_queue AND ended_at IS NULL;
  SELECT status, assignee INTO v_status, v_assignee FROM public.help_requests WHERE id = 1;
  IF v_status <> 'open' OR v_assignee IS NOT NULL THEN
    RAISE EXCEPTION 'flag on: expected request 1 released, got status=% assignee=%', v_status, v_assignee;
  END IF;
  RAISE NOTICE 'PASS flag on: request released to open, unassigned';
END $$;

ROLLBACK;
