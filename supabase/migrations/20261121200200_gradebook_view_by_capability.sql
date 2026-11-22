-- #1010: seeing the gradebook follows manage_gradebook too.
--
-- Why: the previous migration (20261121160100) moved arranging the gradebook to manage_gradebook,
-- but every grader could still read every score and override cells, by opening the gradebook from
-- search or its address. Now everything in the staff gradebook follows the one capability, so the
-- page, the database and the instructor's role settings agree.
--
-- What:
--   1. gradebook_column_students and gradebook_row_recalc_state: the staff SELECT and UPDATE
--      policies ("instructors and graders view all" / "edit") need manage_gradebook. The UPDATE
--      gets a WITH CHECK, so a row can't be moved to a class where the caller lacks it.
--   2. These SECURITY DEFINER functions check manage_gradebook instead of the grader check. Each
--      body is the latest one, with only the check (and its error message) changed:
--        get_gradebook_records_for_all_students and _array (still return [] when refused)
--        update_gradebook_column_student_with_recalc (overrides and "Convert Missing to 0"; the
--          service role still passes)
--        get_student_summary: only its private grades. The rest of the summary is unchanged.
--   3. manage_gradebook's description says what it covers now.
--
-- Who changes: instructors hold every capability, so nothing changes for them. Graders on the
-- default grader role, and custom roles without manage_gradebook, lose the staff gradebook,
-- overrides and Convert Missing to 0. A grader on a role with manage_gradebook keeps all of it.
--
-- Not changed: students reading their own released grades ("student views non-private only" on
-- both tables, the student gradebook and What-If), the structure tables (gradebook_columns,
-- gradebooks, column groups, topics), the default grader role, and seed_default_class_roles()
-- (manage_gradebook stays instructor-only by default). Triggers that recalculate cells run as
-- SECURITY DEFINER, so grading a submission still updates the gradebook.
--
-- Safe to run again: policies are dropped first and functions are replaced.

-- ---------------------------------------------------------------------------
-- 1. Staff reads and edits of cells and row state need manage_gradebook
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "instructors and graders view all" ON public.gradebook_column_students;
DROP POLICY IF EXISTS "instructors and graders edit" ON public.gradebook_column_students;
DROP POLICY IF EXISTS "Gradebook managers can view cells" ON public.gradebook_column_students;
DROP POLICY IF EXISTS "Gradebook managers can edit cells" ON public.gradebook_column_students;
CREATE POLICY "Gradebook managers can view cells" ON public.gradebook_column_students
  FOR SELECT TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));
CREATE POLICY "Gradebook managers can edit cells" ON public.gradebook_column_students
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')))
  WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));

DROP POLICY IF EXISTS "instructors and graders view all (row state)" ON public.gradebook_row_recalc_state;
DROP POLICY IF EXISTS "instructors and graders edit (row state)" ON public.gradebook_row_recalc_state;
DROP POLICY IF EXISTS "Gradebook managers can view row state" ON public.gradebook_row_recalc_state;
DROP POLICY IF EXISTS "Gradebook managers can edit row state" ON public.gradebook_row_recalc_state;
CREATE POLICY "Gradebook managers can view row state" ON public.gradebook_row_recalc_state
  FOR SELECT TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));
CREATE POLICY "Gradebook managers can edit row state" ON public.gradebook_row_recalc_state
  FOR UPDATE TO authenticated
  USING (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')))
  WITH CHECK (class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook')));

-- ---------------------------------------------------------------------------
-- 2. The functions check manage_gradebook
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE keeps each function's grants, so who may call it doesn't change.

-- 2a. The staff gradebook's records (body from 20260406120000_gradebook_columns_reorder_rpc.sql).

CREATE OR REPLACE FUNCTION public.get_gradebook_records_for_all_students(p_class_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
    IF p_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_gradebook')) THEN
        RETURN '[]'::jsonb;
    END IF;

    RETURN (
        SELECT COALESCE(jsonb_agg(student_data ORDER BY student_id), '[]'::jsonb)
        FROM (
            SELECT 
                gcs.student_id,
                jsonb_build_object(
                    'private_profile_id', gcs.student_id::text,
                    'entries', jsonb_agg(
                        jsonb_build_object(
                            'gcs_id', gcs.id,
                            'gc_id', gcs.gradebook_column_id,
                            'is_private', gcs.is_private,
                            'score', gcs.score,
                            'score_override', gcs.score_override,
                            'is_missing', gcs.is_missing,
                            'is_excused', gcs.is_excused,
                            'is_droppable', gcs.is_droppable,
                            'released', gcs.released,
                            'score_override_note', gcs.score_override_note,
                            'is_recalculating', gcs.is_recalculating,
                            'incomplete_values', gcs.incomplete_values,
                            'updated_at', to_jsonb(gcs.updated_at)
                        ) ORDER BY gc.sort_order ASC NULLS LAST, gc.id ASC
                    )
                ) as student_data
            FROM public.gradebook_column_students gcs
            INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
            WHERE gcs.class_id = p_class_id
            GROUP BY gcs.student_id
        ) grouped_data
    );
END;
$function$;

-- 2b. The same records as arrays (body from 20250927132135_gradebook_performance.sql).

CREATE OR REPLACE FUNCTION public.get_gradebook_records_for_all_students_array(p_class_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE PARALLEL SAFE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
    -- Early authorization guard - return immediately if unauthorized
    IF p_class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_gradebook')) THEN
        RETURN '[]'::jsonb;
    END IF;
    
    -- Only execute heavy query if authorized
    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'private_profile_id', student_id::text,
                'entries', entries_array
            ) ORDER BY student_id
        ), '[]'::jsonb)
        FROM (
            SELECT 
                gcs.student_id,
                jsonb_agg(
                    ARRAY[
                        gcs.id::text,
                        gcs.gradebook_column_id::text, 
                        gcs.is_private::text,
                        COALESCE(gcs.score::text, ''),
                        COALESCE(gcs.score_override::text, ''),
                        gcs.is_missing::text,
                        gcs.is_excused::text,
                        gcs.is_droppable::text,
                        gcs.released::text,
                        COALESCE(gcs.score_override_note, ''),
                        gcs.is_recalculating::text,
                        COALESCE(gcs.incomplete_values::text, '')
                    ] ORDER BY gc.sort_order ASC NULLS LAST, gc.id ASC
                ) as entries_array
            FROM public.gradebook_column_students gcs
            INNER JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
            WHERE gcs.class_id = p_class_id
            GROUP BY gcs.student_id
        ) array_data
    );
END;
$function$;

-- 2c. Overrides and "Convert Missing to 0" (body from 20261015120000_lock_down_security_definer_functions.sql).

CREATE OR REPLACE FUNCTION public.update_gradebook_column_student_with_recalc(p_id bigint, p_updates jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  updated_row public.gradebook_column_students%ROWTYPE;
  old_row public.gradebook_column_students%ROWTYPE;
  recalc_input_changed boolean;
BEGIN
  -- Lock the row while reading the pre-update snapshot so concurrent edits
  -- serialize and old_row reflects the latest committed value (not a stale
  -- pre-concurrent-writer snapshot). See migration header for the race.
  SELECT * INTO old_row
  FROM public.gradebook_column_students
  WHERE id = p_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gradebook_column_students row with id % not found', p_id;
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role'
     AND old_row.class_id NOT IN (SELECT public.user_class_ids_with_capability('manage_gradebook')) THEN
    RAISE EXCEPTION 'Access denied: manage_gradebook required for class %', old_row.class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.gradebook_column_students
  SET
    score = CASE WHEN p_updates ? 'score' THEN (p_updates->>'score')::numeric ELSE score END,
    score_override = CASE WHEN p_updates ? 'score_override' THEN (p_updates->>'score_override')::numeric ELSE score_override END,
    is_missing = CASE WHEN p_updates ? 'is_missing' THEN (p_updates->>'is_missing')::boolean ELSE is_missing END,
    is_excused = CASE WHEN p_updates ? 'is_excused' THEN (p_updates->>'is_excused')::boolean ELSE is_excused END,
    is_droppable = CASE WHEN p_updates ? 'is_droppable' THEN (p_updates->>'is_droppable')::boolean ELSE is_droppable END,
    released = CASE WHEN p_updates ? 'released' THEN (p_updates->>'released')::boolean ELSE released END,
    score_override_note = CASE WHEN p_updates ? 'score_override_note' THEN (p_updates->>'score_override_note')::text ELSE score_override_note END,
    incomplete_values = CASE WHEN p_updates ? 'incomplete_values' THEN p_updates->'incomplete_values' ELSE incomplete_values END
  WHERE id = p_id
  RETURNING * INTO updated_row;

  recalc_input_changed := (
    updated_row.score IS DISTINCT FROM old_row.score OR
    updated_row.score_override IS DISTINCT FROM old_row.score_override OR
    updated_row.is_missing IS DISTINCT FROM old_row.is_missing OR
    updated_row.is_droppable IS DISTINCT FROM old_row.is_droppable OR
    updated_row.is_excused IS DISTINCT FROM old_row.is_excused
  );

  IF recalc_input_changed THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(ARRAY[
      jsonb_build_object(
        'class_id', updated_row.class_id,
        'gradebook_id', updated_row.gradebook_id,
        'student_id', updated_row.student_id,
        'is_private', updated_row.is_private
      )
    ]);
  END IF;
END;
$function$;

-- 2d. The student summary on a student's profile page: only its private grades change (body from
--     20261015120000_lock_down_security_definer_functions.sql). Staff still see in-progress grading
--     totals in its assignments part, which is grading, not the gradebook.

CREATE OR REPLACE FUNCTION public.get_student_summary(p_class_id bigint, p_student_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_public_profile_id uuid;
  v_profile_ids uuid[];
  v_is_staff boolean;
  v_can_see_grades boolean;
begin
  -- Authorization: allow if caller is the student (private_profile) or staff (instructor/grader) in the class
  if not exists (
    select 1
    from public.user_privileges ur
    where ur.class_id = p_class_id
      and ur.user_id = auth.uid()
      and (
        ur.role in ('instructor','grader')
        or ur.private_profile_id = p_student_profile_id
      )
  ) then
    raise exception 'Access denied'
      using errcode = 'insufficient_privilege';
  end if;

  -- Staff (instructor/grader) may see in-progress grading totals; students may not see a
  -- grading review's scores until it is released (see join predicate below).
  select exists (
    select 1
    from public.user_privileges ur
    where ur.class_id = p_class_id
      and ur.user_id = auth.uid()
      and ur.role in ('instructor','grader')
  ) into v_is_staff;

  -- The gradebook's private grades follow manage_gradebook (#1010), like the gradebook itself.
  v_can_see_grades := p_class_id IN (SELECT public.user_class_ids_with_capability('manage_gradebook'));

  -- Resolve both profile IDs for the student in this class
  select up.public_profile_id
    into v_public_profile_id
    from public.user_privileges up
   where up.class_id = p_class_id
     and up.private_profile_id = p_student_profile_id
   limit 1;

  v_profile_ids := array_remove(ARRAY[p_student_profile_id, v_public_profile_id], NULL);

  -- Build JSON in parts
  with
  -- Recent help requests the student is a participant in this class (latest 50)
  help_requests as (
    select hr.id,
           hr.created_at,
           hr.help_queue,
           hr.request,
           hr.assignee,
           hr.resolved_by,
           hr.resolved_at,
           hr.is_private,
           hr.status
      from public.help_requests hr
      join public.help_request_students hrs on hrs.help_request_id = hr.id and hrs.class_id = hr.class_id
     where hr.class_id = p_class_id
       and hrs.profile_id = any (v_profile_ids)
     order by hr.created_at desc
     limit 50
  ),
  help_request_ids as (
    select id from help_requests
  ),
  -- Latest 50 messages authored by the student across all help requests in the class
  help_messages as (
    select hrm.id,
           hrm.created_at,
           hrm.author,
           hrm.message,
           hrm.instructors_only,
           hrm.help_request_id
      from public.help_request_messages hrm
     where hrm.class_id = p_class_id
       and hrm.author = any (v_profile_ids)
     order by hrm.created_at desc
     limit 50
  ),
  -- Recent discussion threads (student-authored) and replies (latest 50 each)
  discussion_posts as (
    select dt.id,
           dt.created_at,
           dt.subject,
           dt.body,
           dt.instructors_only,
           dt.parent,
           dt.root,
           dt.topic_id
      from public.discussion_threads dt
     where dt.class_id = p_class_id
       and dt.author = any (v_profile_ids)
       and dt.parent is null
     order by dt.created_at desc
     limit 50
  ),
  discussion_replies as (
    select dt.id,
           dt.created_at,
           dt.subject,
           dt.body,
           dt.instructors_only,
           dt.parent,
           dt.root,
           dt.topic_id
      from public.discussion_threads dt
     where dt.class_id = p_class_id
       and dt.author = any (v_profile_ids)
       and dt.parent is not null
     order by dt.created_at desc
     limit 50
  ),
  -- Assignment summary for released assignments
  assignments as (
    select a.id as assignment_id,
           a.title,
           a.release_date,
           public.calculate_final_due_date(a.id, p_student_profile_id, agm.assignment_group_id) as effective_due_date,
           a.total_points,
           s.id as submission_id,
           s.created_at as submission_timestamp,
           s.ordinal as submission_ordinal,
           sr.total_autograde_score as autograder_score,
           sr.total_score as total_score
      from public.assignments a
      left join public.assignment_groups_members agm
        on agm.assignment_id = a.id and agm.profile_id = any (v_profile_ids)
      left join public.submissions s
        on s.assignment_id = a.id
       and s.is_active = true
       and (
         (s.profile_id = any (v_profile_ids) and s.assignment_group_id is null)
         or (s.profile_id is null and s.assignment_group_id = agm.assignment_group_id)
       )
      -- Release gate: only join the grading review's scores for non-staff once it is
      -- released. Staff (v_is_staff) always see them; students see NULL until release.
      left join public.submission_reviews sr
        on sr.id = s.grading_review_id
       and (v_is_staff or sr.released = true)
     where a.class_id = p_class_id
       and a.release_date is not null
       and a.release_date <= now()
  ),
  -- Private grades only
  private_grades as (
    select gcs.gradebook_column_id,
           gcs.score,
           gcs.score_override,
           gcs.released,
           gcs.incomplete_values
      from public.gradebook_column_students gcs
     where gcs.class_id = p_class_id
       and gcs.student_id = p_student_profile_id
       and gcs.is_private = true
       and v_can_see_grades
  )
  select jsonb_build_object(
    'help_requests', coalesce(jsonb_agg(to_jsonb(help_requests) order by help_requests.created_at desc), '[]'::jsonb),
    'help_messages', coalesce((select jsonb_agg(to_jsonb(help_messages) order by help_messages.created_at desc) from help_messages), '[]'::jsonb),
    'discussion_posts', coalesce((select jsonb_agg(to_jsonb(discussion_posts) order by discussion_posts.created_at desc) from discussion_posts), '[]'::jsonb),
    'discussion_replies', coalesce((select jsonb_agg(to_jsonb(discussion_replies) order by discussion_replies.created_at desc) from discussion_replies), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(to_jsonb(assignments) order by assignments.effective_due_date asc nulls last) from assignments), '[]'::jsonb),
    'grades_private', coalesce((select jsonb_agg(to_jsonb(private_grades)) from private_grades), '[]'::jsonb)
  ) into v_result
  from help_requests
  limit 1;

  -- If no help requests existed, still build result from empty selects
  if v_result is null then
    select jsonb_build_object(
      'help_requests', '[]'::jsonb,
      'help_messages', coalesce((select jsonb_agg(to_jsonb(help_messages) order by help_messages.created_at desc) from help_messages), '[]'::jsonb),
      'discussion_posts', coalesce((select jsonb_agg(to_jsonb(discussion_posts) order by discussion_posts.created_at desc) from discussion_posts), '[]'::jsonb),
      'discussion_replies', coalesce((select jsonb_agg(to_jsonb(discussion_replies) order by discussion_replies.created_at desc) from discussion_replies), '[]'::jsonb),
      'assignments', coalesce((select jsonb_agg(to_jsonb(assignments) order by assignments.effective_due_date asc nulls last) from assignments), '[]'::jsonb),
      'grades_private', coalesce((select jsonb_agg(to_jsonb(private_grades)) from private_grades), '[]'::jsonb)
    ) into v_result;
  end if;

  return v_result;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. The capability's description
-- ---------------------------------------------------------------------------

UPDATE public.capabilities
SET description = 'See, edit, arrange, import and release the gradebook, including overrides and Convert Missing to 0'
WHERE name = 'manage_gradebook';
