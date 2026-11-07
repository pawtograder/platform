-- Bug reporter (bug-reporter-handoff.md). One migration for the whole feature; each package appends
-- its section below.

-- ===========================================================================
-- Package 6b: retention purge (ADR 1)
-- ===========================================================================
-- Bug reports (Sentry feedback and replays) tagged with a class_id are deleted 30 days after the
-- class's end_date by the bug-report-retention-purge edge function, invoked daily from pg_cron.
-- Sentry's own cleanup (sentry.cleanup.days) is the backstop, including for reports with no class.
--
-- bug_report_retention_purges records the last finished sweep per class. It lets a run skip classes
-- it already swept today, puts never-swept classes first, and keeps what was deleted countable
-- without logging ids. It is internal state for the service role: RLS on with no policies, and no
-- grants to anon or authenticated.

create table if not exists public.bug_report_retention_purges (
  class_id bigint primary key references public.classes (id) on delete cascade,
  first_purged_at timestamptz not null default now(),
  last_purged_at timestamptz not null default now(),
  last_feedback_deleted integer not null default 0,
  last_replays_deleted integer not null default 0,
  total_feedback_deleted bigint not null default 0,
  total_replays_deleted bigint not null default 0
);

alter table public.bug_report_retention_purges enable row level security;
revoke all on table public.bug_report_retention_purges from public, anon, authenticated;
grant select, insert, update, delete on table public.bug_report_retention_purges to service_role;

comment on table public.bug_report_retention_purges is
  'Last Sentry retention sweep per class (bug-report-retention-purge). Service role only.';

-- Classes whose bug reports are due for deletion.
--
-- Due: end_date + p_grace_days is in the past (end_date read as UTC midnight; the edge function
-- checks the same rule again before deleting anything). Classes with no end_date are never due.
--
-- Still worth a query: the grace period ended less than p_lookback_days ago. The function searches
-- Sentry over the same lookback, which must be at least sentry.cleanup.days; past it, everything a
-- class could have is already gone. Until then a class is swept daily, because a report can still be
-- filed against an archived course after its first purge.
--
-- Not swept in the last p_resweep_after_hours, so a doubled or retried cron call does no extra work.
-- Never-swept classes first, then the longest-ago sweep, so a run cut short by its limit rotates.
create or replace function public.get_bug_report_retention_purge_candidates(
  p_grace_days integer,
  p_lookback_days integer,
  p_resweep_after_hours integer,
  p_limit integer
) returns table (class_id bigint, end_date date)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.end_date
    from public.classes c
    left join public.bug_report_retention_purges p on p.class_id = c.id
   where c.end_date is not null
     and (c.end_date::timestamp at time zone 'UTC') + make_interval(days => p_grace_days) < now()
     and (c.end_date::timestamp at time zone 'UTC') + make_interval(days => p_grace_days + p_lookback_days) > now()
     and (p.last_purged_at is null or p.last_purged_at < now() - make_interval(hours => p_resweep_after_hours))
   order by p.last_purged_at asc nulls first, c.end_date asc, c.id asc
   limit greatest(p_limit, 0)
$$;

revoke all on function public.get_bug_report_retention_purge_candidates(integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.get_bug_report_retention_purge_candidates(integer, integer, integer, integer) to service_role;

create or replace function public.record_bug_report_retention_purge(
  p_class_id bigint,
  p_feedback_deleted integer,
  p_replays_deleted integer
) returns void
language sql
volatile
security definer
set search_path = public
as $$
  insert into public.bug_report_retention_purges as p (
    class_id, first_purged_at, last_purged_at, last_feedback_deleted, last_replays_deleted,
    total_feedback_deleted, total_replays_deleted
  ) values (
    p_class_id, now(), now(), p_feedback_deleted, p_replays_deleted, p_feedback_deleted, p_replays_deleted
  )
  on conflict (class_id) do update set
    last_purged_at = now(),
    last_feedback_deleted = excluded.last_feedback_deleted,
    last_replays_deleted = excluded.last_replays_deleted,
    total_feedback_deleted = p.total_feedback_deleted + excluded.last_feedback_deleted,
    total_replays_deleted = p.total_replays_deleted + excluded.last_replays_deleted
$$;

revoke all on function public.record_bug_report_retention_purge(bigint, integer, integer) from public, anon, authenticated;
grant execute on function public.record_bug_report_retention_purge(bigint, integer, integer) to service_role;

create or replace function public.invoke_bug_report_retention_purge_background_task()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.call_edge_function_internal(
    '/functions/v1/bug-report-retention-purge',
    'POST',
    '{"Content-type":"application/json","x-supabase-webhook-source":"bug-report-retention-purge"}'::jsonb,
    '{}'::jsonb,
    5000,
    null, null, null, null, null
  );
end;
$$;

revoke all on function public.invoke_bug_report_retention_purge_background_task() from public, anon, authenticated;
grant execute on function public.invoke_bug_report_retention_purge_background_task() to service_role;

-- Daily, off the hour so it doesn't land on the other :00 jobs.
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'bug-report-retention-purge') then
      perform cron.unschedule('bug-report-retention-purge');
    end if;
    perform cron.schedule(
      'bug-report-retention-purge',
      '41 5 * * *',
      $$select public.invoke_bug_report_retention_purge_background_task();$$
    );
    raise notice 'Bug report retention purge cron scheduled daily';
  end if;
exception
  when insufficient_privilege then
    raise notice 'Skipping bug-report-retention-purge cron schedule: insufficient privilege';
end;
$cron$;
