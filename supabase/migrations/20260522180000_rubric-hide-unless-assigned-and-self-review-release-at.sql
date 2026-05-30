-- Rubric "hide unless assigned" + self-review explicit release_at.
--
-- 1. rubrics.hide_unless_assigned (boolean, default false): when true, students
--    cannot SELECT the rubric (or its parts/criteria/checks) until a
--    review_assignments row exists for them on that rubric and that row's
--    release_date has passed (or is NULL). Instructors/graders see rubrics
--    unconditionally.
--
-- 2. assignment_self_review_settings.release_at (timestamptz nullable): when
--    NULL (default), self-review release timing keeps current behavior --
--    review_assignments rows are created when the assignment's (per-student)
--    final due date passes. When set, release happens at the explicit
--    wall-clock time, exceptions are ignored for release timing, and the
--    review's own due_date is computed as release_at + deadline_offset hours.

----------------------------------------------------------------
-- Schema
----------------------------------------------------------------
ALTER TABLE public.rubrics
  ADD COLUMN hide_unless_assigned boolean NOT NULL DEFAULT false;

ALTER TABLE public.assignment_self_review_settings
  ADD COLUMN release_at timestamptz NULL;

----------------------------------------------------------------
-- RLS: rubrics SELECT
-- Non-graders may only see a rubric when hide_unless_assigned = false
-- OR they have an active (released) review_assignment for it.
----------------------------------------------------------------
ALTER POLICY "authorizeforclass"
ON public.rubrics
USING (
  EXISTS (
    SELECT 1
    FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
      AND up.class_id = rubrics.class_id
  )
  AND (
    EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND up.class_id = rubrics.class_id
        AND up.role IN ('instructor', 'grader')
    )
    OR (
      is_private = false
      AND (
        hide_unless_assigned = false
        OR EXISTS (
          SELECT 1
          FROM public.review_assignments ra
          JOIN public.user_privileges up ON up.private_profile_id = ra.assignee_profile_id
          WHERE ra.rubric_id = rubrics.id
            AND up.user_id = auth.uid()
            AND up.class_id = rubrics.class_id
            AND (ra.release_date IS NULL OR ra.release_date <= now())
        )
      )
    )
  )
);

----------------------------------------------------------------
-- RLS: rubric_parts SELECT
-- Mirror the parent rubric's gate.
----------------------------------------------------------------
ALTER POLICY "authorizeforclass"
ON public.rubric_parts
USING (
  EXISTS (
    SELECT 1
    FROM public.rubrics r
    WHERE r.id = rubric_parts.rubric_id
      AND authorizeforclass(r.class_id)
      AND (
        authorizeforclassgrader(r.class_id)
        OR (
          r.is_private = false
          AND (
            r.hide_unless_assigned = false
            OR EXISTS (
              SELECT 1
              FROM public.review_assignments ra
              JOIN public.user_privileges up ON up.private_profile_id = ra.assignee_profile_id
              WHERE ra.rubric_id = r.id
                AND up.user_id = auth.uid()
                AND up.class_id = r.class_id
                AND (ra.release_date IS NULL OR ra.release_date <= now())
            )
          )
        )
      )
  )
);

----------------------------------------------------------------
-- RLS: rubric_criteria SELECT
-- Mirror the parent rubric's gate so hidden rubrics don't leak criterion
-- names/descriptions/point totals to students before a review is assigned.
----------------------------------------------------------------
ALTER POLICY "authorizeforclass"
ON public.rubric_criteria
USING (
  EXISTS (
    SELECT 1
    FROM public.rubrics r
    WHERE r.id = rubric_criteria.rubric_id
      AND authorizeforclass(r.class_id)
      AND (
        authorizeforclassgrader(r.class_id)
        OR (
          r.is_private = false
          AND (
            r.hide_unless_assigned = false
            OR EXISTS (
              SELECT 1
              FROM public.review_assignments ra
              JOIN public.user_privileges up ON up.private_profile_id = ra.assignee_profile_id
              WHERE ra.rubric_id = r.id
                AND up.user_id = auth.uid()
                AND up.class_id = r.class_id
                AND (ra.release_date IS NULL OR ra.release_date <= now())
            )
          )
        )
      )
  )
);

----------------------------------------------------------------
-- RLS: rubric_checks "students see only based on visibility" SELECT
-- Same gate at the parent rubric level. Instructor/grader policy unchanged.
----------------------------------------------------------------
ALTER POLICY "students see only based on visibility" ON public.rubric_checks
USING (
  EXISTS (
    SELECT 1
    FROM public.rubric_criteria rc
    JOIN public.rubrics r ON r.id = rc.rubric_id
    WHERE rc.id = rubric_checks.rubric_criteria_id
      AND EXISTS (
        SELECT 1 FROM public.user_privileges up
        WHERE up.user_id = auth.uid()
          AND up.class_id = r.class_id
      )
      AND r.is_private = false
      AND (
        r.hide_unless_assigned = false
        OR EXISTS (
          SELECT 1
          FROM public.review_assignments ra
          JOIN public.user_privileges up ON up.private_profile_id = ra.assignee_profile_id
          WHERE ra.rubric_id = r.id
            AND up.user_id = auth.uid()
            AND up.class_id = r.class_id
            AND (ra.release_date IS NULL OR ra.release_date <= now())
        )
      )
      AND (
        rubric_checks.student_visibility = 'always'
        OR (
          rubric_checks.student_visibility = 'if_released'
          AND EXISTS (
            SELECT 1
            FROM public.submissions s
            JOIN public.submission_reviews sr ON sr.submission_id = s.id
            WHERE s.assignment_id = r.assignment_id
              AND sr.released = true
              AND (
                EXISTS (
                  SELECT 1 FROM public.user_privileges ur
                  WHERE ur.user_id = auth.uid()
                    AND ur.private_profile_id = s.profile_id
                )
                OR (
                  s.assignment_group_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM public.assignment_groups_members mem
                    JOIN public.user_privileges ur ON ur.private_profile_id = mem.profile_id
                    WHERE mem.assignment_group_id = s.assignment_group_id
                      AND ur.user_id = auth.uid()
                  )
                )
              )
          )
        )
        OR (
          rubric_checks.student_visibility = 'if_applied'
          AND (
            EXISTS (
              SELECT 1
              FROM public.submission_comments sc
              JOIN public.submissions s ON s.id = sc.submission_id
              WHERE sc.rubric_check_id = rubric_checks.id
                AND sc.released = true
                AND (
                  EXISTS (
                    SELECT 1 FROM public.user_privileges ur
                    WHERE ur.user_id = auth.uid()
                      AND ur.private_profile_id = s.profile_id
                  )
                  OR (
                    s.assignment_group_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM public.assignment_groups_members mem
                      JOIN public.user_privileges ur ON ur.private_profile_id = mem.profile_id
                      WHERE mem.assignment_group_id = s.assignment_group_id
                        AND ur.user_id = auth.uid()
                    )
                  )
                )
            )
            OR EXISTS (
              SELECT 1
              FROM public.submission_file_comments sfc
              JOIN public.submissions s ON s.id = sfc.submission_id
              WHERE sfc.rubric_check_id = rubric_checks.id
                AND sfc.released = true
                AND (
                  EXISTS (
                    SELECT 1 FROM public.user_privileges ur
                    WHERE ur.user_id = auth.uid()
                      AND ur.private_profile_id = s.profile_id
                  )
                  OR (
                    s.assignment_group_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM public.assignment_groups_members mem
                      JOIN public.user_privileges ur ON ur.private_profile_id = mem.profile_id
                      WHERE mem.assignment_group_id = s.assignment_group_id
                        AND ur.user_id = auth.uid()
                    )
                  )
                )
            )
            OR EXISTS (
              SELECT 1
              FROM public.submission_artifact_comments sac
              JOIN public.submissions s ON s.id = sac.submission_id
              JOIN public.submission_reviews sr ON sr.submission_id = s.id
              WHERE sac.rubric_check_id = rubric_checks.id
                AND sac.released = true
                AND (
                  EXISTS (
                    SELECT 1 FROM public.user_privileges ur
                    WHERE ur.user_id = auth.uid()
                      AND ur.private_profile_id = s.profile_id
                  )
                  OR (
                    s.assignment_group_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM public.assignment_groups_members mem
                      JOIN public.user_privileges ur ON ur.private_profile_id = mem.profile_id
                      WHERE mem.assignment_group_id = s.assignment_group_id
                        AND ur.user_id = auth.uid()
                    )
                  )
                )
            )
          )
        )
      )
  )
);

----------------------------------------------------------------
-- check_assignment_deadlines_passed(): self-review auto-assignment.
--
-- Rebased on the optimized CTE version (20251006232741): keeps
-- calculate_final_due_date (per-student/lab final due dates), the
-- disabled-student filter, the self_review_rubric_id guard, and the
-- 30-day/7-day window. Adds explicit release_at handling: when set, release
-- gates on release_at (exceptions ignored) and the review due_date is
-- release_at + deadline_offset.
----------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."check_assignment_deadlines_passed"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
    WITH eligible_assignments AS MATERIALIZED (
        -- Find assignments with self-review enabled AND recent deadlines.
        -- Window covers due_date OR explicit release_at in [NOW()-30d, NOW()+7d].
        SELECT
            a.id AS assignment_id,
            a.class_id,
            a.self_review_rubric_id,
            ars.deadline_offset,
            ars.release_at
        FROM assignments a
        INNER JOIN assignment_self_review_settings ars ON ars.id = a.self_review_setting_id
        WHERE a.archived_at IS NULL
            AND ars.enabled = true
            AND a.self_review_rubric_id IS NOT NULL
            AND (
                a.due_date BETWEEN (NOW() - INTERVAL '30 days') AND (NOW() + INTERVAL '7 days')
                OR (
                    ars.release_at IS NOT NULL
                    AND ars.release_at BETWEEN (NOW() - INTERVAL '30 days') AND (NOW() + INTERVAL '7 days')
                )
            )
    ),
    students_without_review_assignments AS MATERIALIZED (
        -- Pre-filter (student, assignment) pairs without a review assignment.
        SELECT DISTINCT
            ur.private_profile_id AS student_profile_id,
            ur.class_id,
            ea.assignment_id,
            ea.self_review_rubric_id,
            ea.deadline_offset,
            ea.release_at
        FROM user_roles ur
        CROSS JOIN eligible_assignments ea
        WHERE ur.role = 'student'
            AND ur.disabled = false
            AND ur.class_id = ea.class_id
            AND NOT EXISTS (
                SELECT 1 FROM review_assignments ra
                WHERE ra.assignment_id = ea.assignment_id
                    AND ra.assignee_profile_id = ur.private_profile_id
            )
    ),
    students_past_deadline AS (
        -- Individual submissions.
        SELECT DISTINCT
            sw.assignment_id,
            sw.class_id,
            sw.self_review_rubric_id,
            sw.deadline_offset,
            sw.release_at,
            sw.student_profile_id,
            s.id AS submission_id,
            NULL::bigint AS assignment_group_id
        FROM students_without_review_assignments sw
        INNER JOIN submissions s ON (
            s.assignment_id = sw.assignment_id
            AND s.profile_id = sw.student_profile_id
            AND s.is_active = true
            AND s.assignment_group_id IS NULL
        )
        WHERE (
            (sw.release_at IS NOT NULL AND sw.release_at <= NOW())
            OR (
                sw.release_at IS NULL
                AND public.calculate_final_due_date(sw.assignment_id, sw.student_profile_id, NULL) <= NOW()
            )
        )

        UNION ALL

        -- Group submissions.
        SELECT DISTINCT
            sw.assignment_id,
            sw.class_id,
            sw.self_review_rubric_id,
            sw.deadline_offset,
            sw.release_at,
            agm.profile_id AS student_profile_id,
            s.id AS submission_id,
            s.assignment_group_id
        FROM students_without_review_assignments sw
        INNER JOIN assignment_groups_members agm ON (
            agm.profile_id = sw.student_profile_id
            AND agm.assignment_id = sw.assignment_id
        )
        INNER JOIN submissions s ON (
            s.assignment_group_id = agm.assignment_group_id
            AND s.assignment_id = agm.assignment_id
            AND s.is_active = true
        )
        WHERE (
            (sw.release_at IS NOT NULL AND sw.release_at <= NOW())
            OR (
                sw.release_at IS NULL
                AND public.calculate_final_due_date(sw.assignment_id, agm.profile_id, s.assignment_group_id) <= NOW()
            )
        )
    ),
    missing_submission_reviews AS (
        -- Create any missing submission reviews first.
        INSERT INTO submission_reviews (total_score, released, tweak, class_id, submission_id, name, rubric_id)
        SELECT
            0, false, 0,
            spd.class_id,
            spd.submission_id,
            'Self Review',
            spd.self_review_rubric_id
        FROM students_past_deadline spd
        WHERE NOT EXISTS (
            SELECT 1 FROM submission_reviews sr
            WHERE sr.submission_id = spd.submission_id
                AND sr.rubric_id = spd.self_review_rubric_id
        )
        RETURNING id, submission_id, rubric_id, class_id
    )
    -- Create review assignments for ALL students past deadline.
    INSERT INTO review_assignments (
        due_date,
        assignee_profile_id,
        submission_id,
        submission_review_id,
        assignment_id,
        rubric_id,
        class_id
    )
    SELECT
        CASE
            WHEN spd.release_at IS NOT NULL
                THEN spd.release_at + (INTERVAL '1 hour' * spd.deadline_offset)
            ELSE public.calculate_final_due_date(spd.assignment_id, spd.student_profile_id, spd.assignment_group_id)
                + (INTERVAL '1 hour' * spd.deadline_offset)
        END,
        spd.student_profile_id,
        spd.submission_id,
        sr.id,
        spd.assignment_id,
        spd.self_review_rubric_id,
        spd.class_id
    FROM students_past_deadline spd
    INNER JOIN submission_reviews sr ON (
        sr.submission_id = spd.submission_id
        AND sr.rubric_id = spd.self_review_rubric_id
    );
END;
$$;

COMMENT ON FUNCTION public.check_assignment_deadlines_passed() IS
    'Optimized function to create self-review assignments when assignment deadlines pass. Uses CTEs for better performance. Honors assignment_self_review_settings.release_at: when set, gates release on release_at (ignoring exceptions) and sets the review due_date to release_at + deadline_offset; otherwise uses calculate_final_due_date.';

----------------------------------------------------------------
-- finalize_submission_early(): honor release_at.
--
-- Rebased on 20250703014545. When the assignment has an explicit
-- self-review release_at, an early finalize still must not surface a
-- hide_unless_assigned rubric before release_at: the created
-- review_assignment gets release_date = release_at (gating visibility via
-- RLS) and due_date = release_at + deadline_offset. When release_at IS NULL,
-- behavior is unchanged (release_date NULL, due_date = now + deadline_offset).
----------------------------------------------------------------
CREATE OR REPLACE FUNCTION finalize_submission_early(
    this_assignment_id bigint,
    this_profile_id uuid
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
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

    -- Calculate hours and minutes to subtract
    hours_to_subtract := -1 * EXTRACT(EPOCH FROM (this_assignment.due_date - utc_now)) / 3600;
    minutes_to_subtract := -1 * (EXTRACT(EPOCH FROM (this_assignment.due_date - utc_now)) % 3600) / 60;

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

----------------------------------------------------------------
-- update_rubric_full RPC: accept and persist hide_unless_assigned.
--
-- Rebased on 20260520140000 (foreign-id remapping + FK-safe leaf→root
-- deletes). Adds hide_unless_assigned: defaults to false on insert; on update
-- only overwrites when the key is present (COALESCE), so a stale caller that
-- omits the flag can't silently unhide a rubric.
----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_rubric_full(p_rubric jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_rubric_id bigint;
  v_class_id bigint;
  v_assignment_id bigint;
  v_review_round review_round;

  v_is_new_rubric boolean := false;
  v_broad_change boolean := false;

  v_old_name text;
  v_old_description text;
  v_old_is_private boolean;
  v_old_cap boolean;
  v_old_hide_unless_assigned boolean;

  v_new_name text;
  v_new_description text;
  v_new_is_private boolean;
  v_new_cap boolean;
  v_new_hide_unless_assigned boolean;

  v_parts_added int := 0;
  v_parts_updated int := 0;
  v_parts_removed int := 0;
  v_criteria_added int := 0;
  v_criteria_updated int := 0;
  v_criteria_removed int := 0;
  v_checks_added int := 0;
  v_checks_updated int := 0;
  v_checks_removed int := 0;
  v_checks_points_cascaded int := 0;
  v_refs_added int := 0;
  v_refs_removed int := 0;
  v_reviews_recomputed int := 0;
  v_foreign_ids_remapped int := 0;

  -- Input map key -> real DB id, after insert/update phases.
  v_part_id_map jsonb := '{}'::jsonb;
  v_criteria_id_map jsonb := '{}'::jsonb;
  v_check_id_map jsonb := '{}'::jsonb;

  v_part jsonb;
  v_criterion jsonb;
  v_check jsonb;
  v_ref jsonb;

  v_input_part_id bigint;
  v_input_criteria_id bigint;
  v_input_check_id bigint;
  v_part_id bigint;
  v_criteria_id bigint;
  v_check_id bigint;
  v_review_id bigint;

  v_part_ord int;
  v_crit_ord int;
  v_check_ord int;
  v_part_map_key text;
  v_criteria_map_key text;
  v_check_map_key text;

  v_points_changed_check_ids bigint[] := ARRAY[]::bigint[];
  v_removed_check_ids bigint[] := ARRAY[]::bigint[];
  v_affected_review_ids bigint[] := ARRAY[]::bigint[];

  v_old_total_points int;
  v_old_is_additive boolean;
  v_old_is_deduction_only boolean;
  v_old_points int;

  v_changes text[] := ARRAY[]::text[];
  v_summary text;
BEGIN
  v_rubric_id := NULLIF((p_rubric->>'id')::bigint, 0);
  v_class_id := (p_rubric->>'class_id')::bigint;
  v_assignment_id := (p_rubric->>'assignment_id')::bigint;
  v_review_round := (p_rubric->>'review_round')::review_round;
  v_new_name := p_rubric->>'name';
  v_new_description := p_rubric->>'description';
  v_new_is_private := COALESCE((p_rubric->>'is_private')::boolean, false);
  v_new_cap := COALESCE((p_rubric->>'cap_score_to_assignment_points')::boolean, false);
  -- NULL when the key is absent: only overwrite hide_unless_assigned on update
  -- when the caller actually sent it.
  v_new_hide_unless_assigned := CASE
    WHEN p_rubric ? 'hide_unless_assigned'
    THEN (p_rubric->>'hide_unless_assigned')::boolean
  END;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'class_id is required';
  END IF;
  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Not authorized to edit rubrics in this class';
  END IF;
  IF v_new_name IS NULL OR length(trim(v_new_name)) = 0 THEN
    RAISE EXCEPTION 'Rubric name is required';
  END IF;

  IF v_rubric_id IS NULL THEN
    INSERT INTO public.rubrics (
      name, description, assignment_id, class_id, is_private, review_round,
      cap_score_to_assignment_points, hide_unless_assigned
    )
    VALUES (
      v_new_name, v_new_description, v_assignment_id, v_class_id, v_new_is_private,
      v_review_round, v_new_cap, COALESCE(v_new_hide_unless_assigned, false)
    )
    RETURNING id INTO v_rubric_id;
    v_is_new_rubric := true;
    v_broad_change := true;
  ELSE
    SELECT name, description, is_private, cap_score_to_assignment_points, hide_unless_assigned
    INTO v_old_name, v_old_description, v_old_is_private, v_old_cap, v_old_hide_unless_assigned
    FROM public.rubrics
    WHERE id = v_rubric_id AND class_id = v_class_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rubric % not found in class %', v_rubric_id, v_class_id;
    END IF;

    IF v_old_name IS DISTINCT FROM v_new_name
       OR v_old_description IS DISTINCT FROM v_new_description
       OR v_old_is_private IS DISTINCT FROM v_new_is_private
       OR v_old_cap IS DISTINCT FROM v_new_cap
       OR (v_new_hide_unless_assigned IS NOT NULL AND v_old_hide_unless_assigned IS DISTINCT FROM v_new_hide_unless_assigned) THEN
      UPDATE public.rubrics
      SET name = v_new_name,
          description = v_new_description,
          is_private = v_new_is_private,
          cap_score_to_assignment_points = v_new_cap,
          hide_unless_assigned = COALESCE(v_new_hide_unless_assigned, hide_unless_assigned)
      WHERE id = v_rubric_id;
    END IF;

    IF v_old_cap IS DISTINCT FROM v_new_cap THEN
      v_broad_change := true;
    END IF;
  END IF;

  ----------------------------------------------------------------
  -- Phase 0: deletes (leaf → root). FKs on rubric_criteria→parts and
  -- rubric_checks→criteria are NO ACTION, so we must remove checks before
  -- criteria before parts. rubric_check_references CASCADE when checks go.
  ----------------------------------------------------------------
  WITH input_check_ids AS (
    SELECT (chk->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
         jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
         jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk
    WHERE COALESCE((chk->>'id')::bigint, 0) > 0
      AND EXISTS (
        SELECT 1 FROM public.rubric_checks rc
        WHERE rc.id = (chk->>'id')::bigint AND rc.rubric_id = v_rubric_id
      )
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::bigint[]) INTO v_removed_check_ids
  FROM public.rubric_checks
  WHERE rubric_id = v_rubric_id
    AND id NOT IN (SELECT id FROM input_check_ids);

  IF array_length(v_removed_check_ids, 1) > 0 THEN
    DELETE FROM public.rubric_checks WHERE id = ANY(v_removed_check_ids);
    v_checks_removed := array_length(v_removed_check_ids, 1);
    v_broad_change := true;
  END IF;

  WITH input_criteria_ids AS (
    SELECT (crit->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
         jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit
    WHERE COALESCE((crit->>'id')::bigint, 0) > 0
      AND EXISTS (
        SELECT 1 FROM public.rubric_criteria rc
        WHERE rc.id = (crit->>'id')::bigint AND rc.rubric_id = v_rubric_id
      )
  ),
  del AS (
    DELETE FROM public.rubric_criteria
    WHERE rubric_id = v_rubric_id
      AND id NOT IN (SELECT id FROM input_criteria_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_criteria_removed FROM del;

  IF v_criteria_removed > 0 THEN
    v_broad_change := true;
  END IF;

  WITH input_part_ids AS (
    SELECT (elem->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) elem
    WHERE COALESCE((elem->>'id')::bigint, 0) > 0
      AND EXISTS (
        SELECT 1 FROM public.rubric_parts rp
        WHERE rp.id = (elem->>'id')::bigint AND rp.rubric_id = v_rubric_id
      )
  ),
  del AS (
    DELETE FROM public.rubric_parts
    WHERE rubric_id = v_rubric_id
      AND id NOT IN (SELECT id FROM input_part_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_parts_removed FROM del;

  IF v_parts_removed > 0 THEN
    v_broad_change := true;
  END IF;

  ----------------------------------------------------------------
  -- Phase 1: upsert parts.
  ----------------------------------------------------------------
  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);

    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;

      UPDATE public.rubric_parts
      SET name = v_part->>'name',
          description = v_part->>'description',
          ordinal = COALESCE((v_part->>'ordinal')::int, 0),
          data = v_part->'data',
          is_individual_grading = COALESCE((v_part->>'is_individual_grading')::boolean, false),
          is_assign_to_student = COALESCE((v_part->>'is_assign_to_student')::boolean, false)
      WHERE id = v_input_part_id AND rubric_id = v_rubric_id;

      v_part_id := v_input_part_id;
      v_parts_updated := v_parts_updated + 1;
    ELSE
      IF v_input_part_id > 0 THEN
        v_foreign_ids_remapped := v_foreign_ids_remapped + 1;
      END IF;
      v_part_map_key := 'new_part_' || v_part_ord::text;

      INSERT INTO public.rubric_parts (
        name, description, ordinal, rubric_id, class_id, assignment_id,
        data, is_individual_grading, is_assign_to_student
      ) VALUES (
        v_part->>'name',
        v_part->>'description',
        COALESCE((v_part->>'ordinal')::int, 0),
        v_rubric_id, v_class_id, v_assignment_id,
        v_part->'data',
        COALESCE((v_part->>'is_individual_grading')::boolean, false),
        COALESCE((v_part->>'is_assign_to_student')::boolean, false)
      ) RETURNING id INTO v_part_id;

      v_parts_added := v_parts_added + 1;
      v_broad_change := true;
    END IF;

    v_part_id_map := v_part_id_map || jsonb_build_object(v_part_map_key, v_part_id);
  END LOOP;

  ----------------------------------------------------------------
  -- Phase 2: upsert criteria.
  ----------------------------------------------------------------
  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;
    ELSE
      v_part_map_key := 'new_part_' || v_part_ord::text;
    END IF;
    v_part_id := (v_part_id_map->>v_part_map_key)::bigint;

    FOR v_criterion, v_crit_ord IN
      SELECT elem, ord::int
      FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);

      IF v_input_criteria_id > 0
         AND EXISTS (
           SELECT 1 FROM public.rubric_criteria
           WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id
         ) THEN
        v_criteria_map_key := v_input_criteria_id::text;

        SELECT total_points, is_additive, is_deduction_only
        INTO v_old_total_points, v_old_is_additive, v_old_is_deduction_only
        FROM public.rubric_criteria WHERE id = v_input_criteria_id;

        IF v_old_total_points IS DISTINCT FROM COALESCE((v_criterion->>'total_points')::int, 0)
           OR v_old_is_additive IS DISTINCT FROM COALESCE((v_criterion->>'is_additive')::boolean, false)
           OR v_old_is_deduction_only IS DISTINCT FROM COALESCE((v_criterion->>'is_deduction_only')::boolean, false) THEN
          v_broad_change := true;
        END IF;

        UPDATE public.rubric_criteria
        SET name = v_criterion->>'name',
            description = v_criterion->>'description',
            ordinal = COALESCE((v_criterion->>'ordinal')::int, 0),
            rubric_part_id = v_part_id,
            data = v_criterion->'data',
            is_additive = COALESCE((v_criterion->>'is_additive')::boolean, false),
            is_deduction_only = COALESCE((v_criterion->>'is_deduction_only')::boolean, false),
            total_points = COALESCE((v_criterion->>'total_points')::int, 0),
            max_checks_per_submission = NULLIF(v_criterion->>'max_checks_per_submission', '')::int,
            min_checks_per_submission = NULLIF(v_criterion->>'min_checks_per_submission', '')::int
        WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id;

        v_criteria_id := v_input_criteria_id;
        v_criteria_updated := v_criteria_updated + 1;
      ELSE
        IF v_input_criteria_id > 0 THEN
          v_foreign_ids_remapped := v_foreign_ids_remapped + 1;
        END IF;
        v_criteria_map_key := 'new_crit_' || v_part_ord::text || '_' || v_crit_ord::text;

        INSERT INTO public.rubric_criteria (
          name, description, ordinal, rubric_id, rubric_part_id, class_id, assignment_id,
          data, is_additive, is_deduction_only, total_points,
          max_checks_per_submission, min_checks_per_submission
        ) VALUES (
          v_criterion->>'name',
          v_criterion->>'description',
          COALESCE((v_criterion->>'ordinal')::int, 0),
          v_rubric_id, v_part_id, v_class_id, v_assignment_id,
          v_criterion->'data',
          COALESCE((v_criterion->>'is_additive')::boolean, false),
          COALESCE((v_criterion->>'is_deduction_only')::boolean, false),
          COALESCE((v_criterion->>'total_points')::int, 0),
          NULLIF(v_criterion->>'max_checks_per_submission', '')::int,
          NULLIF(v_criterion->>'min_checks_per_submission', '')::int
        ) RETURNING id INTO v_criteria_id;

        v_criteria_added := v_criteria_added + 1;
        v_broad_change := true;
      END IF;

      v_criteria_id_map := v_criteria_id_map || jsonb_build_object(v_criteria_map_key, v_criteria_id);
    END LOOP;
  END LOOP;

  ----------------------------------------------------------------
  -- Phase 3: upsert checks.
  ----------------------------------------------------------------
  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;
    ELSE
      v_part_map_key := 'new_part_' || v_part_ord::text;
    END IF;

    FOR v_criterion, v_crit_ord IN
      SELECT elem, ord::int
      FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);
      IF v_input_criteria_id > 0
         AND EXISTS (
           SELECT 1 FROM public.rubric_criteria
           WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id
         ) THEN
        v_criteria_map_key := v_input_criteria_id::text;
      ELSE
        v_criteria_map_key := 'new_crit_' || v_part_ord::text || '_' || v_crit_ord::text;
      END IF;
      v_criteria_id := (v_criteria_id_map->>v_criteria_map_key)::bigint;

      FOR v_check, v_check_ord IN
        SELECT elem, ord::int
        FROM jsonb_array_elements(COALESCE(v_criterion->'checks', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      LOOP
        v_input_check_id := COALESCE((v_check->>'id')::bigint, 0);

        IF v_input_check_id > 0
           AND EXISTS (
             SELECT 1 FROM public.rubric_checks
             WHERE id = v_input_check_id AND rubric_id = v_rubric_id
           ) THEN
          v_check_map_key := v_input_check_id::text;

          SELECT points INTO v_old_points
          FROM public.rubric_checks WHERE id = v_input_check_id;

          IF v_old_points IS DISTINCT FROM COALESCE((v_check->>'points')::int, 0) THEN
            v_points_changed_check_ids := array_append(v_points_changed_check_ids, v_input_check_id);
          END IF;

          UPDATE public.rubric_checks
          SET name = v_check->>'name',
              description = v_check->>'description',
              ordinal = COALESCE((v_check->>'ordinal')::int, 0),
              rubric_criteria_id = v_criteria_id,
              data = v_check->'data',
              file = v_check->>'file',
              artifact = v_check->>'artifact',
              "group" = v_check->>'group',
              is_annotation = COALESCE((v_check->>'is_annotation')::boolean, false),
              is_comment_required = COALESCE((v_check->>'is_comment_required')::boolean, false),
              is_required = COALESCE((v_check->>'is_required')::boolean, false),
              max_annotations = NULLIF(v_check->>'max_annotations', '')::int,
              points = COALESCE((v_check->>'points')::int, 0),
              annotation_target = v_check->>'annotation_target',
              student_visibility = COALESCE(
                (v_check->>'student_visibility')::rubric_check_student_visibility,
                'always'::rubric_check_student_visibility
              ),
              kpi_category = NULLIF(v_check->>'kpi_category', '')::repo_analytics_kpi_category
          WHERE id = v_input_check_id AND rubric_id = v_rubric_id;

          v_check_id := v_input_check_id;
          v_checks_updated := v_checks_updated + 1;
        ELSE
          IF v_input_check_id > 0 THEN
            v_foreign_ids_remapped := v_foreign_ids_remapped + 1;
          END IF;
          v_check_map_key := 'new_check_' || v_part_ord::text || '_' || v_crit_ord::text || '_' || v_check_ord::text;

          INSERT INTO public.rubric_checks (
            name, description, ordinal, rubric_criteria_id, rubric_id, class_id, assignment_id,
            data, file, artifact, "group",
            is_annotation, is_comment_required, is_required,
            max_annotations, points, annotation_target, student_visibility, kpi_category
          ) VALUES (
            v_check->>'name',
            v_check->>'description',
            COALESCE((v_check->>'ordinal')::int, 0),
            v_criteria_id, v_rubric_id, v_class_id, v_assignment_id,
            v_check->'data',
            v_check->>'file',
            v_check->>'artifact',
            v_check->>'group',
            COALESCE((v_check->>'is_annotation')::boolean, false),
            COALESCE((v_check->>'is_comment_required')::boolean, false),
            COALESCE((v_check->>'is_required')::boolean, false),
            NULLIF(v_check->>'max_annotations', '')::int,
            COALESCE((v_check->>'points')::int, 0),
            v_check->>'annotation_target',
            COALESCE((v_check->>'student_visibility')::rubric_check_student_visibility, 'always'::rubric_check_student_visibility),
            NULLIF(v_check->>'kpi_category', '')::repo_analytics_kpi_category
          ) RETURNING id INTO v_check_id;

          v_checks_added := v_checks_added + 1;
          v_broad_change := true;
        END IF;

        v_check_id_map := v_check_id_map || jsonb_build_object(v_check_map_key, v_check_id);
      END LOOP;
    END LOOP;
  END LOOP;

  IF array_length(v_points_changed_check_ids, 1) > 0 THEN
    UPDATE public.submission_comments sc
    SET points = rc.points
    FROM public.rubric_checks rc
    WHERE sc.rubric_check_id = rc.id
      AND rc.id = ANY(v_points_changed_check_ids);

    UPDATE public.submission_file_comments sfc
    SET points = rc.points
    FROM public.rubric_checks rc
    WHERE sfc.rubric_check_id = rc.id
      AND rc.id = ANY(v_points_changed_check_ids);

    UPDATE public.submission_artifact_comments sac
    SET points = rc.points
    FROM public.rubric_checks rc
    WHERE sac.rubric_check_id = rc.id
      AND rc.id = ANY(v_points_changed_check_ids);

    v_checks_points_cascaded := array_length(v_points_changed_check_ids, 1);
  END IF;

  ----------------------------------------------------------------
  -- Phase 4: rubric_check_references.
  ----------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _desired_refs (
    referencing_check_id bigint NOT NULL,
    referenced_check_id bigint NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE _desired_refs;

  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;
    ELSE
      v_part_map_key := 'new_part_' || v_part_ord::text;
    END IF;

    FOR v_criterion, v_crit_ord IN
      SELECT elem, ord::int
      FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);
      IF v_input_criteria_id > 0
         AND EXISTS (
           SELECT 1 FROM public.rubric_criteria
           WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id
         ) THEN
        v_criteria_map_key := v_input_criteria_id::text;
      ELSE
        v_criteria_map_key := 'new_crit_' || v_part_ord::text || '_' || v_crit_ord::text;
      END IF;

      FOR v_check, v_check_ord IN
        SELECT elem, ord::int
        FROM jsonb_array_elements(COALESCE(v_criterion->'checks', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      LOOP
        v_input_check_id := COALESCE((v_check->>'id')::bigint, 0);
        IF v_input_check_id > 0
           AND EXISTS (
             SELECT 1 FROM public.rubric_checks
             WHERE id = v_input_check_id AND rubric_id = v_rubric_id
           ) THEN
          v_check_map_key := v_input_check_id::text;
        ELSE
          v_check_map_key := 'new_check_' || v_part_ord::text || '_' || v_crit_ord::text || '_' || v_check_ord::text;
        END IF;
        v_check_id := (v_check_id_map->>v_check_map_key)::bigint;

        FOR v_ref IN SELECT * FROM jsonb_array_elements(COALESCE(v_check->'references', '[]'::jsonb))
        LOOP
          INSERT INTO _desired_refs (referencing_check_id, referenced_check_id)
          VALUES (v_check_id, (v_ref->>'referenced_rubric_check_id')::bigint);
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;

  WITH del AS (
    DELETE FROM public.rubric_check_references rcr
    WHERE rcr.rubric_id = v_rubric_id
      AND NOT EXISTS (
        SELECT 1 FROM _desired_refs d
        WHERE d.referencing_check_id = rcr.referencing_rubric_check_id
          AND d.referenced_check_id = rcr.referenced_rubric_check_id
      )
    RETURNING id
  )
  SELECT count(*) INTO v_refs_removed FROM del;

  WITH ins AS (
    INSERT INTO public.rubric_check_references (
      referencing_rubric_check_id, referenced_rubric_check_id,
      rubric_id, class_id, assignment_id
    )
    SELECT d.referencing_check_id, d.referenced_check_id,
           v_rubric_id, v_class_id, v_assignment_id
    FROM _desired_refs d
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rubric_check_references rcr
      WHERE rcr.referencing_rubric_check_id = d.referencing_check_id
        AND rcr.referenced_rubric_check_id = d.referenced_check_id
        AND rcr.rubric_id = v_rubric_id
    )
    RETURNING id
  )
  SELECT count(*) INTO v_refs_added FROM ins;

  IF v_is_new_rubric THEN
    v_affected_review_ids := ARRAY[]::bigint[];
  ELSIF v_broad_change THEN
    SELECT COALESCE(array_agg(DISTINCT sr.id), ARRAY[]::bigint[])
    INTO v_affected_review_ids
    FROM public.submission_reviews sr
    WHERE sr.rubric_id = v_rubric_id;
  ELSE
    WITH touched_check_ids AS (
      SELECT unnest(v_points_changed_check_ids || v_removed_check_ids) AS id
    ),
    touched AS (
      SELECT submission_review_id FROM public.submission_comments
      WHERE rubric_check_id IN (SELECT id FROM touched_check_ids)
        AND deleted_at IS NULL AND submission_review_id IS NOT NULL
      UNION
      SELECT submission_review_id FROM public.submission_file_comments
      WHERE rubric_check_id IN (SELECT id FROM touched_check_ids)
        AND deleted_at IS NULL AND submission_review_id IS NOT NULL
      UNION
      SELECT submission_review_id FROM public.submission_artifact_comments
      WHERE rubric_check_id IN (SELECT id FROM touched_check_ids)
        AND deleted_at IS NULL AND submission_review_id IS NOT NULL
    )
    SELECT COALESCE(array_agg(DISTINCT submission_review_id), ARRAY[]::bigint[])
    INTO v_affected_review_ids
    FROM touched;
  END IF;

  FOREACH v_review_id IN ARRAY v_affected_review_ids LOOP
    PERFORM public._submission_review_recompute_scores(v_review_id);
    v_reviews_recomputed := v_reviews_recomputed + 1;
  END LOOP;

  v_summary := CASE WHEN v_is_new_rubric THEN 'Created rubric.' ELSE 'Saved rubric.' END;

  IF v_parts_added > 0 THEN v_changes := v_changes || (v_parts_added || ' part' || CASE WHEN v_parts_added = 1 THEN '' ELSE 's' END || ' added'); END IF;
  IF v_parts_updated > 0 THEN v_changes := v_changes || (v_parts_updated || ' part' || CASE WHEN v_parts_updated = 1 THEN '' ELSE 's' END || ' updated'); END IF;
  IF v_parts_removed > 0 THEN v_changes := v_changes || (v_parts_removed || ' part' || CASE WHEN v_parts_removed = 1 THEN '' ELSE 's' END || ' removed'); END IF;
  IF v_criteria_added > 0 THEN v_changes := v_changes || (v_criteria_added || ' criteri' || CASE WHEN v_criteria_added = 1 THEN 'on' ELSE 'a' END || ' added'); END IF;
  IF v_criteria_updated > 0 THEN v_changes := v_changes || (v_criteria_updated || ' criteri' || CASE WHEN v_criteria_updated = 1 THEN 'on' ELSE 'a' END || ' updated'); END IF;
  IF v_criteria_removed > 0 THEN v_changes := v_changes || (v_criteria_removed || ' criteri' || CASE WHEN v_criteria_removed = 1 THEN 'on' ELSE 'a' END || ' removed'); END IF;
  IF v_checks_added > 0 THEN v_changes := v_changes || (v_checks_added || ' check' || CASE WHEN v_checks_added = 1 THEN '' ELSE 's' END || ' added'); END IF;
  IF v_checks_updated > 0 THEN v_changes := v_changes || (v_checks_updated || ' check' || CASE WHEN v_checks_updated = 1 THEN '' ELSE 's' END || ' updated'); END IF;
  IF v_checks_removed > 0 THEN v_changes := v_changes || (v_checks_removed || ' check' || CASE WHEN v_checks_removed = 1 THEN '' ELSE 's' END || ' removed'); END IF;
  IF v_refs_added > 0 THEN v_changes := v_changes || (v_refs_added || ' reference' || CASE WHEN v_refs_added = 1 THEN '' ELSE 's' END || ' added'); END IF;
  IF v_refs_removed > 0 THEN v_changes := v_changes || (v_refs_removed || ' reference' || CASE WHEN v_refs_removed = 1 THEN '' ELSE 's' END || ' removed'); END IF;

  IF array_length(v_changes, 1) > 0 THEN
    v_summary := v_summary || ' ' || array_to_string(v_changes, ', ') || '.';
  ELSIF NOT v_is_new_rubric THEN
    v_summary := v_summary || ' No structural changes.';
  END IF;

  IF v_foreign_ids_remapped > 0 THEN
    v_summary := v_summary || ' ' || v_foreign_ids_remapped || ' item(s) with unrecognized ids treated as new.';
  END IF;

  IF v_checks_points_cascaded > 0 THEN
    v_summary := v_summary || ' Cascaded new points to existing comments on '
              || v_checks_points_cascaded || ' check'
              || CASE WHEN v_checks_points_cascaded = 1 THEN '' ELSE 's' END || '.';
  END IF;

  IF v_reviews_recomputed > 0 THEN
    v_summary := v_summary || ' Recomputed scores on '
              || v_reviews_recomputed || ' submission review'
              || CASE WHEN v_reviews_recomputed = 1 THEN '' ELSE 's' END || '.';
  END IF;

  RETURN v_summary;
END;
$function$;

COMMENT ON FUNCTION public.update_rubric_full(jsonb) IS
  'Atomically apply a hydrated rubric (top-level fields + parts/criteria/checks/references) in one transaction, cascade points changes to existing comments, recompute affected submission_reviews, and return a friendly summary. Positive ids not owned by the target rubric are inserted as new rows (copy/paste YAML). Removes checks before criteria before parts to satisfy FK constraints. Persists hide_unless_assigned (default false on insert; only overwritten on update when the key is present).';
