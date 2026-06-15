-- Make GitHub team-sync tolerant of classes that have no github_org/slug.
--
-- Previously sync_staff_github_team / sync_student_github_team RAISEd
-- 'Class not found or missing org/slug for class %' when either was NULL. Those
-- functions run from an AFTER INSERT trigger on user_roles, so the exception
-- rolled back the *enrollment itself*: you could not add an instructor/grader (or
-- student) to a class that wasn't GitHub-configured. Classes created without an
-- org/slug (e.g. via SIS import, which doesn't pass github_org) were therefore
-- un-enrollable. A class with no GitHub config should simply skip team sync, not
-- block enrollment. The create-class form still requires org+prefix as good UX,
-- but enforcement no longer depends on it.
--
-- Skipping the sync would otherwise drop the work on the floor for a class that
-- later *does* get GitHub-configured. The repair path lives in
-- 20260615120000_resync_github_teams_on_class_config.sql: an AFTER UPDATE trigger
-- on classes enqueues a full team resync when github_org/slug transition from
-- NULL to set, so anyone enrolled while the class was unconfigured is backfilled.

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
  if auth.uid() is not null and not public.authorizeforclassinstructor(class_id::bigint) then
    raise exception 'Access denied: Only instructors can sync staff GitHub team for class %', class_id;
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
  if auth.uid() is not null and not public.authorizeforclassinstructor(class_id::bigint) then
    raise exception 'Access denied: Only instructors can sync student GitHub team for class %', class_id;
  end if;
  select slug, github_org into v_slug, v_org from public.classes where id = class_id;
  if v_slug is null or v_org is null then
    raise warning 'Skipping student GitHub team sync for class %: missing org/slug', class_id;
    return;
  end if;
  perform public.enqueue_github_sync_student_team(class_id::bigint, v_org, v_slug, user_id, null);
end;
$$;
