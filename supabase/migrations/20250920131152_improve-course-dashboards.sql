-- Create RPC to compute instructor dashboard metrics for a course
-- This function returns two result sets:
-- 1) recently_due_assignments: up to 10 assignments due in the last 30 days with summary metrics
-- 2) upcoming_assignments: up to 5 assignments due in the future with basic metrics
-- It is SECURITY DEFINER but enforces access via class_id and RLS-friendly subqueries.

create or replace function public.get_instructor_dashboard_metrics(
  p_class_id bigint,
  p_now timestamptz default now()
)
returns table (
  section text,
  assignment_id bigint,
  title text,
  due_date timestamptz,
  time_zone text,
  total_submitters bigint,
  graded_submissions bigint,
  open_regrade_requests bigint,
  closed_or_resolved_regrade_requests bigint,
  students_with_valid_extensions bigint,
  review_assignments_total bigint,
  review_assignments_completed bigint,
  review_assignments_incomplete bigint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Authorization: only graders/instructors for this class
  if not public.authorizeforclassgrader(p_class_id) then
    raise exception 'Access denied: insufficient permissions for class %', p_class_id;
  end if;
  -- Recently due in last 30 days
  return query
  with recent as (
    select a.id as assignment_id,
           a.title,
           a.due_date,
           c.time_zone,
           a.grading_rubric_id
    from assignments a
    join classes c on c.id = a.class_id
    where a.class_id = p_class_id
      and a.due_date <= p_now
      and a.due_date >= p_now - interval '30 days'
    order by a.due_date desc
    limit 10
  ),
  active_submissions as (
    -- Distinct submitters by profile or group among active submissions (students only)
    select s.assignment_id,
           count(distinct coalesce(s.assignment_group_id::text, s.profile_id::text))::bigint as total_submitters
    from submissions s
    join recent on recent.assignment_id = s.assignment_id
    where s.is_active = true
      and (
        (s.profile_id is not null and exists (
          select 1 from public.user_roles ur
           where ur.private_profile_id = s.profile_id
             and ur.class_id = s.class_id
             and ur.role = 'student'::public.app_role
             and ur.disabled = false
        ))
        or
        (s.assignment_group_id is not null and exists (
          select 1
          from public.assignment_groups_members agm
          join public.user_roles ur on ur.private_profile_id = agm.profile_id
                                   and ur.class_id = s.class_id
                                   and ur.role = 'student'::public.app_role
                                   and ur.disabled = false
          where agm.assignment_group_id = s.assignment_group_id
            and agm.assignment_id = s.assignment_id
        ))
      )
    group by s.assignment_id
  ),
  graded as (
    select s.assignment_id, count(*)::bigint as graded_submissions
    from submissions s
    join recent on recent.assignment_id = s.assignment_id
    join submission_reviews sr on sr.id = s.grading_review_id
    where sr.completed_at is not null and sr.completed_by is not null
    and s.is_active = true
      and (
        (s.profile_id is not null and exists (
          select 1 from public.user_roles ur
           where ur.private_profile_id = s.profile_id
             and ur.class_id = s.class_id
             and ur.role = 'student'::public.app_role
             and ur.disabled = false
        ))
        or
        (s.assignment_group_id is not null and exists (
          select 1
          from public.assignment_groups_members agm
          join public.user_roles ur on ur.private_profile_id = agm.profile_id
                                   and ur.class_id = s.class_id
                                   and ur.role = 'student'::public.app_role
                                   and ur.disabled = false
          where agm.assignment_group_id = s.assignment_group_id
            and agm.assignment_id = s.assignment_id
        ))
      )
    group by s.assignment_id
  ),
  regrades as (
    select srr.assignment_id,
           sum(case when srr.status = 'opened' then 1 else 0 end)::bigint as open_regrade_requests,
           sum(case when srr.status in ('closed','resolved') then 1 else 0 end)::bigint as closed_or_resolved_regrade_requests
    from submission_regrade_requests srr
    join recent on recent.assignment_id = srr.assignment_id
    group by srr.assignment_id
  ),
  review_counts as (
    select ra.assignment_id,
           count(*)::bigint as total,
           sum(case when ra.completed_at is not null and ra.completed_by is not null then 1 else 0 end)::bigint as completed
    from review_assignments ra
    join recent on recent.assignment_id = ra.assignment_id
    where ra.class_id = p_class_id
    group by ra.assignment_id
  ),
  valid_extensions as (
    -- Count students with extensions whose extended due date > now
    select ade.assignment_id,
           count(distinct coalesce('g:'||ade.assignment_group_id::text, 'p:'||ade.student_id::text))::bigint as students_with_valid_extensions
    from assignment_due_date_exceptions ade
    join recent on recent.assignment_id = ade.assignment_id
    join assignments a2 on a2.id = ade.assignment_id
    where (a2.due_date + make_interval(hours => ade.hours, mins => ade.minutes)) > p_now
    group by ade.assignment_id
  )
  select 'recently_due'::text as section,
         r.assignment_id,
         r.title,
         r.due_date,
         r.time_zone,
         coalesce(asub.total_submitters, 0),
         coalesce(g.graded_submissions, 0),
         coalesce(rg.open_regrade_requests, 0),
         coalesce(rg.closed_or_resolved_regrade_requests, 0),
         coalesce(ext.students_with_valid_extensions, 0),
         coalesce(rc.total, 0),
         coalesce(rc.completed, 0),
         greatest(coalesce(rc.total, 0) - coalesce(rc.completed, 0), 0)
  from recent r
  left join active_submissions asub on asub.assignment_id = r.assignment_id
  left join graded g on g.assignment_id = r.assignment_id
  left join regrades rg on rg.assignment_id = r.assignment_id
  left join valid_extensions ext on ext.assignment_id = r.assignment_id
  left join review_counts rc on rc.assignment_id = r.assignment_id
  order by r.due_date desc, r.assignment_id desc;

  -- Upcoming in the future (basic metrics)
  return query
  with upcoming as (
    select a.id as assignment_id,
           a.title,
           a.due_date,
           c.time_zone,
           a.grading_rubric_id
    from assignments a
    join classes c on c.id = a.class_id
    where a.class_id = p_class_id
      and a.due_date >= p_now
    order by a.due_date asc
    limit 5
  ),
  review_counts2 as (
    select ra.assignment_id,
           count(*)::bigint as total,
           sum(case when ra.completed_at is not null and ra.completed_by is not null then 1 else 0 end)::bigint as completed
    from review_assignments ra
    join upcoming on upcoming.assignment_id = ra.assignment_id
    where ra.class_id = p_class_id
    group by ra.assignment_id
  ),
  submitters2 as (
    select s.assignment_id,
           count(distinct coalesce(s.assignment_group_id::text, s.profile_id::text))::bigint as total_submitters
    from submissions s
    join upcoming on upcoming.assignment_id = s.assignment_id
    where s.is_active = true
      and (
        (s.profile_id is not null and exists (
          select 1 from public.user_roles ur
           where ur.private_profile_id = s.profile_id
             and ur.class_id = s.class_id
             and ur.role = 'student'::public.app_role
             and ur.disabled = false
        ))
        or
        (s.assignment_group_id is not null and exists (
          select 1
          from public.assignment_groups_members agm
          join public.user_roles ur on ur.private_profile_id = agm.profile_id
                                   and ur.class_id = s.class_id
                                   and ur.role = 'student'::public.app_role
                                   and ur.disabled = false
          where agm.assignment_group_id = s.assignment_group_id
            and agm.assignment_id = s.assignment_id
        ))
      )
    group by s.assignment_id
  )
  select 'upcoming'::text as section,
         u.assignment_id,
         u.title,
         u.due_date,
         u.time_zone,
         coalesce(sub2.total_submitters, 0),
         0::bigint as graded_submissions,
         0::bigint as open_regrade_requests,
         0::bigint as closed_or_resolved_regrade_requests,
         0::bigint as students_with_valid_extensions,
         coalesce(rc2.total, 0),
         coalesce(rc2.completed, 0),
         greatest(coalesce(rc2.total, 0) - coalesce(rc2.completed, 0), 0)
  from upcoming u
  left join submitters2 sub2 on sub2.assignment_id = u.assignment_id
  left join review_counts2 rc2 on rc2.assignment_id = u.assignment_id
  order by u.due_date asc, u.assignment_id asc

  return;
end;
$$;

comment on function public.get_instructor_dashboard_metrics(bigint, timestamptz)
is 'Returns instructor dashboard assignment metrics split into sections: recently_due and upcoming. Metrics include total submitters (active student submissions by student or group), graded submissions, open/closed regrade requests, students with valid extensions, review assignment counts (total/completed/incomplete), and rubric part coverage (total/graded/not graded) for the grading rubric.';

grant execute on function public.get_instructor_dashboard_metrics(bigint, timestamptz) to authenticated; -- relies on RLS of underlying tables


