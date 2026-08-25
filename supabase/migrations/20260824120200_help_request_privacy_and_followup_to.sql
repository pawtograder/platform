-- Office-hours audit follow-ups: help-request privacy boundary + followup_to plumbing.
--
-- Two changes, both in the help-request area:
--
-- 1. forbid_help_request_privacy_downgrade
--    help_requests.is_private was writable true -> false by any participant. The
--    "Students can update their own help requests" policy puts no column restriction on
--    the row, so the client could (and did) publish a private request as a side effect of
--    an unrelated edit: saving the "Referenced Code" panel recomputed
--    `is_private = (has file refs OR has submission ref)`, so removing the last code
--    reference flipped the request public. That exposed the whole thread, because RLS on
--    help_request_messages goes through can_access_help_request(), which branches on this
--    flag, and because broadcast_help_requests_to_class() re-broadcasts the row to
--    class:<id>:students with a privacy-aware payload.
--
--    The client no longer downgrades (help-request-chat.tsx now escalates only), but the
--    client is not the boundary. This trigger is: only course staff may take a private
--    help request public. If we ever want to offer students an explicit "make this
--    public" control, it needs its own SECURITY DEFINER RPC that re-checks the caller and
--    what is attached to the request -- not a direct column write from a form save.
--
--    The check authorizes against OLD.class_id and the trigger also forbids changing
--    class_id at all. Authorizing against NEW.class_id was bypassable: a participant who
--    is staff in a different class could set class_id to that class and is_private=false
--    in one PATCH -- the UPDATE policy admits them via user_is_in_help_request(id) for
--    both rows -- and the request was published into the substituted class. Reproduced
--    end to end through PostgREST (HTTP 200, row left at class_id=<other>,
--    is_private=false) before this was tightened.
--
-- 2. create_help_request_with_participants gains p_followup_to
--    The new-request form collects "Follow-Up to Previous Request" (and pre-fills it from
--    ?followup_to=<id>, which the queue list's Follow-Up button links to), but the RPC had
--    no such parameter and its INSERT never listed the column, so every follow-up link was
--    dropped and help_requests.followup_to was always null -- including in the staff CLI's
--    `help-requests list` output, which selects and prints it.
--
--    Adding a defaulted parameter with CREATE OR REPLACE would register a second overload
--    and make the existing 8-argument PostgREST calls ambiguous ("function is not
--    unique"), so the old signature is dropped first. Ordering is safe in both directions
--    during a rolling deploy: an old client sends the same 8 named arguments and resolves
--    against the new all-defaults signature.
--
--    followup_to also had no foreign key, so this migration adds one.

-- 1. Privacy downgrades are staff-only ------------------------------------------------

CREATE OR REPLACE FUNCTION public.forbid_help_request_privacy_downgrade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
    -- Attached to `BEFORE UPDATE OF is_private, class_id`, which fires on the statement's
    -- column list rather than on an actual value change, so the OLD/NEW comparisons here
    -- are what do the work: a no-op write of the same value is allowed through.

    -- A help request never changes class. Nothing in the product moves one -- the class
    -- is derived from the queue at creation and no code path writes this column -- and
    -- allowing it defeats the privacy check below. The UPDATE policy admits a participant
    -- through user_is_in_help_request(id), which is class-independent and passes for both
    -- the old and the new row, so a participant who happens to be staff in some OTHER
    -- class could re-home the request into that class and authorize their own downgrade:
    -- in a single statement if we authorized against NEW, or in two statements (move,
    -- then downgrade) even if we authorize against OLD. Blocking the move is what closes
    -- both. It is also the only thing keeping the row consistent with its help_queue,
    -- which belongs to the original class.
    IF NEW.class_id IS DISTINCT FROM OLD.class_id THEN
        RAISE EXCEPTION 'help request % cannot be moved between classes', OLD.id
            USING ERRCODE = '42501';
    END IF;

    -- Authorize against OLD.class_id. NEW.class_id is caller-controlled in the same
    -- statement, so authorizing against it would let the caller pick the class that
    -- grants them staff privileges.
    IF OLD.is_private = true AND NEW.is_private = false
       AND NOT public.authorizeforclassgrader(OLD.class_id) THEN
        RAISE EXCEPTION 'only course staff may make a private help request public'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

ALTER FUNCTION public.forbid_help_request_privacy_downgrade() OWNER TO postgres;

COMMENT ON FUNCTION public.forbid_help_request_privacy_downgrade() IS
'Guards the help-request privacy boundary. Rejects true -> false transitions of help_requests.is_private unless the caller is an instructor or grader in the request''s OWN class (OLD.class_id), and rejects any change to class_id. RLS lets any participant update their own help request row with no column restriction, and a client-side edit path used to publish private requests as a side effect of removing their last code reference, exposing the whole message thread (help_request_messages RLS reads this flag via can_access_help_request). Authorizing against NEW.class_id would be caller-controlled: a participant who is staff in another class could move the request there and approve their own downgrade.';

DROP TRIGGER IF EXISTS forbid_help_request_privacy_downgrade_tr ON public.help_requests;
CREATE TRIGGER forbid_help_request_privacy_downgrade_tr
    BEFORE UPDATE OF is_private, class_id ON public.help_requests
    FOR EACH ROW EXECUTE FUNCTION public.forbid_help_request_privacy_downgrade();

-- 2. followup_to: foreign key ----------------------------------------------------------

-- Self-referencing, and nulled rather than cascaded: a follow-up must outlive the request
-- it points back at. Validation is a trivial scan today because nothing has ever written
-- this column (verified 0 non-null values, 0 dangling ids before adding the constraint).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.help_requests'::regclass
           AND conname = 'help_requests_followup_to_fkey'
    ) THEN
        ALTER TABLE public.help_requests
            ADD CONSTRAINT help_requests_followup_to_fkey
            FOREIGN KEY (followup_to) REFERENCES public.help_requests(id) ON DELETE SET NULL;
    END IF;
END
$$;

-- 3. create_help_request_with_participants: accept and persist followup_to -------------

DROP FUNCTION IF EXISTS public.create_help_request_with_participants(
    bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb);

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

ALTER FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint) TO service_role;

COMMENT ON FUNCTION public.create_help_request_with_participants(bigint, text, boolean, public.location_type, uuid[], bigint, bigint, jsonb, bigint) IS
'Atomically creates a help_requests row plus its help_request_students, help_request_messages, help_request_file_references, and student_help_activity children. Auth + class/queue/membership checks happen inside; the function uses SECURITY DEFINER so callers do not need direct INSERT privileges on the child tables. p_followup_to optionally links the new request to an earlier request in the same class that the caller took part in.';
