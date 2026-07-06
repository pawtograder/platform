-- Grade students without submissions.
--
-- (1) Redefine submissions_with_grades_for_assignment_nice so every enrolled
--     student appears on the grader roster, even without an active submission
--     (LEFT JOIN submissions + a non_submitters CTE). Also expose
--     assignment_group_id so the UI can target the group when creating a stub.
-- (2) Generalize create_manual_submission to any repo_mode (not just
--     no_submission) and allow graders (not only instructors/admins) so
--     instructors and graders can "grade anyway".
-- (3) Add create_manual_submissions_for_non_submitters for the bulk-assign flow
--     to stub out an explicit list of profiles / groups in one call.

-- ============================================================================
-- (1) Roster view: include non-submitters
-- ============================================================================

DROP VIEW IF EXISTS public.submissions_with_grades_for_assignment_nice;

CREATE VIEW public.submissions_with_grades_for_assignment_nice WITH (security_invoker = 'true') AS
 WITH assignment_students AS (
         SELECT DISTINCT ur.id AS user_role_id,
            ur.private_profile_id, a.class_id, a.id AS assignment_id,
            a.due_date, a.slug AS assignment_slug,
            ur.class_section_id, ur.lab_section_id
           FROM public.assignments a
             JOIN public.user_roles ur ON ((ur.class_id = a.class_id AND ur.role = 'student'::public.app_role AND ur.disabled = false))
        ), individual_submissions AS (
         SELECT ast.user_role_id, ast.private_profile_id, ast.class_id,
            ast.assignment_id, s_1.id AS submission_id,
            NULL::bigint AS assignment_group_id, ast.due_date,
            ast.assignment_slug, ast.class_section_id, ast.lab_section_id
           FROM assignment_students ast
             JOIN public.submissions s_1 ON ((s_1.assignment_id = ast.assignment_id AND s_1.profile_id = ast.private_profile_id AND s_1.is_active = true AND s_1.assignment_group_id IS NULL))
        ), group_submissions AS (
         SELECT ast.user_role_id, ast.private_profile_id, ast.class_id,
            ast.assignment_id, s_1.id AS submission_id,
            agm.assignment_group_id, ast.due_date,
            ast.assignment_slug, ast.class_section_id, ast.lab_section_id
           FROM assignment_students ast
             JOIN public.assignment_groups_members agm ON ((agm.assignment_id = ast.assignment_id AND agm.profile_id = ast.private_profile_id))
             JOIN public.submissions s_1 ON ((s_1.assignment_id = ast.assignment_id AND s_1.assignment_group_id = agm.assignment_group_id AND s_1.is_active = true))
        ), submitters AS (
         SELECT individual_submissions.user_role_id FROM individual_submissions
        UNION
         SELECT group_submissions.user_role_id FROM group_submissions
        ), non_submitters AS (
         -- Every enrolled student with no active submission (individual or via
         -- their group). Carries assignment_group_id when the student is in a
         -- group so the UI can create a group-scoped stub.
         SELECT ast.user_role_id, ast.private_profile_id, ast.class_id,
            ast.assignment_id, NULL::bigint AS submission_id,
            agm.assignment_group_id, ast.due_date,
            ast.assignment_slug, ast.class_section_id, ast.lab_section_id
           FROM assignment_students ast
             LEFT JOIN public.assignment_groups_members agm ON ((agm.assignment_id = ast.assignment_id AND agm.profile_id = ast.private_profile_id))
          WHERE NOT (ast.user_role_id IN (SELECT submitters.user_role_id FROM submitters))
        ), all_submissions AS (
         SELECT * FROM individual_submissions
        UNION ALL
         SELECT * FROM group_submissions
        UNION ALL
         SELECT * FROM non_submitters
        ), due_date_extensions AS (
         SELECT COALESCE(ade.student_id, ag_1.profile_id) AS effective_student_id,
            COALESCE(ade.assignment_group_id, ag_1.assignment_group_id) AS effective_assignment_group_id,
            ade.assignment_id,
            sum(ade.tokens_consumed) AS tokens_consumed,
            sum(ade.hours) AS hours
           FROM public.assignment_due_date_exceptions ade
             LEFT JOIN public.assignment_groups_members ag_1 ON ((ade.assignment_group_id = ag_1.assignment_group_id))
          GROUP BY COALESCE(ade.student_id, ag_1.profile_id), COALESCE(ade.assignment_group_id, ag_1.assignment_group_id), ade.assignment_id
        ), submissions_with_extensions AS (
         SELECT asub.user_role_id, asub.private_profile_id, asub.class_id,
            asub.assignment_id, asub.submission_id, asub.assignment_group_id,
            asub.due_date, asub.assignment_slug,
            COALESCE(dde.tokens_consumed, (0)::bigint) AS tokens_consumed,
            COALESCE(dde.hours, (0)::bigint) AS hours,
            asub.class_section_id, asub.lab_section_id
           FROM all_submissions asub
             LEFT JOIN due_date_extensions dde ON (
               (dde.effective_student_id = asub.private_profile_id)
               AND (dde.assignment_id = asub.assignment_id)
               AND (
                 (asub.assignment_group_id IS NULL AND dde.effective_assignment_group_id IS NULL)
                 OR (asub.assignment_group_id = dde.effective_assignment_group_id)
               )
             )
        )
 SELECT swe.user_role_id AS id, swe.class_id, swe.assignment_id,
    p.id AS student_private_profile_id, p.name, p.sortable_name,
    s.id AS activesubmissionid, s.ordinal, s.created_at, s.released,
    s.repository, s.sha,
    rev.total_autograde_score AS autograder_score,
    rev.grader, rev.meta_grader, rev.total_score, rev.tweak,
    rev.completed_by, rev.completed_at, rev.checked_at, rev.checked_by,
    rev.individual_scores,
    rev.per_student_grading_totals,
    rev.per_student_grading_shared_base,
    graderprofile.name AS assignedgradername,
    metagraderprofile.name AS assignedmetagradername,
    completerprofile.name AS gradername,
    checkgraderprofile.name AS checkername,
    swe.assignment_group_id,
    ag.name AS groupname,
    mentorprofile.name AS assignment_group_mentor_name,
    swe.tokens_consumed, swe.hours, swe.due_date,
    (swe.due_date + ('01:00:00'::interval * (swe.hours)::double precision)) AS late_due_date,
    ar.grader_sha, ar.grader_action_sha,
    swe.assignment_slug, swe.class_section_id,
    cs.name AS class_section_name,
    swe.lab_section_id, ls.name AS lab_section_name
   FROM submissions_with_extensions swe
     JOIN public.profiles p ON ((p.id = swe.private_profile_id))
     LEFT JOIN public.submissions s ON ((s.id = swe.submission_id))
     LEFT JOIN public.submission_reviews rev ON ((rev.id = s.grading_review_id))
     LEFT JOIN public.grader_results ar ON ((ar.submission_id = s.id))
     LEFT JOIN public.assignment_groups ag ON ((ag.id = swe.assignment_group_id))
     LEFT JOIN public.profiles mentorprofile ON ((mentorprofile.id = ag.mentor_profile_id))
     LEFT JOIN public.profiles completerprofile ON ((completerprofile.id = rev.completed_by))
     LEFT JOIN public.profiles graderprofile ON ((graderprofile.id = rev.grader))
     LEFT JOIN public.profiles metagraderprofile ON ((metagraderprofile.id = rev.meta_grader))
     LEFT JOIN public.profiles checkgraderprofile ON ((checkgraderprofile.id = rev.checked_by))
     LEFT JOIN public.class_sections cs ON ((cs.id = swe.class_section_id))
     LEFT JOIN public.lab_sections ls ON ((ls.id = swe.lab_section_id));

ALTER VIEW public.submissions_with_grades_for_assignment_nice OWNER TO postgres;

-- ============================================================================
-- (2) Generalize create_manual_submission: any repo_mode, instructors + graders
-- ============================================================================

create or replace function public.create_manual_submission(
  p_assignment_id bigint,
  p_profile_id uuid default null,
  p_assignment_group_id bigint default null
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_class_id bigint;
  v_group_assignment_id bigint;
begin
  if v_user_id is null then
    raise exception 'Must be authenticated' using errcode = '42501';
  end if;

  if (p_profile_id is null) = (p_assignment_group_id is null) then
    raise exception 'Exactly one of p_profile_id or p_assignment_group_id must be provided';
  end if;

  select a.class_id
    into v_class_id
    from public.assignments a
   where a.id = p_assignment_id;

  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  -- Instructors and graders (and admins) can create a stub submission for any
  -- assignment so they can grade a student/group that has not submitted.
  if not exists (
    select 1 from public.user_privileges up
    where up.user_id = auth.uid()
      and (up.role = 'admin' or (up.class_id = v_class_id::bigint and up.role in ('instructor', 'grader')))
  ) then
    raise exception 'Access denied: only instructors and graders can create manual submissions for class %', v_class_id
      using errcode = '42501';
  end if;

  -- If a profile was passed, verify it belongs to a student enrolled in this
  -- assignment's class. The internal helper trusts p_profile_id, so this guard
  -- prevents creating a submission for a profile from another class.
  if p_profile_id is not null then
    if not exists (
      select 1 from public.user_roles ur
      where ur.class_id = v_class_id
        and ur.private_profile_id = p_profile_id
        and ur.role = 'student'
    ) then
      raise exception 'Profile % is not a student enrolled in class %', p_profile_id, v_class_id
        using errcode = '42501';
    end if;
  end if;

  -- If a group id was passed, verify it belongs to this assignment.
  if p_assignment_group_id is not null then
    select ag.assignment_id into v_group_assignment_id
      from public.assignment_groups ag
     where ag.id = p_assignment_group_id;
    if v_group_assignment_id is null then
      raise exception 'Assignment group % not found', p_assignment_group_id;
    end if;
    if v_group_assignment_id <> p_assignment_id then
      raise exception 'Assignment group % belongs to assignment %, not %',
        p_assignment_group_id, v_group_assignment_id, p_assignment_id;
    end if;
  end if;

  -- Validation done; the idempotent create itself lives in the no-auth internal
  -- helper so the auto-create triggers for no_submission assignments share one
  -- source of truth.
  return public.create_manual_submission_internal(p_assignment_id, p_profile_id, p_assignment_group_id);
end;
$$;

grant execute on function public.create_manual_submission(bigint, uuid, bigint) to authenticated;

-- ============================================================================
-- (3) Bulk stub creation for the bulk-assign flow.
--
-- Takes explicit lists of profiles and/or groups (so the caller can respect the
-- bulk-assign page's section/lab/tag filters instead of stubbing the whole
-- class) and returns every resulting submission id. Idempotent per target via
-- create_manual_submission_internal (returns the existing active submission id
-- where one is already in place).
-- ============================================================================

create or replace function public.create_manual_submissions_for_non_submitters(
  p_assignment_id bigint,
  p_profile_ids uuid[] default '{}',
  p_assignment_group_ids bigint[] default '{}'
) returns bigint[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_class_id bigint;
  v_profile_id uuid;
  v_group_id bigint;
  v_group_assignment_id bigint;
  v_submission_id bigint;
  v_result bigint[] := '{}';
begin
  if v_user_id is null then
    raise exception 'Must be authenticated' using errcode = '42501';
  end if;

  select a.class_id
    into v_class_id
    from public.assignments a
   where a.id = p_assignment_id;

  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  if not exists (
    select 1 from public.user_privileges up
    where up.user_id = auth.uid()
      and (up.role = 'admin' or (up.class_id = v_class_id::bigint and up.role in ('instructor', 'grader')))
  ) then
    raise exception 'Access denied: only instructors and graders can create manual submissions for class %', v_class_id
      using errcode = '42501';
  end if;

  if p_profile_ids is not null then
    foreach v_profile_id in array p_profile_ids
    loop
      -- The internal helper trusts the profile id, so verify each profile is a
      -- student enrolled in this class before creating a stub for it.
      if not exists (
        select 1 from public.user_roles ur
        where ur.class_id = v_class_id
          and ur.private_profile_id = v_profile_id
          and ur.role = 'student'
      ) then
        raise exception 'Profile % is not a student enrolled in class %', v_profile_id, v_class_id
          using errcode = '42501';
      end if;
      v_submission_id := public.create_manual_submission_internal(p_assignment_id, v_profile_id, null);
      v_result := array_append(v_result, v_submission_id);
    end loop;
  end if;

  if p_assignment_group_ids is not null then
    foreach v_group_id in array p_assignment_group_ids
    loop
      -- Verify each group belongs to this assignment before creating a stub.
      select ag.assignment_id into v_group_assignment_id
        from public.assignment_groups ag
       where ag.id = v_group_id;
      if v_group_assignment_id is null then
        raise exception 'Assignment group % not found', v_group_id;
      end if;
      if v_group_assignment_id <> p_assignment_id then
        raise exception 'Assignment group % belongs to assignment %, not %',
          v_group_id, v_group_assignment_id, p_assignment_id;
      end if;
      v_submission_id := public.create_manual_submission_internal(p_assignment_id, null, v_group_id);
      v_result := array_append(v_result, v_submission_id);
    end loop;
  end if;

  return v_result;
end;
$$;

grant execute on function public.create_manual_submissions_for_non_submitters(bigint, uuid[], bigint[]) to authenticated;
