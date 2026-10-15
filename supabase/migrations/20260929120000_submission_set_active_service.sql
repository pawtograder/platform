-- Service-role variant of submission_set_active, for operator scripts.
--
-- submission_set_active authorizes through auth.uid(), so a service-role client (no user) is always
-- refused. Doing the swap from a script as two PostgREST updates instead commits the demote on its
-- own, and trigger_update_review_assignments_on_submission_deactivation (DEFERRABLE INITIALLY
-- DEFERRED) then fires with nothing active for the submitter. Its fallback picks the submitter's
-- newest row by created_at, which can be a rejected, fileless push, and moves and reopens the review
-- assignments there. Demoting and promoting in one transaction means the trigger sees the new
-- active row when it runs at commit.
--
-- Same scoping as submission_set_active and the submissions_one_active_* unique indexes: the group
-- for a group submission, the individual (group id NULL) otherwise.
create or replace function public.submission_set_active_service(p_submission_id bigint)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub record;
begin
  select id, assignment_id, profile_id, assignment_group_id, is_not_graded
    into v_sub
    from public.submissions
   where id = p_submission_id
   for update;
  if not found then
    raise exception 'Submission % not found', p_submission_id;
  end if;
  if v_sub.is_not_graded then
    raise exception 'Submission % is #NOT-GRADED and cannot be made active', p_submission_id;
  end if;

  if v_sub.assignment_group_id is not null then
    update public.submissions
       set is_active = false
     where assignment_id = v_sub.assignment_id
       and assignment_group_id = v_sub.assignment_group_id
       and is_active
       and id <> p_submission_id;
  else
    update public.submissions
       set is_active = false
     where assignment_id = v_sub.assignment_id
       and profile_id = v_sub.profile_id
       and assignment_group_id is null
       and is_active
       and id <> p_submission_id;
  end if;

  update public.submissions set is_active = true where id = p_submission_id;
end;
$$;

revoke all on function public.submission_set_active_service(bigint) from public;
revoke all on function public.submission_set_active_service(bigint) from anon;
revoke all on function public.submission_set_active_service(bigint) from authenticated;
grant execute on function public.submission_set_active_service(bigint) to service_role;
