-- Placeholder submissions: stored flag + roster exposure.
--
-- Every instructor/grader-created stub (submitted_via='manual', no repo/sha) is
-- a placeholder: content-less, created so a grade can be applied without a real
-- student submission. This covers "grade anyway" stubs on normal assignments
-- and the auto-created stubs on no_submission assignments (presentations, oral
-- exams). create_manual_submission_internal is the only insert point for such
-- stubs, so flag every one there. Real submissions (git / uploaded files) keep
-- the default false.

alter table public.submissions
  add column if not exists is_placeholder boolean not null default false;

comment on column public.submissions.is_placeholder is
  'True for instructor/grader-created stub submissions (submitted_via=''manual'') that stand in for a real student submission so a grade can be applied.';

-- ============================================================================
-- Flag every manual stub as a placeholder at its single insert point.
-- ============================================================================

create or replace function public.create_manual_submission_internal(
  p_assignment_id bigint,
  p_profile_id uuid default null,
  p_assignment_group_id bigint default null
) returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_class_id bigint;
  v_existing bigint;
  v_submission_id bigint;
  v_ordinal int;
begin
  if (p_profile_id is null) = (p_assignment_group_id is null) then
    raise exception 'Exactly one of p_profile_id or p_assignment_group_id must be provided';
  end if;

  select a.class_id into v_class_id from public.assignments a where a.id = p_assignment_id;
  if v_class_id is null then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;

  -- Serialize concurrent creates for this assignment + submitter scope so we
  -- can't produce duplicate ordinals or end up with multiple active rows.
  perform pg_advisory_xact_lock(
    hashtextextended(
      format(
        'create_manual_submission:%s:%s:%s',
        p_assignment_id,
        coalesce(p_assignment_group_id::text, ''),
        coalesce(p_profile_id::text, '')
      ),
      0
    )
  );

  -- Idempotent: reuse the existing active submission if one is already in place.
  select id into v_existing
    from public.submissions
   where assignment_id = p_assignment_id
     and is_active = true
     and (
       (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
       or (p_assignment_group_id is null and profile_id = p_profile_id and assignment_group_id is null)
     )
   limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  -- Deactivate any conflicting active submission in the *other* scope for the
  -- same target, so a student can't end up with both a per-profile and a
  -- per-group active submission on this assignment.
  if p_assignment_group_id is not null then
    update public.submissions s
       set is_active = false
     where s.assignment_id = p_assignment_id
       and s.is_active = true
       and s.assignment_group_id is null
       and s.profile_id in (
         select agm.profile_id
           from public.assignment_groups_members agm
          where agm.assignment_group_id = p_assignment_group_id
       );
  else
    update public.submissions s
       set is_active = false
     where s.assignment_id = p_assignment_id
       and s.is_active = true
       and s.assignment_group_id in (
         select agm.assignment_group_id
           from public.assignment_groups_members agm
          where agm.profile_id = p_profile_id
       );
  end if;

  select coalesce(max(ordinal), 0) + 1 into v_ordinal
    from public.submissions
   where assignment_id = p_assignment_id
     and (
       (p_assignment_group_id is not null and assignment_group_id = p_assignment_group_id)
       or (p_assignment_group_id is null and profile_id = p_profile_id and assignment_group_id is null)
     );

  insert into public.submissions(
    assignment_id, class_id, profile_id, assignment_group_id,
    repository, sha, run_attempt, run_number, ordinal, is_active, submitted_via, is_placeholder
  ) values (
    p_assignment_id, v_class_id, p_profile_id, p_assignment_group_id,
    null, null, 1, v_ordinal, v_ordinal, true, 'manual', true
  )
  returning id into v_submission_id;

  return v_submission_id;
end;
$$;

revoke all on function public.create_manual_submission_internal(bigint, uuid, bigint) from public;
revoke all on function public.create_manual_submission_internal(bigint, uuid, bigint) from authenticated;
grant execute on function public.create_manual_submission_internal(bigint, uuid, bigint) to postgres;

-- ============================================================================
-- Roster view: expose the stored is_placeholder column.
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
         SELECT individual_submissions.user_role_id, individual_submissions.assignment_id FROM individual_submissions
        UNION
         SELECT group_submissions.user_role_id, group_submissions.assignment_id FROM group_submissions
        ), non_submitters AS (
         SELECT ast.user_role_id, ast.private_profile_id, ast.class_id,
            ast.assignment_id, NULL::bigint AS submission_id,
            agm.assignment_group_id, ast.due_date,
            ast.assignment_slug, ast.class_section_id, ast.lab_section_id
           FROM assignment_students ast
             LEFT JOIN public.assignment_groups_members agm ON ((agm.assignment_id = ast.assignment_id AND agm.profile_id = ast.private_profile_id))
          WHERE NOT EXISTS (
             SELECT 1 FROM submitters su
              WHERE su.user_role_id = ast.user_role_id
                AND su.assignment_id = ast.assignment_id
          )
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
    swe.lab_section_id, ls.name AS lab_section_name,
    COALESCE(s.is_placeholder, false) AS is_placeholder
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
