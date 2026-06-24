-- Allow platform admins (not just class instructors) to trigger GitHub team sync.
--
-- create_invitation() permits BOTH class instructors and platform admins
-- (authorizeforclassinstructor OR authorize_for_admin). But invitation acceptance
-- runs the auto_accept_invitation_if_user_exists trigger, which inserts/updates a
-- user_roles row, which in turn fires sync_github_teams_on_role_change ->
-- sync_student_github_team / sync_staff_github_team. Those two functions only
-- accepted class instructors:
--
--   if auth.uid() is not null and not authorizeforclassinstructor(class_id) then
--     raise exception 'Access denied: Only instructors can sync ... for class %';
--
-- So when a platform admin (who is NOT an instructor of the class) created
-- invitations -- e.g. the "Create class from SIS" / SIS import flow -- and any
-- invited user already had an account, the trigger raised:
--
--   Access denied: Only instructors can sync student GitHub team for class <id>
--
-- which rolled the enrollment (and the whole invitation insert) back. This widens
-- the authorization check to match create_invitation: a request authorized as
-- either a class instructor OR a platform admin is allowed to sync. The bodies
-- are otherwise unchanged from 20260611120001 (still tolerate a NULL org/slug by
-- skipping the sync instead of raising).

create or replace function public.sync_staff_github_team(class_id integer, user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_org text;
begin
  if class_id is null then
    raise warning 'sync_staff_github_team called with NULL class_id, skipping';
    return;
  end if;
  if auth.uid() is not null
     and not (public.authorizeforclassinstructor(class_id::bigint) or public.authorize_for_admin()) then
    raise exception 'Access denied: Only instructors or admins can sync staff GitHub team for class %', class_id;
  end if;
  select slug, github_org into v_slug, v_org from public.classes where id = class_id;
  if v_slug is null or v_org is null then
    -- Class isn't GitHub-configured; nothing to sync. Do NOT raise -- this runs
    -- from a user_roles trigger and would otherwise block the enrollment.
    raise warning 'Skipping staff GitHub team sync for class %: missing org/slug', class_id;
    return;
  end if;
  perform public.enqueue_github_sync_staff_team(class_id::bigint, v_org, v_slug, user_id, null);
end;
$$;

create or replace function public.sync_student_github_team(class_id integer, user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slug text;
  v_org text;
begin
  if class_id is null then
    raise warning 'sync_student_github_team called with NULL class_id, skipping';
    return;
  end if;
  if auth.uid() is not null
     and not (public.authorizeforclassinstructor(class_id::bigint) or public.authorize_for_admin()) then
    raise exception 'Access denied: Only instructors or admins can sync student GitHub team for class %', class_id;
  end if;
  select slug, github_org into v_slug, v_org from public.classes where id = class_id;
  if v_slug is null or v_org is null then
    raise warning 'Skipping student GitHub team sync for class %: missing org/slug', class_id;
    return;
  end if;
  perform public.enqueue_github_sync_student_team(class_id::bigint, v_org, v_slug, user_id, null);
end;
$$;
