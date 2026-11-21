-- Check-in reopen follows the one-solo-request rule (#1310).
--
-- Answering "No, still stuck" to a check-in reopens the ticket, but the one-solo-request-per-queue
-- rule only ran when a ticket was created. A resolved ticket with a pending check-in doesn't count
-- against that rule, so a student could open a second ticket in the same queue and then escalate
-- the first, leaving two open solo tickets with the escalated one first in line. The reopen branch
-- now repeats the creation check and refuses with 23505, the same code the create RPC uses.
--
-- Same function as 20261116150100_help_request_escalation.sql plus that check.

CREATE OR REPLACE FUNCTION public.answer_help_request_check_in(
  p_help_request_id bigint,
  p_fixed boolean,
  p_note text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_request public.help_requests%ROWTYPE;
  v_caller uuid;
  v_previous_assignee uuid;
  v_blocking_request_id bigint;
  v_note text := regexp_replace(coalesce(p_note, ''), '^\s+|\s+$', '', 'g');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- The row lock serializes answers from students sharing a group request: the first wins,
  -- and the second sees the check-in already cleared.
  SELECT * INTO v_request FROM public.help_requests WHERE id = p_help_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'help request % not found', p_help_request_id USING ERRCODE = '42501';
  END IF;

  v_caller := public.help_request_caller_profile(v_request.class_id);
  IF v_caller IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.help_request_students hrs
        WHERE hrs.help_request_id = v_request.id AND hrs.profile_id = v_caller) THEN
    RAISE EXCEPTION 'help request % not found', p_help_request_id USING ERRCODE = '42501';
  END IF;

  IF v_request.status <> 'resolved'
     OR v_request.check_in_expires_at IS NULL
     OR v_request.check_in_expires_at <= now() THEN
    RAISE EXCEPTION 'this help request is no longer waiting for a check-in' USING ERRCODE = '22023';
  END IF;

  IF NOT p_fixed AND char_length(v_note) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'an escalation note of 1 to 500 characters is required' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('pawtograder.help_request_escalation_rpc', 'on', true);

  IF p_fixed THEN
    UPDATE public.help_requests SET check_in_expires_at = NULL WHERE id = v_request.id;
  ELSE
    -- Reopening puts the ticket back in line, so it has to pass the one-solo-request rule that
    -- create_help_request_with_participants applies at creation (20260825140000): at most one
    -- open or in-progress solo request per queue, creator and privacy. While this ticket waited
    -- for the check-in it was resolved and didn't count, so the student may have opened another.
    IF NOT EXISTS (SELECT 1 FROM public.help_request_students hrs
                    WHERE hrs.help_request_id = v_request.id
                      AND hrs.profile_id <> v_request.created_by) THEN
      SELECT hr.id
        INTO v_blocking_request_id
        FROM public.help_requests hr
       WHERE hr.id <> v_request.id
         AND hr.help_queue = v_request.help_queue
         AND hr.created_by = v_request.created_by
         AND hr.is_private = v_request.is_private
         AND hr.status IN ('open', 'in_progress')
         AND NOT EXISTS (SELECT 1 FROM public.help_request_students hrs
                          WHERE hrs.help_request_id = hr.id
                            AND hrs.profile_id <> v_request.created_by)
       ORDER BY hr.id
       LIMIT 1;
      IF v_blocking_request_id IS NOT NULL THEN
        RAISE EXCEPTION 'you already have a % solo help request in this queue (#%); finish it before reopening this one',
          CASE WHEN v_request.is_private THEN 'private' ELSE 'public' END, v_blocking_request_id
          USING ERRCODE = '23505',
                -- The client keys its student-facing copy on this hint, so other 23505 errors keep
                -- their generic message, and names the blocking request from DETAIL, which holds
                -- only its id (lib/helpRequestEscalation.ts, checkInErrorMessage).
                HINT = 'help_request_solo_reopen_conflict',
                DETAIL = v_blocking_request_id::text;
      END IF;
    END IF;

    SELECT coalesce(v_request.assignee, (
             SELECT ws.ta_profile_id FROM public.help_request_work_sessions ws
              WHERE ws.help_request_id = v_request.id
              ORDER BY ws.started_at DESC LIMIT 1))
      INTO v_previous_assignee;

    INSERT INTO public.help_request_escalations (class_id, help_request_id, escalated_by, source, previous_assignee, note)
    VALUES (v_request.class_id, v_request.id, v_caller, 'student', v_previous_assignee, v_note);

    UPDATE public.help_requests
       SET status = 'open',
           assignee = NULL,
           resolved_by = NULL,
           resolved_at = NULL,
           resolution_status = NULL,
           resolution_notes = NULL,
           check_in_expires_at = NULL,
           escalation_count = escalation_count + 1,
           last_escalated_at = now()
     WHERE id = v_request.id;

    PERFORM public.log_help_request_activity(v_request.id, v_request.class_id, 'request_escalated', 'Request escalated by student after check-in');
  END IF;

  PERFORM set_config('pawtograder.help_request_escalation_rpc', 'off', true);
END;
$$;

REVOKE ALL ON FUNCTION public.answer_help_request_check_in(bigint, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.answer_help_request_check_in(bigint, boolean, text) TO authenticated, service_role;
