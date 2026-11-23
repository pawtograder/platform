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
      -- The row lock above covers only this request. Two "not fixed" answers on different
      -- resolved requests with the same queue, creator and privacy could otherwise both pass the
      -- check below before either reopens. This lock makes the second wait until the first
      -- commits; its check then runs on a fresh snapshot and sees the first request open.
      -- Key: 'help_request_solo:<queue>:<creator>:<is_private>'. create_help_request_with_participants
      -- (redefined below) takes the same lock, so a creation and a reopen serialize too.
      PERFORM pg_advisory_xact_lock(hashtextextended(
        format('help_request_solo:%s:%s:%s', v_request.help_queue, v_request.created_by, v_request.is_private), 0));
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

-- create_help_request_with_participants applies the same solo rule at creation, with the same
-- unlocked check-then-insert. Redefined from 20260825140000_audit_findings_2026_08.sql unchanged
-- except for the advisory lock before the solo check. CREATE OR REPLACE keeps the owner and the
-- grants set by 20261015120000_lock_down_security_definer_functions.sql.
CREATE OR REPLACE FUNCTION public.create_help_request_with_participants(
    p_help_queue_id bigint,
    p_request text,
    p_is_private boolean DEFAULT false,
    p_location_type public.location_type DEFAULT 'remote',
    p_student_profile_ids uuid[] DEFAULT ARRAY[]::uuid[],
    p_template_id bigint DEFAULT NULL,
    p_referenced_submission_id bigint DEFAULT NULL,
    p_file_references jsonb DEFAULT '[]'::jsonb,
    p_followup_to bigint DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_uid uuid := auth.uid();
    v_class_id bigint;
    v_caller_private_profile uuid;
    v_help_queue_available boolean;
    v_help_queue_is_demo boolean;
    v_help_queue_active_staff_count int;
    v_help_request_id bigint;
    v_invalid_count int;
    v_existing_solo_count int;
    v_student uuid;
    v_file jsonb;
    v_help_queue_name text;
BEGIN
    IF v_caller_uid IS NULL THEN
        RAISE EXCEPTION 'not authenticated'
            USING ERRCODE = '28000';
    END IF;

    IF p_request IS NULL OR length(trim(p_request)) = 0 THEN
        RAISE EXCEPTION 'request body is required'
            USING ERRCODE = '22023';
    END IF;

    -- 1. Resolve queue → class. Use a single fetch to also grab the
    --    "is this queue accepting requests" + name signals.
    SELECT class_id, available, is_demo, name
      INTO v_class_id, v_help_queue_available, v_help_queue_is_demo, v_help_queue_name
      FROM public.help_queues
     WHERE id = p_help_queue_id;
    IF v_class_id IS NULL THEN
        RAISE EXCEPTION 'help_queue % does not exist', p_help_queue_id
            USING ERRCODE = '22023';
    END IF;
    IF NOT (v_help_queue_is_demo OR v_help_queue_available) THEN
        RAISE EXCEPTION 'queue is not accepting new requests'
            USING ERRCODE = '22023';
    END IF;

    -- 2. Caller must be an active member of the class. Resolve the
    --    private_profile_id we'll write into help_requests.created_by /
    --    help_request_messages.author from the same row.
    SELECT private_profile_id
      INTO v_caller_private_profile
      FROM public.user_roles
     WHERE user_id = v_caller_uid
       AND class_id = v_class_id
       AND disabled = false
     LIMIT 1;
    IF v_caller_private_profile IS NULL THEN
        RAISE EXCEPTION 'caller is not enrolled in class %', v_class_id
            USING ERRCODE = '42501';
    END IF;

    -- 3. Active-staff gate for non-demo queues. Same predicate as the
    --    legacy client-side `queueIdsWithActiveStaff` check.
    IF NOT v_help_queue_is_demo THEN
        SELECT count(*)
          INTO v_help_queue_active_staff_count
          FROM public.help_queue_assignments
         WHERE help_queue_id = p_help_queue_id
           AND is_active = true
           AND ended_at IS NULL;
        IF v_help_queue_active_staff_count = 0 THEN
            RAISE EXCEPTION 'queue % is not currently staffed', v_help_queue_name
                USING ERRCODE = '22023';
        END IF;
    END IF;

    -- 4. Caller must be in their own participants list. We allow the
    --    caller to send an empty / null participants list and default it
    --    to "just me", which matches the form's auto-add-self behavior.
    IF p_student_profile_ids IS NULL OR array_length(p_student_profile_ids, 1) IS NULL THEN
        p_student_profile_ids := ARRAY[v_caller_private_profile];
    ELSIF NOT v_caller_private_profile = ANY(p_student_profile_ids) THEN
        p_student_profile_ids := p_student_profile_ids || v_caller_private_profile;
    END IF;

    -- 5. Every participant must be an active member of the same class.
    --    Done with a single anti-join.
    SELECT count(*)
      INTO v_invalid_count
      FROM unnest(p_student_profile_ids) AS pid(id)
     WHERE NOT EXISTS (
        SELECT 1
          FROM public.user_roles ur
         WHERE ur.private_profile_id = pid.id
           AND ur.class_id = v_class_id
           AND ur.disabled = false
     );
    IF v_invalid_count > 0 THEN
        RAISE EXCEPTION '% participant(s) are not members of this class', v_invalid_count
            USING ERRCODE = '42501';
    END IF;

    -- 6. Solo-request uniqueness: at most one open request per (queue,
    --    creator, privacy) combination. Matches the legacy client check.
    IF array_length(p_student_profile_ids, 1) = 1
       AND p_student_profile_ids[1] = v_caller_private_profile THEN
        -- Same lock and key as answer_help_request_check_in's reopen check, so a creation and a
        -- "not fixed" reopen for the same queue, creator and privacy can't both pass (#1344).
        PERFORM pg_advisory_xact_lock(hashtextextended(
            format('help_request_solo:%s:%s:%s', p_help_queue_id, v_caller_private_profile, p_is_private), 0));
        SELECT count(*)
          INTO v_existing_solo_count
          FROM public.help_requests hr
         WHERE hr.help_queue = p_help_queue_id
           AND hr.created_by = v_caller_private_profile
           AND hr.is_private = p_is_private
           AND hr.status IN ('open', 'in_progress')
           AND NOT EXISTS (
               SELECT 1
                 FROM public.help_request_students hrs
                WHERE hrs.help_request_id = hr.id
                  AND hrs.profile_id <> v_caller_private_profile
           );
        IF v_existing_solo_count > 0 THEN
            RAISE EXCEPTION 'you already have a % solo help request in this queue',
                CASE WHEN p_is_private THEN 'private' ELSE 'public' END
                USING ERRCODE = '23505';
        END IF;
    END IF;

    -- 7. Optional template / submission ownership checks. NULL passes.
    IF p_template_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.help_request_templates t
            WHERE t.id = p_template_id AND t.class_id = v_class_id
       ) THEN
        RAISE EXCEPTION 'template % is not in class %', p_template_id, v_class_id
            USING ERRCODE = '22023';
    END IF;
    IF p_referenced_submission_id IS NOT NULL
       AND NOT EXISTS (
           SELECT 1 FROM public.submissions s
            WHERE s.id = p_referenced_submission_id AND s.class_id = v_class_id
       ) THEN
        RAISE EXCEPTION 'referenced submission % is not in class %', p_referenced_submission_id, v_class_id
            USING ERRCODE = '22023';
    END IF;

    -- followup_to must be a request in this class that the caller took part in. The
    -- form only offers the caller's own resolved/closed requests, but the value also
    -- arrives from a ?followup_to= URL parameter, so it is attacker-controlled and the
    -- column has no FK of its own until this migration adds one. Reject rather than
    -- silently drop, so a stale link surfaces instead of quietly losing the link.
    IF p_followup_to IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
             FROM public.help_requests prev
             JOIN public.help_request_students prev_s
               ON prev_s.help_request_id = prev.id
            WHERE prev.id = p_followup_to
              AND prev.class_id = v_class_id
              AND prev_s.profile_id = v_caller_private_profile
       ) THEN
        RAISE EXCEPTION 'followup_to % is not one of your help requests in class %', p_followup_to, v_class_id
            USING ERRCODE = '22023';
    END IF;

    -- 8. Insert the help_requests row. Triggers (broadcast, channel
    --    pre-creation, etc.) fire here as part of the transaction.
    INSERT INTO public.help_requests (
        class_id, help_queue, created_by, request, is_private,
        location_type, status, template_id, referenced_submission_id,
        is_video_live, followup_to
    )
    VALUES (
        v_class_id, p_help_queue_id, v_caller_private_profile, p_request, p_is_private,
        p_location_type, 'open', p_template_id, p_referenced_submission_id,
        false, p_followup_to
    )
    RETURNING id INTO v_help_request_id;

    -- 9. Participant memberships.
    FOREACH v_student IN ARRAY p_student_profile_ids LOOP
        INSERT INTO public.help_request_students (help_request_id, profile_id, class_id)
        VALUES (v_help_request_id, v_student, v_class_id);
    END LOOP;

    -- 10. Initial chat message mirroring the request body so the chat
    --     view shows the question without a follow-up round-trip.
    INSERT INTO public.help_request_messages (
        help_request_id, class_id, author, message, instructors_only, reply_to_message_id
    )
    VALUES (
        v_help_request_id, v_class_id, v_caller_private_profile, p_request, false, NULL
    );

    -- 11. Optional file references. p_file_references is an array of
    --     {submission_file_id, line_number, assignment_id, submission_id}.
    --     Missing/extra keys are tolerated; FKs do the rest.
    IF jsonb_typeof(p_file_references) = 'array' THEN
        FOR v_file IN SELECT * FROM jsonb_array_elements(p_file_references) LOOP
            INSERT INTO public.help_request_file_references (
                help_request_id, class_id, submission_file_id, line_number,
                assignment_id, submission_id
            )
            VALUES (
                v_help_request_id,
                v_class_id,
                NULLIF((v_file->>'submission_file_id'), '')::bigint,
                NULLIF((v_file->>'line_number'), '')::bigint,
                NULLIF((v_file->>'assignment_id'), '')::bigint,
                NULLIF((v_file->>'submission_id'), '')::bigint
            );
        END LOOP;
    END IF;

    -- 12. Activity log row per participant. Best-effort to match the
    --     legacy behavior; if the activity type ever drops or rejects a
    --     row the whole help-request creation rolls back, which is fine
    --     — we'd want to know about that.
    FOREACH v_student IN ARRAY p_student_profile_ids LOOP
        INSERT INTO public.student_help_activity (
            student_profile_id, class_id, help_request_id, activity_type, activity_description
        )
        VALUES (
            v_student, v_class_id, v_help_request_id, 'request_created',
            'Student created a new help request in queue: ' || v_help_queue_name
        );
    END LOOP;

    RETURN v_help_request_id;
END;
$$;
