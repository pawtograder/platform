-- create_help_request_with_participants
--
-- Atomically creates a help request together with everything else the
-- new-help-request form used to write piecemeal from the browser:
--   * help_requests (the row itself)
--   * help_request_students (one binding per participating student; caller
--     is always included)
--   * help_request_messages (initial chat message with the request text)
--   * help_request_file_references (optional code references)
--   * student_help_activity (one "request_created" log per participant)
--
-- All inserts happen inside a single transaction. If anything fails (auth,
-- validation, FK violation, trigger error) nothing persists — the form
-- can no longer end up with a half-created request the way the legacy
-- multi-write path could.
--
-- Authorization model (all enforced inside the function, NOT relying on
-- caller-side RLS):
--   * caller must have an active (disabled=false) user_roles row for the
--     class implied by the help_queue
--   * the help_queue must be available (or is_demo) and have at least one
--     active assignment (or be a demo queue) — i.e. the same gate the
--     legacy client-side check enforces
--   * every profile id in p_student_profile_ids must be an active member
--     of that class
--   * the caller's own private_profile_id must be in p_student_profile_ids
--     (you can't create a help request that doesn't include you)
--   * optional template_id / referenced_submission_id must belong to the
--     same class
--
-- For solo requests (single student == caller) we enforce the same
-- "max one of each privacy bucket per queue" rule the legacy client
-- checked. For group requests we currently rely on the same loose
-- behavior the legacy code had — no duplicate-group check.
--
-- Returns the newly-created help_request id.

CREATE OR REPLACE FUNCTION public.create_help_request_with_participants(
    p_help_queue_id bigint,
    p_request text,
    p_is_private boolean DEFAULT false,
    p_location_type public.location_type DEFAULT 'remote',
    p_student_profile_ids uuid[] DEFAULT ARRAY[]::uuid[],
    p_template_id bigint DEFAULT NULL,
    p_referenced_submission_id bigint DEFAULT NULL,
    p_file_references jsonb DEFAULT '[]'::jsonb
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

    -- 8. Insert the help_requests row. Triggers (broadcast, channel
    --    pre-creation, etc.) fire here as part of the transaction.
    INSERT INTO public.help_requests (
        class_id, help_queue, created_by, request, is_private,
        location_type, status, template_id, referenced_submission_id,
        is_video_live
    )
    VALUES (
        v_class_id, p_help_queue_id, v_caller_private_profile, p_request, p_is_private,
        p_location_type, 'open', p_template_id, p_referenced_submission_id,
        false
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

ALTER FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb) TO service_role;

COMMENT ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb) IS
'Atomically creates a help_requests row plus its help_request_students, help_request_messages, help_request_file_references, and student_help_activity children. Auth + class/queue/membership checks happen inside; the function uses SECURITY DEFINER so callers do not need direct INSERT privileges on the child tables. Replaces the legacy 4-5 sequential client-side writes from newRequestForm.tsx that left the door open for partially-created requests under realtime backpressure.';
