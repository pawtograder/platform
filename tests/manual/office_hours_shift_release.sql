-- Manual check for 20261117174000_office_hours_release_on_shift_end.sql.
-- Fixtures: an active help_queue_assignments row for the TA below on queue 3 (the seeded instructor shift).
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
  -- Fixture check: the TA needs an active shift on the queue. Seed one first if this fails.
  IF NOT EXISTS (
    SELECT 1 FROM public.help_queue_assignments
    WHERE ta_profile_id = v_ta AND help_queue_id = v_queue AND ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Missing fixture: no active shift for TA % on queue %. Start a shift for this TA on this queue, then rerun.', v_ta, v_queue;
  END IF;

  -- Fixture check: request 1 has to be the one the ending shift covers. The trigger releases
  -- another queue's request only once the TA has no shift left, so a request on a different queue
  -- would correctly stay assigned and the enabled case below would report a failure that isn't one.
  IF NOT EXISTS (
    SELECT 1 FROM public.help_requests WHERE id = 1 AND class_id = v_class AND help_queue = v_queue
  ) THEN
    RAISE EXCEPTION 'Missing fixture: help request 1 is not on class % queue %. Point v_class/v_queue at a request this TA''s shift covers, then rerun.', v_class, v_queue;
  END IF;

  -- Fixture check: this has to be the TA's only running shift in the class, or the release below
  -- would be the queue-scoped half of the rule rather than the whole thing.
  IF EXISTS (
    SELECT 1 FROM public.help_queue_assignments
    WHERE class_id = v_class AND ta_profile_id = v_ta AND ended_at IS NULL AND help_queue_id <> v_queue
  ) THEN
    RAISE EXCEPTION 'Missing fixture: TA % has another running shift in class %. End it first, then rerun.', v_ta, v_class;
  END IF;

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
