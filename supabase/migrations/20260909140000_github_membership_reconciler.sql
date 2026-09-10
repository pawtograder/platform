-- Self-healing for GitHub ORG MEMBERSHIP, the half of the GitHub integration that had none.
--
-- What was missing. Every automated path that invites a user to a class's GitHub org is gated on
-- `user_roles.invitation_date IS NULL` (github-async-worker sync_student_team / sync_staff_team,
-- and the autograder-sync-student-team backstop), and github-repo-webhook stamps that column the
-- moment GitHub reports `member_invited`. A GitHub org invitation expires after 7 days, and GitHub
-- emits no event when it does. So one unaccepted invitation put the enrollment into a state that no
-- automation could ever leave:
--
--     github_org_confirmed = false  +  invitation_date IS NOT NULL  +  no org membership
--
-- and because everything downstream keys off `github_org_confirmed` (the team-sync member lists
-- filter on it, `sync_repo_permissions_for_student` fires on the false->true transition), that
-- student silently had no team membership and no repo access for the rest of the term. The only
-- repairs in production were a student logging in (app/auth/callback re-runs github-user-sync) or
-- pressing "Sync GitHub Account" — which is exactly what the steady stream of "Fix GitHub button
-- made changes" Sentry events was recording. github-repo-reconciler covers repositories only;
-- discord-reconciler covers Discord membership; nothing covered this.
--
-- This migration adds the missing reconciler:
--   * github_org_invite_window_open(archived, start_date, end_date) — may automation mail an
--     invitation for this class right now? Mirrored in TypeScript by _shared/orgInviteWindow.ts.
--   * enqueue_github_org_reinvite(...) — queue a per-user re-invite as an ordinary async-worker
--     envelope, so it inherits the existing rate limiting, retries, dead-lettering and metrics.
--   * reconcile_stale_org_invitations(...) — service-role: find enrollments whose invitation has
--     lapsed (or was never enqueued) and re-invite them, bounded per run.
--   * get_stuck_org_membership_alerts(...) — one row per class for the edge function's Sentry
--     alerts, including the classes this reconciler must SKIP because their term dates are unset.
--   * invoke_github_membership_reconciler_background_task() + an hourly pg_cron schedule.

-- ---------------------------------------------------------------------------
-- The term window.
-- ---------------------------------------------------------------------------
-- Re-inviting is safe to repeat, but only while the class is actually running: a course shell
-- created months early, or one that ended last spring, must not mail its roster fresh GitHub
-- invitations. Missing term dates therefore CLOSE the window rather than open it — we cannot tell
-- whether such a class is in session, and the guess that errs toward "yes" is the one that mails
-- strangers. Those classes are not silently dropped: get_stuck_org_membership_alerts() reports them
-- separately so an instructor can fill the dates in.
--
-- Grace on both ends, because the term dates bound instruction, not setup:
--   -7 days   students enroll and link GitHub the week before classes begin, and an invitation sent
--             then can lapse before day one — the case that must be repaired BEFORE the first
--             assignment rather than after it.
--   +30 days  matches is_class_active(), which keeps automation running through the grading and
--             grade-appeal windows that outlive the last class meeting.
--
-- Keep in sync with INVITE_WINDOW_LEAD_DAYS / INVITE_WINDOW_TRAIL_DAYS in
-- supabase/functions/_shared/orgInviteWindow.ts.
create or replace function public.github_org_invite_window_open(
  p_archived boolean,
  p_start_date date,
  p_end_date date
) returns boolean
language sql
stable
parallel safe
set search_path = ''
as $$
  select coalesce(p_archived, false) = false
     and p_start_date is not null
     and p_end_date is not null
     and current_date >= p_start_date - 7
     and current_date <= p_end_date + 30;
$$;

comment on function public.github_org_invite_window_open(boolean, date, date) is
  'True when automation may (re-)invite users to this class''s GitHub org: not archived, and today is within 7 days before start_date through 30 days after end_date. NULL term dates return false by design — see 20260909140000_github_membership_reconciler.sql.';

grant execute on function public.github_org_invite_window_open(boolean, date, date) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Enqueue one re-invite.
-- ---------------------------------------------------------------------------
-- Reuses the existing sync_student_team / sync_staff_team envelopes rather than introducing a new
-- github_async_method: those envelopes already contain the per-user invite branch, and the team
-- reconcile they also perform is idempotent (and is itself drift repair we otherwise only do on
-- enrollment changes). `forceReinvite` tells the worker to invite without consulting
-- invitation_date, which reconcile_stale_org_invitations has just stamped.
create or replace function public.enqueue_github_org_reinvite(
  p_class_id bigint,
  p_org text,
  p_course_slug text,
  p_user_id uuid,
  p_is_staff boolean,
  p_debug_id text default null
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_method public.github_async_method;
  log_id bigint;
  message_id bigint;
begin
  v_method := (case when p_is_staff then 'sync_staff_team' else 'sync_student_team' end)::public.github_async_method;

  insert into public.api_gateway_calls(method, status_code, class_id, debug_id)
  values (v_method, 0, p_class_id, p_debug_id)
  returning id into log_id;

  select pgmq_public.send(
    'async_calls',
    jsonb_build_object(
      'method', v_method::text,
      'class_id', p_class_id,
      'debug_id', p_debug_id,
      'log_id', log_id,
      'args', jsonb_build_object(
        'org', p_org,
        'courseSlug', p_course_slug,
        'userId', p_user_id,
        'forceReinvite', true
      )
    )
  ) into message_id;

  return message_id;
end;
$$;

revoke all on function public.enqueue_github_org_reinvite(bigint, text, text, uuid, boolean, text) from public;
grant execute on function public.enqueue_github_org_reinvite(bigint, text, text, uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- The sweep.
-- ---------------------------------------------------------------------------
-- Two candidate shapes, and they are different failures:
--
--   invitation_date IS NULL   the enrollment trigger's enqueue never produced an invitation — a
--                             dropped envelope, a class that had no github_org yet, a user who
--                             linked GitHub after enrolling. The grace period keeps this from
--                             racing the trigger that fires on the same row.
--   invitation_date stale     an invitation was sent and GitHub has since expired it (7 days).
--
-- invitation_date is stamped HERE, at enqueue time, not when GitHub confirms. That makes the column
-- "when we last tried", which is what both remaining readers want: it stops the next hourly pass
-- from re-enqueuing the same user while this envelope is in flight, and it is what the student
-- banner (components/github/resend-org-invitation.tsx) shows as the send time. The cost is that a
-- repair that fails after enqueue waits a full staleness period for its next attempt — which is
-- precisely the case get_stuck_org_membership_alerts() surfaces to Sentry.
--
-- The stamp and the enqueue share one exception block so a failed send rolls the stamp back rather
-- than parking the row for a week on the strength of work that never happened.
create or replace function public.reconcile_stale_org_invitations(
  p_stale_days int default 7,
  p_new_role_grace_minutes int default 30,
  p_max int default 50
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select ur.id,
           ur.class_id,
           ur.user_id,
           ur.role,
           c.github_org,
           c.slug
      from public.user_roles ur
      join public.users u on u.user_id = ur.user_id
      join public.classes c on c.id = ur.class_id
     where ur.disabled = false
       -- Nullable column: NULL means "not confirmed", same as the invitation banner's own condition.
       and ur.github_org_confirmed is not true
       -- No linked GitHub account means there is nobody to invite; that is a different problem
       -- (the student has not linked GitHub yet) with its own product surface.
       and u.github_username is not null
       -- Team names are derived as `${slug}-students` / `${slug}-staff`, so a partially configured
       -- class would reconcile against a bogus `null-students` team. Mirrors every other invite path.
       and c.github_org is not null
       and c.slug is not null
       and coalesce(c.is_demo, false) = false
       -- e2e fixtures must never reach real GitHub (mirrors _shared/e2eGithubGuard.ts). The worker
       -- also guards this, but an envelope not sent is cheaper than one sent and discarded.
       and not (c.github_org = 'pawtograder-playground' and c.slug like 'e2e-ignore-%')
       and public.github_org_invite_window_open(c.archived, c.start_date, c.end_date)
       and (
             (ur.invitation_date is null
              and ur.updated_at < now() - make_interval(mins => p_new_role_grace_minutes))
             or ur.invitation_date < now() - make_interval(days => p_stale_days)
           )
     -- Oldest grievance first, so a large backlog drains in a fair order across passes rather than
     -- re-serving whichever rows happen to sort first.
     order by ur.invitation_date asc nulls first, ur.id
     limit p_max
     -- Two overlapping runs (a cron tick racing a pg_net retry, or a manual invocation) would
     -- otherwise both select the same rows before either invitation_date stamp commits, and each
     -- would enqueue its own invitation — a duplicate email to the student, which is the specific
     -- harm this reconciler exists to avoid. Every join here is inner, so locking `ur` alone is
     -- valid; SKIP LOCKED makes the second run take the next candidates instead of blocking.
     for update of ur skip locked
  loop
    begin
      update public.user_roles set invitation_date = now() where id = r.id;
      perform public.enqueue_github_org_reinvite(
        r.class_id::bigint,
        r.github_org,
        r.slug,
        r.user_id,
        r.role in ('instructor', 'grader', 'admin'),
        'reinvite-role-' || r.id || '-' || extract(epoch from now())::bigint
      );
      v_count := v_count + 1;
    exception
      when others then
        raise warning 'reconcile_stale_org_invitations: failed to enqueue user_role %: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.reconcile_stale_org_invitations(int, int, int) from public;
grant execute on function public.reconcile_stale_org_invitations(int, int, int) to service_role;

-- ---------------------------------------------------------------------------
-- Alerts: one row per class, for the edge function to report.
-- ---------------------------------------------------------------------------
-- Per CLASS, not per student: a broken GitHub App installation or an unset term window strands the
-- whole roster at once, and one Sentry issue per class is the difference between a signal and a
-- flood (the same lesson the Discord terminal-failure work learned from a 30,332-row storm).
--
-- `missing_term_dates` is the deliberate blind spot of the conservative window: those classes have
-- students stuck outside the org and the sweep will NOT touch them. Reporting them is what keeps
-- "skip when we cannot tell if the class is running" from meaning "fail silently forever".
create or replace function public.get_stuck_org_membership_alerts(
  p_days int default 14
) returns table (
  class_id bigint,
  class_slug text,
  github_org text,
  term_start date,
  term_end date,
  window_open boolean,
  missing_term_dates boolean,
  stuck_count bigint,
  oldest_invitation timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.id::bigint,
         c.slug,
         c.github_org,
         c.start_date,
         c.end_date,
         public.github_org_invite_window_open(c.archived, c.start_date, c.end_date),
         (c.start_date is null or c.end_date is null),
         count(*)::bigint,
         min(ur.invitation_date)
    from public.user_roles ur
    join public.users u on u.user_id = ur.user_id
    join public.classes c on c.id = ur.class_id
   where ur.disabled = false
     and ur.github_org_confirmed is not true
     and u.github_username is not null
     and c.github_org is not null
     and c.slug is not null
     and coalesce(c.archived, false) = false
     and coalesce(c.is_demo, false) = false
     and not (c.github_org = 'pawtograder-playground' and c.slug like 'e2e-ignore-%')
     -- Only once the class has been running long enough that not being in the org is a real problem
     -- rather than a student who has not opened their email yet.
     --
     -- Anchored on IMMUTABLE values, which rules out the obvious choice: reconcile_stale_org_invitations
     -- rewrites invitation_date on every sweep, and the edge function sweeps before it queries these
     -- alerts, so a row aged off invitation_date would be refreshed a few milliseconds before being
     -- asked how old it is — the "still stuck" alert could never fire at all. A dated class is aged
     -- from start_date; an undated one (which the sweep will not touch, and which this function
     -- reports so somebody fills the dates in) is aged from when the class was created.
     and (
           case when c.start_date is not null
                then c.start_date <= current_date - p_days
                else c.created_at < now() - make_interval(days => p_days)
           end
         )
     -- Don't keep alerting about classes that are long over.
     and (c.end_date is null or c.end_date >= current_date - 30)
     -- Nor about ancient course shells that were never configured and never will be.
     and c.created_at > now() - interval '365 days'
     -- Skip an enrollment touched in the last two days: at term start every student is briefly
     -- unconfirmed, and someone who enrolled this morning is not stuck. Two days is a fraction of
     -- the seven-day sweep cadence, so a genuinely stuck enrollment still qualifies for most of
     -- each cycle rather than being masked by the sweep's own stamp.
     --
     -- Falls back to updated_at for a role with no invitation at all, which is the late enrollee in
     -- an established class: the sweep holds those for p_new_role_grace_minutes so the enrollment
     -- trigger's own invitation can land first, and without this the alert would report them as
     -- stuck while that invitation was still in flight. user_roles has no created_at, and
     -- set_updated_at_on_user_roles makes updated_at "last modified" rather than "created" — so
     -- this is a lower bound on the row's age. It errs toward delaying an alert for a role that was
     -- edited recently, never toward raising one that isn't real, which is the right direction for
     -- something that pages a human.
     and coalesce(ur.invitation_date, ur.updated_at) < now() - interval '2 days'
   group by c.id, c.slug, c.github_org, c.start_date, c.end_date, c.archived
$$;

revoke all on function public.get_stuck_org_membership_alerts(int) from public;
grant execute on function public.get_stuck_org_membership_alerts(int) to service_role;

-- ---------------------------------------------------------------------------
-- Cron: invoke the membership reconciler hourly.
-- ---------------------------------------------------------------------------
-- Hourly rather than the repo reconciler's 15 minutes: the staleness threshold is measured in days,
-- so a faster cadence would buy nothing and only spend GitHub API budget. Offset off the hour to
-- avoid landing on top of the other :00 jobs.
create or replace function public.invoke_github_membership_reconciler_background_task()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.call_edge_function_internal(
    '/functions/v1/github-membership-reconciler',
    'POST',
    '{"Content-type":"application/json","x-supabase-webhook-source":"github-membership-reconciler"}'::jsonb,
    '{}'::jsonb,
    5000,
    null, null, null, null, null
  );
end;
$$;

revoke all on function public.invoke_github_membership_reconciler_background_task() from public;
grant execute on function public.invoke_github_membership_reconciler_background_task() to service_role;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'github-membership-reconciler') then
      perform cron.unschedule('github-membership-reconciler');
    end if;
    perform cron.schedule(
      'github-membership-reconciler',
      '23 * * * *',
      $$select public.invoke_github_membership_reconciler_background_task();$$
    );
    raise notice 'GitHub membership reconciler cron scheduled hourly';
  end if;
exception
  when insufficient_privilege then
    raise notice 'Skipping github-membership-reconciler cron schedule: insufficient privilege';
end;
$cron$;
