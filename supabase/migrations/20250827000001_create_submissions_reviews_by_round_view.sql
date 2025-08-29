-- purpose: create a view that returns one row per student per assignment with
--          scores aggregated by review_round for both private (all reviews)
--          and public (released reviews only) contexts. this restores the
--          previous one-row-per-student guarantee while supporting multiple
--          review rounds.
-- affected: public.submissions, public.submission_reviews, public.rubrics,
--           public.user_roles, public.assignment_groups_members, public.assignments
-- notes: the view is created with security_invoker so underlying rls policies
--        continue to apply. the private/public separation is encoded in the two
--        jsonb columns; consumers should choose the appropriate map based on
--        execution context.

drop view if exists public.submissions_with_reviews_by_round_for_assignment;

create or replace view public.submissions_with_reviews_by_round_for_assignment
with ("security_invoker"='true')
as
with
  assignment_students as (
    -- each student in the class of each assignment
    select distinct
      ur.private_profile_id,
      a.class_id,
      a.id as assignment_id,
      a.slug as assignment_slug
    from public.assignments a
    join public.user_roles ur
      on ur.class_id = a.class_id
     and ur.role = 'student'::public.app_role
  ),
  individual_submissions as (
    -- active individual submissions
    select
      ast.private_profile_id,
      ast.class_id,
      ast.assignment_id,
      ast.assignment_slug,
      s.id as submission_id
    from assignment_students ast
    join public.submissions s
      on s.assignment_id = ast.assignment_id
     and s.profile_id = ast.private_profile_id
     and s.is_active = true
     and s.assignment_group_id is null
  ),
  group_submissions as (
    -- active group submissions (map back to each member)
    select
      ast.private_profile_id,
      ast.class_id,
      ast.assignment_id,
      ast.assignment_slug,
      s.id as submission_id
    from assignment_students ast
    join public.assignment_groups_members agm
      on agm.assignment_id = ast.assignment_id
     and agm.profile_id = ast.private_profile_id
    join public.submissions s
      on s.assignment_id = ast.assignment_id
     and s.assignment_group_id = agm.assignment_group_id
     and s.is_active = true
  ),
  chosen_submission as (
    -- prefer individual submission; otherwise use group submission
    select
      ast.private_profile_id,
      ast.class_id,
      ast.assignment_id,
      ast.assignment_slug,
      coalesce(isub.submission_id, gsub.submission_id) as submission_id
    from assignment_students ast
    left join individual_submissions isub
      on isub.private_profile_id = ast.private_profile_id
     and isub.assignment_id = ast.assignment_id
    left join group_submissions gsub
      on gsub.private_profile_id = ast.private_profile_id
     and gsub.assignment_id = ast.assignment_id
  )
select
  cs.class_id,
  cs.assignment_id,
  cs.assignment_slug,
  cs.private_profile_id as student_private_profile_id,
  -- private map: includes all reviews regardless of release
  (
    select coalesce(jsonb_object_agg(x.review_round::text, x.total_score), '{}'::jsonb)
    from (
      select distinct on (r.review_round)
        r.review_round,
        sr.total_score
      from public.submission_reviews sr
      join public.rubrics r on r.id = sr.rubric_id
      where sr.submission_id = cs.submission_id
      order by r.review_round, sr.completed_at desc nulls last, sr.id desc
    ) x
  ) as scores_by_round_private,
  -- public map: only reviews released to students
  (
    select coalesce(jsonb_object_agg(x.review_round::text, x.total_score), '{}'::jsonb)
    from (
      select distinct on (r.review_round)
        r.review_round,
        sr.total_score
      from public.submission_reviews sr
      join public.rubrics r on r.id = sr.rubric_id
      where sr.submission_id = cs.submission_id
        and sr.released = true
      order by r.review_round, sr.completed_at desc nulls last, sr.id desc
    ) x
  ) as scores_by_round_public
from chosen_submission cs;

comment on view public.submissions_with_reviews_by_round_for_assignment is
'One row per student per assignment with per-review_round score maps. Private map includes all reviews; public map only includes released reviews.';


