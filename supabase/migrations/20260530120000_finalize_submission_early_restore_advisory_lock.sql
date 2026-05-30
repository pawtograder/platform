-- finalize_submission_early(): restore the advisory-lock hardening.
--
-- Migration 20260413234500 hardened this RPC against concurrent finalize
-- bursts (e.g. two members of the same assignment group racing) by taking a
-- transaction-scoped advisory lock keyed on (assignment, group/profile) before
-- the "already finalized" check-then-insert. Migration 20260522180000 then
-- rebased the function on the pre-lock 20250703014545 version to add the
-- self-review release_at behavior, silently dropping the lock and the
-- calculate_final_due_date / past-due guards along with it. The result was a
-- race where multiple concurrent callers could each pass the EXISTS check and
-- insert a finalize exception (two "success" responses instead of one).
--
-- This migration re-unifies both lines: the advisory lock + effective-due-date
-- hardening from 20260413234500 AND the release_at self-review gating from
-- 20260522180000. When the assignment has an explicit self-review release_at,
-- the created review_assignment gets release_date = release_at (gating rubric
-- visibility via RLS) and due_date = release_at + deadline_offset; when
-- release_at IS NULL, behavior matches the pre-release_at version.
----------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."finalize_submission_early"("this_assignment_id" bigint, "this_profile_id" uuid)
RETURNS json
LANGUAGE "plpgsql" SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    this_assignment public.assignments;
    this_group_id bigint;
    this_self_review_setting public.assignment_self_review_settings;
    this_active_submission_id bigint;
    existing_submission_review_id bigint;
    hours_to_subtract integer;
    minutes_to_subtract integer;
    utc_now TIMESTAMP WITH TIME ZONE := date_trunc('minute', now() + interval '59 second');
    effective_due_date timestamp with time zone;
BEGIN
    -- Get the assignment first
    SELECT * INTO this_assignment FROM public.assignments WHERE id = this_assignment_id;

    -- Check if assignment exists
    IF this_assignment.id IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'Assignment not found');
    END IF;

    -- Confirm this is a private profile for a student in this class, else abort
    IF NOT EXISTS (
        SELECT 1 FROM user_roles
        WHERE private_profile_id = this_profile_id
        AND role = 'student'
        AND class_id = this_assignment.class_id
        AND user_id = auth.uid()
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Not authorized');
    END IF;

    -- Get the group of the student for this assignment
    SELECT assignment_group_id INTO this_group_id
    FROM public.assignment_groups_members
    WHERE profile_id = this_profile_id
    AND class_id = this_assignment.class_id
    AND assignment_id = this_assignment.id
    LIMIT 1;

    -- Serialize all finalize attempts for this assignment + group/profile tuple.
    PERFORM public.acquire_assignment_due_date_exception_lock(this_assignment_id, this_profile_id, this_group_id);

    -- Get the self review setting
    SELECT * INTO this_self_review_setting
    FROM public.assignment_self_review_settings
    WHERE id = this_assignment.self_review_setting_id;

    -- If self reviews are not enabled for this assignment, abort
    IF this_self_review_setting.enabled IS NOT TRUE THEN
        RETURN json_build_object('success', false, 'error', 'Self reviews not enabled for this assignment');
    END IF;

    -- Check if there's already a finalize exception (negative hours) for this student/group.
    IF EXISTS (
        SELECT 1 FROM assignment_due_date_exceptions
        WHERE assignment_id = this_assignment_id
        AND (
            student_id = this_profile_id OR
            (this_group_id IS NOT NULL AND assignment_group_id = this_group_id)
        )
        AND (hours < 0 OR (hours = 0 AND minutes < 0))
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Submission already finalized');
    END IF;

    -- Get the FINAL due date including all existing extensions (late tokens, instructor grants, etc.)
    -- calculate_effective_due_date only returns the base date; calculate_final_due_date includes extensions.
    effective_due_date := public.calculate_final_due_date(this_assignment_id, this_profile_id, this_group_id);

    -- Reject if the student is at or past their actual deadline
    IF utc_now >= effective_due_date THEN
        RETURN json_build_object('success', false, 'error', 'Cannot finalize early after the due date has passed');
    END IF;

    -- Calculate hours and minutes to subtract from the final due date
    hours_to_subtract := -1 * EXTRACT(EPOCH FROM (effective_due_date - utc_now)) / 3600;
    minutes_to_subtract := -1 * (EXTRACT(EPOCH FROM (effective_due_date - utc_now)) % 3600) / 60;

    -- Safety net: the result must always be negative (moving the deadline earlier)
    IF hours_to_subtract >= 0 AND minutes_to_subtract >= 0 THEN
        RETURN json_build_object('success', false, 'error', 'Cannot finalize early after the due date has passed');
    END IF;

    -- Get the active submission id for this profile
    SELECT id INTO this_active_submission_id
    FROM public.submissions
    WHERE ((profile_id IS NOT NULL AND profile_id = this_profile_id) OR (assignment_group_id IS NOT NULL AND assignment_group_id = this_group_id))
    AND assignment_id = this_assignment_id
    AND is_active = true
    LIMIT 1;

    -- If active submission does not exist, abort
    IF this_active_submission_id IS NULL THEN
        RETURN json_build_object('success', false, 'error', 'No active submission found');
    END IF;

    -- Check if there's already a self-review assignment for this student for this
    -- submission. Scope to the active submission + self-review rubric so an
    -- unrelated review task assigned to this student (e.g. a peer review) on the
    -- same assignment does not falsely report the self review as already assigned.
    IF EXISTS (
        SELECT 1 FROM review_assignments
        WHERE assignment_id = this_assignment.id
        AND assignee_profile_id = this_profile_id
        AND submission_id = this_active_submission_id
        AND rubric_id = this_assignment.self_review_rubric_id
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Self review already assigned');
    END IF;

    -- Insert the negative due date exception only after validation checks pass
    IF this_group_id IS NOT NULL THEN
        INSERT INTO assignment_due_date_exceptions (
            class_id,
            assignment_id,
            assignment_group_id,
            creator_id,
            hours,
            minutes,
            tokens_consumed
        ) VALUES (
            this_assignment.class_id,
            this_assignment_id,
            this_group_id,
            this_profile_id,
            hours_to_subtract,
            minutes_to_subtract,
            0
        );
    ELSE
        INSERT INTO assignment_due_date_exceptions (
            class_id,
            assignment_id,
            student_id,
            creator_id,
            hours,
            minutes,
            tokens_consumed
        ) VALUES (
            this_assignment.class_id,
            this_assignment_id,
            this_profile_id,
            this_profile_id,
            hours_to_subtract,
            minutes_to_subtract,
            0
        );
    END IF;

    -- Create or get existing submission review
    SELECT id INTO existing_submission_review_id
    FROM public.submission_reviews
    WHERE submission_id = this_active_submission_id
    AND class_id = this_assignment.class_id
    AND rubric_id = this_assignment.self_review_rubric_id
    LIMIT 1;

    IF existing_submission_review_id IS NULL THEN
        INSERT INTO submission_reviews (total_score, released, tweak, class_id, submission_id, name, rubric_id)
        VALUES (0, false, 0, this_assignment.class_id, this_active_submission_id, 'Self Review', this_assignment.self_review_rubric_id)
        RETURNING id INTO existing_submission_review_id;
    END IF;

    -- Create the review assignment. When release_at is set, keep the rubric
    -- hidden until release_at by setting release_date, and anchor the review
    -- due_date on release_at; otherwise preserve the early-finalize behavior.
    INSERT INTO review_assignments (
        due_date,
        release_date,
        assignee_profile_id,
        submission_id,
        submission_review_id,
        assignment_id,
        rubric_id,
        class_id
    ) VALUES (
        CASE
            WHEN this_self_review_setting.release_at IS NOT NULL
                THEN this_self_review_setting.release_at + (INTERVAL '1 hour' * this_self_review_setting.deadline_offset)
            ELSE utc_now + (INTERVAL '1 hour' * this_self_review_setting.deadline_offset)
        END,
        this_self_review_setting.release_at,
        this_profile_id,
        this_active_submission_id,
        existing_submission_review_id,
        this_assignment.id,
        this_assignment.self_review_rubric_id,
        this_assignment.class_id
    );

    RETURN json_build_object('success', true, 'message', 'Submission finalized and self review assigned');
END;
$$;

GRANT EXECUTE ON FUNCTION finalize_submission_early(bigint, uuid) TO authenticated;
