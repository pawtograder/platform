-- Centralized advisory lock helpers for assignment_due_date_exceptions write paths.
CREATE OR REPLACE FUNCTION public.assignment_due_date_exception_lock_key(
    _assignment_id bigint,
    _student_id uuid,
    _assignment_group_id bigint
)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT hashtextextended(
        'assignment_due_date_exceptions:' || _assignment_id::text || ':' || COALESCE(_assignment_group_id::text, _student_id::text, 'no-subject'),
        0
    );
$$;

CREATE OR REPLACE FUNCTION public.acquire_assignment_due_date_exception_lock(
    _assignment_id bigint,
    _student_id uuid,
    _assignment_group_id bigint
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(
        public.assignment_due_date_exception_lock_key(_assignment_id, _student_id, _assignment_group_id)
    );
END;
$$;

-- Re-define finalize_submission_early to use the shared lock helper.
CREATE OR REPLACE FUNCTION "public"."finalize_submission_early"("this_assignment_id" bigint, "this_profile_id" uuid)
RETURNS json
LANGUAGE "plpgsql" SECURITY DEFINER
AS $$
DECLARE
    this_assignment public.assignments;
    this_group_id bigint;
    this_self_review_setting public.assignment_self_review_settings;
    this_active_submission_id bigint;
    existing_submission_review_id bigint;
    hours_to_subtract integer;
    minutes_to_subtract integer;
    utc_now TIMESTAMP := date_trunc('minute', now() + interval '59 second');
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

    -- Check if there's already a negative due date exception (already finalized)
    IF EXISTS (
        SELECT 1 FROM assignment_due_date_exceptions
        WHERE assignment_id = this_assignment_id
        AND (
            (student_id = this_profile_id AND hours < 0) OR
            (assignment_group_id = this_group_id AND hours < 0)
        )
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Submission already finalized');
    END IF;

    -- Get the effective due date (lab-based or regular)
    effective_due_date := public.calculate_effective_due_date(this_assignment_id, this_profile_id);

    -- Calculate hours and minutes to subtract from the effective due date
    hours_to_subtract := -1 * EXTRACT(EPOCH FROM (effective_due_date - utc_now)) / 3600;
    minutes_to_subtract := -1 * (EXTRACT(EPOCH FROM (effective_due_date - utc_now)) % 3600) / 60;

    -- Insert the negative due date exception
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

    -- Check if there's already a review assignment for this student for this assignment
    IF EXISTS (
        SELECT 1 FROM review_assignments
        WHERE assignment_id = this_assignment.id
        AND assignee_profile_id = this_profile_id
    ) THEN
        RETURN json_build_object('success', false, 'error', 'Self review already assigned');
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

    -- Create the review assignment using the effective due date
    INSERT INTO review_assignments (
        due_date,
        assignee_profile_id,
        submission_id,
        submission_review_id,
        assignment_id,
        rubric_id,
        class_id
    ) VALUES (
        utc_now + (INTERVAL '1 hour' * this_self_review_setting.deadline_offset),
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

-- Harden extension authorization checks used by RLS with the same lock key.
CREATE OR REPLACE FUNCTION public.authorize_to_create_own_due_date_extension(_student_id uuid, _assignment_group_id bigint, _assignment_id bigint, _class_id bigint, _creator_id uuid, _hours_to_extend integer, _tokens_consumed integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE SECURITY DEFINER
SET search_path TO ''
AS $function$
declare
  tokens_used_this_assignment int;
  tokens_used_all_assignments int;
  tokens_remaining int;
  tokens_needed int;
  max_tokens_for_assignment int;
  private_profile_id uuid;
  existing_negative_exception boolean;
begin

  -- Validate that the declared number of tokens consumed is correct
  -- Use numeric division to avoid integer division truncation before ceil()
  tokens_needed := ceil(_hours_to_extend::numeric / 24);
  if tokens_needed != _tokens_consumed then
    return false;
  end if;

  select public.user_roles.private_profile_id from public.user_roles where user_id = auth.uid() and class_id = _class_id into private_profile_id;
  -- Make sure student is in the class and the creator of the extension
  if private_profile_id is null or private_profile_id != _creator_id then
    return false;
  end if;

  -- Serialize checks for this assignment + group/profile tuple against concurrent inserts.
  perform public.acquire_assignment_due_date_exception_lock(_assignment_id, _student_id, _assignment_group_id);

  -- Check if there's already a negative exception for this student/assignment_group + assignment + class
  -- Prevent ANY additional exception in that case
    select exists (
      select 1 from public.assignment_due_date_exceptions adde
      where (
        (_student_id is not null and adde.student_id is not null and _student_id = adde.student_id) or
        (_assignment_group_id is not null and adde.assignment_group_id is not null and _assignment_group_id = adde.assignment_group_id)
      )
      and adde.assignment_id = _assignment_id
      and adde.class_id = _class_id
      and adde.hours < 0
    ) into existing_negative_exception;

    if existing_negative_exception then
      return false;
    end if;

  select late_tokens_per_student from public.classes where id = _class_id into tokens_remaining;

  -- Make sure that the student is in the assignment group or matches the student_id
  if _assignment_group_id is not null then
    if not exists (select 1 from public.assignment_groups_members where assignment_group_id = _assignment_group_id and profile_id = private_profile_id) then
      return false;
    end if;
    select coalesce(sum(tokens_consumed), 0) from public.assignment_due_date_exceptions where assignment_group_id = _assignment_group_id and assignment_id = _assignment_id into tokens_used_this_assignment;
  else
    if private_profile_id != _student_id then
      return false;
    end if;
      select coalesce(sum(tokens_consumed), 0) from public.assignment_due_date_exceptions where student_id = _student_id and assignment_id = _assignment_id into tokens_used_this_assignment;
  end if;

  -- Calculate total tokens used across all assignments for this student
  -- Join with assignment_groups_members to get all assignment groups the student is in
  select coalesce(sum(adde.tokens_consumed), 0)
  from public.assignment_due_date_exceptions adde
  left join public.assignment_groups_members agm on agm.assignment_group_id = adde.assignment_group_id
  where adde.student_id = _student_id
     or agm.profile_id = private_profile_id
  into tokens_used_all_assignments;

  if tokens_used_all_assignments + tokens_needed > tokens_remaining then
    return false;
  end if;

  -- Verify assignment exists and belongs to the specified class before checking max_late_tokens
  select max_late_tokens from public.assignments where id=_assignment_id and class_id=_class_id into max_tokens_for_assignment;

  -- If assignment doesn't exist or class_id doesn't match, reject the request
  if max_tokens_for_assignment IS NULL then
    return false;
  end if;

  if tokens_used_this_assignment + tokens_needed > max_tokens_for_assignment then
    return false;
  end if;

  return true;
end;
$function$;

-- Harden extension fan-out functions that previously used NOT EXISTS + INSERT without locks.
CREATE OR REPLACE FUNCTION public.apply_extensions_to_new_assignment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_creator_profile_id uuid;
    v_extension_row record;
BEGIN
    SELECT private_profile_id INTO v_creator_profile_id
    FROM user_roles
    WHERE user_id = auth.uid()
      AND class_id = NEW.class_id
      AND disabled = false
    LIMIT 1;

    IF v_creator_profile_id IS NULL THEN
        RETURN NEW;
    END IF;

    FOR v_extension_row IN
        SELECT sde.student_id, sde.hours
        FROM student_deadline_extensions sde
        WHERE sde.class_id = NEW.class_id
          AND (sde.includes_lab = true OR NEW.minutes_due_after_lab IS NULL)
    LOOP
        PERFORM public.acquire_assignment_due_date_exception_lock(NEW.id, v_extension_row.student_id, NULL);

        IF NOT EXISTS (
            SELECT 1
            FROM assignment_due_date_exceptions ade
            WHERE ade.assignment_id = NEW.id
              AND ade.student_id = v_extension_row.student_id
        ) THEN
            INSERT INTO assignment_due_date_exceptions (
                assignment_id,
                student_id,
                class_id,
                creator_id,
                hours,
                minutes,
                tokens_consumed,
                note
            )
            VALUES (
                NEW.id,
                v_extension_row.student_id,
                NEW.class_id,
                v_creator_profile_id,
                v_extension_row.hours,
                0,
                0,
                'Instructor-granted extension for all assignments in class'
            );
        END IF;
    END LOOP;

    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_assignment_exceptions_from_extension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_creator_profile_id uuid;
    v_assignment_row record;
BEGIN
    SELECT private_profile_id INTO v_creator_profile_id
    FROM user_roles
    WHERE user_id = auth.uid()
      AND class_id = NEW.class_id
      AND disabled = false
    LIMIT 1;

    IF v_creator_profile_id IS NULL THEN
        SELECT private_profile_id INTO v_creator_profile_id
        FROM user_roles
        WHERE class_id = NEW.class_id
          AND role IN ('instructor', 'admin')
          AND disabled = false
        LIMIT 1;

        IF v_creator_profile_id IS NULL THEN
            RAISE WARNING 'No suitable profile found for creating extension exceptions in class %', NEW.class_id;
            RETURN NEW;
        END IF;
    END IF;

    FOR v_assignment_row IN
        SELECT a.id
        FROM assignments a
        WHERE a.class_id = NEW.class_id
          AND a.archived_at IS NULL
          AND (NEW.includes_lab = true OR a.minutes_due_after_lab IS NULL)
    LOOP
        PERFORM public.acquire_assignment_due_date_exception_lock(v_assignment_row.id, NEW.student_id, NULL);

        IF NOT EXISTS (
            SELECT 1 FROM assignment_due_date_exceptions ade
            WHERE ade.assignment_id = v_assignment_row.id
              AND ade.student_id = NEW.student_id
        ) THEN
            INSERT INTO assignment_due_date_exceptions (
                assignment_id,
                student_id,
                class_id,
                creator_id,
                hours,
                minutes,
                tokens_consumed,
                note
            )
            VALUES (
                v_assignment_row.id,
                NEW.student_id,
                NEW.class_id,
                v_creator_profile_id,
                NEW.hours,
                0,
                0,
                'Instructor-granted extension for all assignments in class'
            );
        END IF;
    END LOOP;

    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.create_assignment_exceptions_from_extension()
  SET search_path = public, pg_temp;
