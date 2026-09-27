-- Repair path for classes that become GitHub-configured *after* enrollment.
--
-- 20260611120001 made sync_staff_github_team / sync_student_github_team no-op
-- (raise warning + return) when a class has no github_org/slug, so enrollment is
-- never blocked. The downside: a class that *should* be GitHub-configured but was
-- created/imported without an org/slug (e.g. SIS import, or an org typo fixed
-- later) enrolls everyone while silently never syncing them to the GitHub team --
-- repos/autograder access quietly broken, with nothing but an unread warning.
--
-- This trigger closes that gap: when a class's github_org and slug both become
-- set (having previously been incomplete), enqueue a full staff + student team
-- resync via the existing async GitHub worker queue. Passing a NULL affected user
-- makes the worker sync the entire current roster for that class, so everyone who
-- enrolled while the class was unconfigured gets added to the new teams.

create or replace function public.resync_github_teams_on_class_config()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only act on the NULL/incomplete -> fully-configured transition. Once both are
  -- set, later edits (e.g. renaming the slug) are out of scope here.
  if new.github_org is not null and new.slug is not null
     and (old.github_org is null or old.slug is null) then
    perform public.enqueue_github_sync_staff_team(
      new.id::bigint, new.github_org, new.slug, null, 'class_config_resync'
    );
    perform public.enqueue_github_sync_student_team(
      new.id::bigint, new.github_org, new.slug, null, 'class_config_resync'
    );
  end if;
  return new;
end;
$$;

-- Triggered only when the relevant columns change, so ordinary class updates
-- don't enqueue redundant syncs.
drop trigger if exists resync_github_teams_on_class_config on public.classes;
create trigger resync_github_teams_on_class_config
after update of github_org, slug on public.classes
for each row
execute function public.resync_github_teams_on_class_config();
