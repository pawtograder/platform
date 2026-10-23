-- Server-side, retried creation of an assignment's STAFF repositories, with state an instructor
-- can see.
--
-- Until now the browser did this. After inserting the assignment row, the new-assignment page
-- awaited assignment-create-handout-repo and THEN assignment-create-solution-repo, one after the
-- other. Nothing recorded that either call was owed, so a slow first call, a closed tab or a
-- thrown error silently skipped the second, and nothing ever retried it. On 2026-10-19 GitHub
-- took ~90s to generate CS 3100 hw-cyb4's handout (class 653, assignment 1267); the solution call
-- never ran, and the assignment was released to 291 students with autograder.grader_repo and
-- autograder.config both NULL. Every one of 295 pushes failed with "no pawtograder config found
-- for grader repo null", and the instructor's only symptom was a GitHub 404 on the overview page,
-- whose link is built from a naming convention rather than read from the database.
--
-- This migration makes the work owed a row, and the row's job durable:
--   * public.assignment_repo_setup -- one row per (assignment, kind), kind in handout|solution,
--     with state, attempts, the last error and when. Broadcast to the class staff channel, so the
--     assignment page shows it live.
--   * An AFTER INSERT trigger on assignments enqueues both jobs on the async_calls queue, inside
--     the insert's own transaction: an assignment that needs repositories cannot exist without
--     its jobs. github-async-worker runs them (methods setup_handout_repo / setup_solution_repo),
--     with the same rate-limit backoff, circuits, per-org leases and DLQ as create_repo.
--   * reconcile_assignment_repo_setup(), called by github-repo-reconciler every 15 minutes:
--     re-enqueues jobs that were lost, parks rows whose job was dead-lettered or that exhausted
--     their attempts, and creates rows for assignments some path inserted without them.
--   * retry_assignment_repo_setup(), the instructor's Retry button.
--   * get_assignment_repo_setup_checks(), the readiness checklist the panel renders.
--   * metrics_assignment_repo_setup(), the driver for the web_assignment_repo_setup_* gauges and
--     the PawtograderAssignmentSetup* alerts.
--
-- The release fan-out needs no change: when the handout job writes template_repo on an assignment
-- whose release date has passed, check_assignment_for_repo_creation (NULL -> value) creates the
-- student repositories, so a late handout catches up on its own.

-- ---------------------------------------------------------------------------------------------
-- 0. Opt-out at insert
-- ---------------------------------------------------------------------------------------------
-- `assignments copy --skip-repos` (supabase/functions/cli/commands/assignments.ts) promises to make
-- no GitHub calls. An unconditional insert trigger would break that promise, so the caller says
-- so on the row it inserts. The rows are still recorded (as skipped, with a note) so an instructor
-- can see why there are no repositories and use Retry, which clears the flag.
alter table public.assignments
  add column if not exists skip_repo_setup boolean not null default false;

comment on column public.assignments.skip_repo_setup is
  'Set by a caller that inserts an assignment and must not have its handout/solution repositories created automatically (CLI copy with --skip-repos). Respected by the insert trigger and the reconciler''s safety net; cleared by retry_assignment_repo_setup.';

-- ---------------------------------------------------------------------------------------------
-- 1. Status table
-- ---------------------------------------------------------------------------------------------
create type public.assignment_repo_kind as enum ('handout', 'solution');

create type public.assignment_repo_setup_state as enum (
  'queued',       -- a job is owed: waiting in the queue, or waiting to be retried
  'in_progress',  -- a worker picked the job up
  'ready',        -- the repository exists and the assignment points at it
  'failed',       -- automatic retries have stopped; an instructor has to look (Retry)
  'skipped'       -- nothing to create: repo_mode none/no_submission, or an E2E fixture
);

create table public.assignment_repo_setup (
  -- The surrogate key is for broadcast_course_table_change_unified and TableController, which
  -- both address a row by `id`. The identity of a row is (assignment_id, kind).
  id bigint generated always as identity primary key,
  assignment_id bigint not null references public.assignments(id) on delete cascade,
  class_id bigint not null references public.classes(id) on delete cascade,
  kind public.assignment_repo_kind not null,
  state public.assignment_repo_setup_state not null default 'queued',
  -- Jobs ENQUEUED for this row: the initial one, reconciler re-enqueues and instructor retries.
  -- Drives the reconciler's backoff and ceiling. Each job also retries up to five times inside
  -- github-async-worker; those show up in `failures`, not here.
  attempts integer not null default 0,
  -- Failed executions recorded by the worker, across all jobs. Shown to the instructor.
  failures integer not null default 0,
  last_attempt_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  repo_full_name text,
  -- api_gateway_calls row of the most recent job, for an operator following one job through.
  log_id bigint,
  -- Who is running setup for this row right now, and until when the claim holds. Serializes the
  -- worker's job with the synchronous edge-function wrappers (the CLI's assignment copy calls them
  -- right after inserting, while the insert trigger has already queued the same work): two
  -- createRepo calls for one name can each see the other's half-generated repository as empty and
  -- delete it. See claim_assignment_repo_setup.
  claimed_by text,
  claimed_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assignment_repo_setup_assignment_kind_key unique (assignment_id, kind)
);

comment on table public.assignment_repo_setup is
  'Server-side creation state of an assignment''s staff repositories (handout and solution/grader), one row per assignment and kind. Written by enqueue_assignment_repo_setup, github-async-worker (setup_handout_repo / setup_solution_repo) and reconcile_assignment_repo_setup; read by the assignment setup panel and the web_assignment_repo_setup_* metrics.';

create index assignment_repo_setup_class_id_idx on public.assignment_repo_setup (class_id);
create index assignment_repo_setup_not_ready_idx on public.assignment_repo_setup (state)
  where state in ('queued', 'in_progress', 'failed');

create trigger set_updated_at_on_assignment_repo_setup
  before update on public.assignment_repo_setup
  for each row execute function public.set_updated_at();

-- Staff-channel broadcast only: the table is not in broadcast_course_table_change_unified's
-- student-facing branch, so this is one message per changed row. A setup row changes a handful
-- of times in its life.
create trigger broadcast_assignment_repo_setup_realtime
  after insert or update or delete on public.assignment_repo_setup
  for each row execute function public.broadcast_course_table_change_unified();

alter table public.assignment_repo_setup enable row level security;

-- Read for course staff. There are no write policies: every write comes from the service role
-- (the worker) or from the SECURITY DEFINER functions below.
create policy "staff read assignment repo setup" on public.assignment_repo_setup
  for select to authenticated
  using (public.authorizeforclassgrader(class_id));

revoke all on table public.assignment_repo_setup from anon;
revoke insert, update, delete, truncate on table public.assignment_repo_setup from authenticated;
grant select on table public.assignment_repo_setup to authenticated;
grant all on table public.assignment_repo_setup to service_role;

-- ---------------------------------------------------------------------------------------------
-- 2. What the queues hold for these jobs
-- ---------------------------------------------------------------------------------------------
-- Same reasoning as repo_ids_with_queued_create: the queue is a table, so ask it whether a job is
-- still owed rather than guessing from timestamps. A pgmq message stays in q_<queue> until it is
-- archived, including while a worker holds it invisible, and requeueWithDelay sends the
-- replacement BEFORE archiving the original, so a job being retried is never briefly absent.
create or replace function public.assignment_repo_setup_jobs_in_flight()
returns table (assignment_id bigint, kind public.assignment_repo_kind)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct
         (q.message->'args'->>'assignment_id')::bigint,
         case q.message->>'method'
           when 'setup_handout_repo' then 'handout'::public.assignment_repo_kind
           else 'solution'::public.assignment_repo_kind
         end
    from (
      select message from pgmq.q_async_calls
      union all
      select message from pgmq.q_async_calls_low_priority
    ) q
   where q.message->>'method' in ('setup_handout_repo', 'setup_solution_repo')
     and q.message->'args'->>'assignment_id' is not null;
$$;

comment on function public.assignment_repo_setup_jobs_in_flight() is
  'Every (assignment, kind) with a setup_handout_repo / setup_solution_repo message still in a live async queue, worker-invisible ones included. A row listed here has a job that has not finished, so it must not be parked or re-enqueued.';

revoke all on function public.assignment_repo_setup_jobs_in_flight() from public, anon, authenticated;
grant execute on function public.assignment_repo_setup_jobs_in_flight() to service_role;

create or replace function public.assignment_repo_setup_jobs_dead_lettered()
returns table (assignment_id bigint, kind public.assignment_repo_kind, dead_lettered_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select (q.message->'args'->>'assignment_id')::bigint,
         case q.message->>'method'
           when 'setup_handout_repo' then 'handout'::public.assignment_repo_kind
           else 'solution'::public.assignment_repo_kind
         end,
         max(q.enqueued_at)
    from pgmq.q_async_calls_dlq q
   where q.message->>'method' in ('setup_handout_repo', 'setup_solution_repo')
     and q.message->'args'->>'assignment_id' is not null
   group by 1, 2;
$$;

comment on function public.assignment_repo_setup_jobs_dead_lettered() is
  'Setup jobs that were dead-lettered, with the most recent dead-letter time. Compare against assignment_repo_setup.last_attempt_at so an entry predating a newer attempt does not park it.';

revoke all on function public.assignment_repo_setup_jobs_dead_lettered() from public, anon, authenticated;
grant execute on function public.assignment_repo_setup_jobs_dead_lettered() to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Enqueue
-- ---------------------------------------------------------------------------------------------
-- Returns the pgmq message id, or NULL when nothing was sent: the assignment is gone, needs no
-- repositories (row marked skipped), its course has no GitHub org (row marked failed, since no
-- retry can fix that), or a job for this row is already in a queue (row left as it is).
create or replace function public.enqueue_assignment_repo_setup(
  p_assignment_id bigint,
  p_kind public.assignment_repo_kind,
  p_debug_id text default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id bigint;
  v_repo_mode text;
  v_org text;
  v_method public.github_async_method;
  v_log_id bigint;
  v_msg_id bigint;
begin
  select a.class_id, a.repo_mode::text, nullif(c.github_org, '')
    into v_class_id, v_repo_mode, v_org
    from public.assignments a
    join public.classes c on c.id = a.class_id
   where a.id = p_assignment_id;
  if not found then
    return null;
  end if;

  if v_repo_mode in ('none', 'no_submission') then
    insert into public.assignment_repo_setup (assignment_id, class_id, kind, state, completed_at)
    values (p_assignment_id, v_class_id, p_kind, 'skipped', now())
    on conflict (assignment_id, kind) do update
       set state = 'skipped', completed_at = now(), last_error = null, last_error_at = null;
    return null;
  end if;

  if v_org is null then
    insert into public.assignment_repo_setup (assignment_id, class_id, kind, state, last_error, last_error_at)
    values (p_assignment_id, v_class_id, p_kind, 'failed',
            'This course has no GitHub organization configured, so its repositories cannot be created. Set the organization on the course, then use Retry.',
            now())
    on conflict (assignment_id, kind) do update
       set state = 'failed', last_error = excluded.last_error, last_error_at = excluded.last_error_at;
    return null;
  end if;

  if exists (
    select 1 from public.assignment_repo_setup_jobs_in_flight() f
     where f.assignment_id = p_assignment_id and f.kind = p_kind
  ) then
    -- A job is already owed and still in a queue; a second one would only race it. Make sure
    -- the row exists so the job has somewhere to report, and otherwise leave it alone.
    insert into public.assignment_repo_setup (assignment_id, class_id, kind, state)
    values (p_assignment_id, v_class_id, p_kind, 'queued')
    on conflict (assignment_id, kind) do nothing;
    return null;
  end if;

  v_method := case p_kind
                when 'handout' then 'setup_handout_repo'::public.github_async_method
                else 'setup_solution_repo'::public.github_async_method
              end;

  insert into public.api_gateway_calls (method, status_code, class_id, debug_id)
  values (v_method, 0, v_class_id, p_debug_id)
  returning id into v_log_id;

  -- last_error is kept on purpose: until the new job reports, the previous failure is still the
  -- most recent thing known about this repository.
  insert into public.assignment_repo_setup (
    assignment_id, class_id, kind, state, attempts, last_attempt_at, log_id
  )
  values (p_assignment_id, v_class_id, p_kind, 'queued', 1, now(), v_log_id)
  on conflict (assignment_id, kind) do update
     set state = 'queued',
         attempts = public.assignment_repo_setup.attempts + 1,
         last_attempt_at = now(),
         log_id = excluded.log_id,
         started_at = null,
         completed_at = null;

  -- `org` is in the args for per-org lease attribution: pgmq_public.claim_org_slot_and_read
  -- charges a message to args.org, and the worker's circuit check reads the same field.
  select pgmq_public.send(
    'async_calls',
    jsonb_build_object(
      'method', v_method,
      'class_id', v_class_id,
      'debug_id', p_debug_id,
      'log_id', v_log_id,
      'args', jsonb_build_object('assignment_id', p_assignment_id, 'org', v_org)
    )
  ) into v_msg_id;

  return v_msg_id;
end;
$$;

comment on function public.enqueue_assignment_repo_setup(bigint, public.assignment_repo_kind, text) is
  'Queue the github-async-worker job that creates one of an assignment''s staff repositories (handout or solution), recording it on assignment_repo_setup. Internal: called by the assignments triggers, the reconciler and retry_assignment_repo_setup.';

revoke all on function public.enqueue_assignment_repo_setup(bigint, public.assignment_repo_kind, text)
  from public, anon, authenticated;
grant execute on function public.enqueue_assignment_repo_setup(bigint, public.assignment_repo_kind, text)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3a. Claim
-- ---------------------------------------------------------------------------------------------
-- Take the right to run setup for one row. True when the row was free, its claim had lapsed, or
-- the caller already holds it (a redelivered worker message reuses its holder id). Marks the row
-- in_progress. Released by every terminal report in record_assignment_repo_setup_event. The TTL
-- is the backstop for a holder that died without reporting; it is longer than any one setup
-- takes, so it never expires under a live holder in practice.
create or replace function public.claim_assignment_repo_setup(
  p_assignment_id bigint,
  p_kind public.assignment_repo_kind,
  p_holder text,
  p_ttl_seconds integer default 1800
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id bigint;
  v_claimed boolean;
begin
  select class_id into v_class_id from public.assignments where id = p_assignment_id;
  if not found then
    -- Deleted while queued. Let the caller run: it finds no assignment and reports a skip.
    return true;
  end if;

  insert into public.assignment_repo_setup (assignment_id, class_id, kind)
  values (p_assignment_id, v_class_id, p_kind)
  on conflict (assignment_id, kind) do nothing;

  update public.assignment_repo_setup
     set state = 'in_progress',
         started_at = now(),
         claimed_by = p_holder,
         claimed_until = now() + make_interval(secs => p_ttl_seconds)
   where assignment_id = p_assignment_id
     and kind = p_kind
     and (claimed_until is null or claimed_until < now() or claimed_by = p_holder)
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

comment on function public.claim_assignment_repo_setup(bigint, public.assignment_repo_kind, text, integer) is
  'Claim the right to run staff-repository setup for one (assignment, kind), so the worker job and a synchronous edge-function call never run createRepo for the same repository at once. Service role only.';

revoke all on function public.claim_assignment_repo_setup(bigint, public.assignment_repo_kind, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_assignment_repo_setup(bigint, public.assignment_repo_kind, text, integer)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3b. Job reports
-- ---------------------------------------------------------------------------------------------
-- The one writer of job outcomes, used by github-async-worker and the edge-function wrappers
-- (supabase/functions/_shared/assignmentRepoSetup.ts). An upsert, so a direct edge-function call
-- for an assignment with no row yet still leaves a record. Events:
--   started         a worker or wrapper began running the job (claim_assignment_repo_setup does
--                   this and also takes the claim; kept for callers that only report)
--   succeeded       repository exists and is recorded on the assignment
-- Every event after `started` releases the claim.
--   skipped         nothing to create (no repositories for this mode, or an E2E fixture)
--   attempt_failed  one execution failed; the job will be retried, so the row stays queued
--   gave_up         no more automatic retries (dead-lettered, or a direct call that failed)
create or replace function public.record_assignment_repo_setup_event(
  p_assignment_id bigint,
  p_kind public.assignment_repo_kind,
  p_event text,
  p_repo_full_name text default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id bigint;
begin
  select class_id into v_class_id from public.assignments where id = p_assignment_id;
  if not found then
    return;  -- the assignment was deleted while its job was in flight; nothing to report on
  end if;

  insert into public.assignment_repo_setup (assignment_id, class_id, kind)
  values (p_assignment_id, v_class_id, p_kind)
  on conflict (assignment_id, kind) do nothing;

  if p_event = 'started' then
    update public.assignment_repo_setup
       set state = 'in_progress', started_at = now()
     where assignment_id = p_assignment_id and kind = p_kind;
  elsif p_event = 'succeeded' then
    update public.assignment_repo_setup
       set state = 'ready',
           repo_full_name = coalesce(p_repo_full_name, repo_full_name),
           completed_at = now(),
           last_error = null,
           last_error_at = null,
           claimed_by = null,
           claimed_until = null
     where assignment_id = p_assignment_id and kind = p_kind;
  elsif p_event = 'skipped' then
    update public.assignment_repo_setup
       set state = 'skipped',
           repo_full_name = coalesce(p_repo_full_name, repo_full_name),
           completed_at = now(),
           last_error = null,
           last_error_at = null,
           claimed_by = null,
           claimed_until = null
     where assignment_id = p_assignment_id and kind = p_kind;
  elsif p_event = 'attempt_failed' then
    update public.assignment_repo_setup
       set state = 'queued',
           failures = failures + 1,
           last_error = coalesce(p_error, last_error),
           last_error_at = now(),
           claimed_by = null,
           claimed_until = null
     where assignment_id = p_assignment_id and kind = p_kind;
  elsif p_event = 'gave_up' then
    update public.assignment_repo_setup
       set state = 'failed',
           last_error = coalesce(p_error, last_error,
             'Repository setup failed and automatic retries have stopped. Use Retry once the cause is fixed.'),
           last_error_at = now(),
           claimed_by = null,
           claimed_until = null
     where assignment_id = p_assignment_id and kind = p_kind;
  else
    raise exception 'Unknown assignment repo setup event: %', p_event;
  end if;
end;
$$;

comment on function public.record_assignment_repo_setup_event(bigint, public.assignment_repo_kind, text, text, text) is
  'Record a staff-repository setup job transition (started / succeeded / skipped / attempt_failed / gave_up) on assignment_repo_setup. Service role only: called by github-async-worker and the assignment-create-*-repo edge functions.';

revoke all on function public.record_assignment_repo_setup_event(bigint, public.assignment_repo_kind, text, text, text)
  from public, anon, authenticated;
grant execute on function public.record_assignment_repo_setup_event(bigint, public.assignment_repo_kind, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------------------------
-- 4. Triggers on assignments
-- ---------------------------------------------------------------------------------------------
create or replace function public.enqueue_assignment_repo_setup_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.repo_mode::text in ('none', 'no_submission') then
    return new;
  end if;
  if new.skip_repo_setup then
    insert into public.assignment_repo_setup (assignment_id, class_id, kind, state, last_error)
    select new.id, new.class_id, k.kind, 'skipped',
           'Repository setup was skipped when this assignment was created (for example, copied with --skip-repos). Use Retry to create the repository.'
      from unnest(enum_range(null::public.assignment_repo_kind)) as k(kind)
    on conflict (assignment_id, kind) do nothing;
    return new;
  end if;
  perform public.enqueue_assignment_repo_setup(new.id, 'handout');
  perform public.enqueue_assignment_repo_setup(new.id, 'solution');
  return new;
end;
$$;

revoke all on function public.enqueue_assignment_repo_setup_on_insert() from public, anon, authenticated;

create trigger enqueue_assignment_repo_setup_on_insert
  after insert on public.assignments
  for each row execute function public.enqueue_assignment_repo_setup_on_insert();

-- Switching an assignment between "no repositories" and a repository mode after creation. The
-- edit page allows it, and nothing used to create the repositories when it happened. Leaving a
-- repository mode marks rows that never finished as skipped, so they stop showing as failed.
create or replace function public.enqueue_assignment_repo_setup_on_repo_mode_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old_needs boolean := old.repo_mode::text not in ('none', 'no_submission');
  v_new_needs boolean := new.repo_mode::text not in ('none', 'no_submission');
  v_kind public.assignment_repo_kind;
begin
  if v_new_needs and not v_old_needs and not new.skip_repo_setup then
    foreach v_kind in array enum_range(null::public.assignment_repo_kind) loop
      -- A repository that already exists from before the switch stays as it is. Anything else
      -- starts a fresh automatic budget: attempts spent under the old mode say nothing about this
      -- one, and carrying them over could park the row at the ceiling on its first failure.
      if not exists (
        select 1 from public.assignment_repo_setup s
         where s.assignment_id = new.id and s.kind = v_kind and s.state = 'ready'
      ) then
        update public.assignment_repo_setup
           set attempts = 0
         where assignment_id = new.id and kind = v_kind;
        perform public.enqueue_assignment_repo_setup(new.id, v_kind);
      end if;
    end loop;
  elsif v_old_needs and not v_new_needs then
    update public.assignment_repo_setup
       set state = 'skipped', completed_at = now()
     where assignment_id = new.id
       and state <> 'ready';
  end if;
  return new;
end;
$$;

revoke all on function public.enqueue_assignment_repo_setup_on_repo_mode_change() from public, anon, authenticated;

create trigger enqueue_assignment_repo_setup_on_repo_mode_change
  after update of repo_mode on public.assignments
  for each row
  when (old.repo_mode is distinct from new.repo_mode)
  execute function public.enqueue_assignment_repo_setup_on_repo_mode_change();

-- ---------------------------------------------------------------------------------------------
-- 5. Instructor retry
-- ---------------------------------------------------------------------------------------------
create or replace function public.retry_assignment_repo_setup(
  p_assignment_id bigint,
  p_kind public.assignment_repo_kind
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_class_id bigint;
  v_msg_id bigint;
begin
  select class_id into v_class_id from public.assignments where id = p_assignment_id;
  if not found then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;
  if not public.authorizeforclassinstructor(v_class_id) then
    raise exception 'Not authorized to retry repository setup for this class';
  end if;

  if exists (
    select 1 from public.assignment_repo_setup_jobs_in_flight() f
     where f.assignment_id = p_assignment_id and f.kind = p_kind
  ) then
    raise exception 'Setup of this repository is already queued or running. Wait for it to finish before retrying.';
  end if;

  -- A retry is an explicit request for the repository, so it overrides an insert-time opt-out.
  update public.assignments set skip_repo_setup = false where id = p_assignment_id and skip_repo_setup;

  v_msg_id := public.enqueue_assignment_repo_setup(p_assignment_id, p_kind);

  if v_msg_id is not null then
    -- A deliberate retry states that the underlying problem is fixed, so it starts a fresh
    -- automatic budget (this job counts as its first attempt) and clears the error it answers.
    update public.assignment_repo_setup
       set attempts = 1, last_error = null, last_error_at = null
     where assignment_id = p_assignment_id and kind = p_kind;
  end if;

  return v_msg_id;
end;
$$;

comment on function public.retry_assignment_repo_setup(bigint, public.assignment_repo_kind) is
  'Instructor action: queue a fresh attempt at creating one of an assignment''s staff repositories. Refuses while a job for it is still in a queue. Returns NULL when nothing could be queued; the row then says why (skipped, or failed with a reason).';

revoke all on function public.retry_assignment_repo_setup(bigint, public.assignment_repo_kind) from public, anon;
grant execute on function public.retry_assignment_repo_setup(bigint, public.assignment_repo_kind) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. Reconciler
-- ---------------------------------------------------------------------------------------------
-- Modelled on reconcile_stuck_repo_creations (20260910010000): park on evidence from the queue,
-- not on a timer, back off exponentially on attempts, and stop at a ceiling.
create or replace function public.reconcile_assignment_repo_setup(p_stale_minutes integer default 15)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_count integer := 0;
  v_max_attempts constant integer := 8;
  v_max_backoff_doublings constant integer := 5;  -- caps the interval at 32x p_stale_minutes
  v_in_flight text[];
begin
  -- Read once per tick, not probed per row: the queue tables have no index on the envelope.
  select coalesce(array_agg(f.assignment_id || ':' || f.kind), '{}'::text[])
    into v_in_flight
    from public.assignment_repo_setup_jobs_in_flight() f;

  -- Park a row whose most recent job was dead-lettered. The worker marks the row failed itself
  -- when it dead-letters a job; this covers the paths where that write did not happen (the
  -- poison-message path, or the status write failing). Keeps the worker's message if it has one.
  update public.assignment_repo_setup s
     set state = 'failed',
         last_error = coalesce(s.last_error,
           'Repository setup failed and its job was dead-lettered, so automatic retries have stopped. Check the course''s GitHub organization and template repositories, then use Retry.'),
         last_error_at = coalesce(s.last_error_at, now())
   where s.state in ('queued', 'in_progress')
     and (s.assignment_id || ':' || s.kind) <> all (v_in_flight)
     and (s.claimed_until is null or s.claimed_until < now())  -- a live holder is not lost
     and exists (
           select 1 from public.assignment_repo_setup_jobs_dead_lettered() d
            where d.assignment_id = s.assignment_id
              and d.kind = s.kind
              and d.dead_lettered_at >= coalesce(s.last_attempt_at, s.created_at)
         );

  -- Park a row that has used up its automatic attempts and gone quiet for the interval its next
  -- attempt would have waited.
  update public.assignment_repo_setup s
     set state = 'failed',
         last_error = format(
           'Repository setup did not succeed after %s automatic attempts.%s Use Retry once the cause is fixed.',
           v_max_attempts,
           case when s.last_error is not null then ' Last error: ' || s.last_error else '' end),
         last_error_at = now()
   where s.state in ('queued', 'in_progress')
     and s.attempts >= v_max_attempts
     and (s.assignment_id || ':' || s.kind) <> all (v_in_flight)
     and (s.claimed_until is null or s.claimed_until < now())  -- a live holder is not lost
     and coalesce(s.last_attempt_at, s.created_at) < now() - make_interval(
           mins => p_stale_minutes * (2 ^ least(s.attempts, v_max_backoff_doublings))::int);

  -- Re-enqueue a row that is still owed a job but has none in any queue: the message was lost,
  -- or archived without the row being updated.
  for r in
    select s.assignment_id, s.kind
      from public.assignment_repo_setup s
     where s.state in ('queued', 'in_progress')
       and s.attempts < v_max_attempts
       and (s.assignment_id || ':' || s.kind) <> all (v_in_flight)
     and (s.claimed_until is null or s.claimed_until < now())  -- a live holder is not lost
       and coalesce(s.last_attempt_at, s.created_at) < now() - make_interval(
             mins => p_stale_minutes * (2 ^ least(greatest(s.attempts - 1, 0), v_max_backoff_doublings))::int)
  loop
    if public.enqueue_assignment_repo_setup(r.assignment_id, r.kind) is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  -- Safety net: a recent assignment that needs repositories but has no row at all, because some
  -- path inserted it without the trigger running (a restore, a bulk load with triggers off).
  for r in
    select a.id as assignment_id, k.kind
      from public.assignments a
     cross join unnest(enum_range(null::public.assignment_repo_kind)) as k(kind)
     where a.created_at > now() - interval '7 days'
       and a.created_at < now() - make_interval(mins => p_stale_minutes)
       and a.repo_mode::text not in ('none', 'no_submission')
       and not a.skip_repo_setup
       and not exists (
             select 1 from public.assignment_repo_setup s
              where s.assignment_id = a.id and s.kind = k.kind)
  loop
    if public.enqueue_assignment_repo_setup(r.assignment_id, r.kind) is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

comment on function public.reconcile_assignment_repo_setup(integer) is
  'Re-enqueue lost staff-repository setup jobs with exponential backoff, park rows whose job was dead-lettered or that exhausted their attempts, and create rows for recent assignments that have none. Called by github-repo-reconciler every 15 minutes. Returns the number of jobs enqueued.';

revoke all on function public.reconcile_assignment_repo_setup(integer) from public, anon, authenticated;
grant execute on function public.reconcile_assignment_repo_setup(integer) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. Readiness checklist for the assignment page
-- ---------------------------------------------------------------------------------------------
-- One call instead of four reads, and through SECURITY DEFINER because
-- assignment_handout_file_hashes is instructor-only under RLS while the panel is shown to all
-- course staff.
create or replace function public.get_assignment_repo_setup_checks(p_assignment_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_a record;
  v_ag record;
  v_hashes_seeded boolean;
begin
  select a.id, a.class_id, a.repo_mode::text as repo_mode, a.has_autograder, a.template_repo,
         a.latest_template_sha, a.release_date
    into v_a
    from public.assignments a
   where a.id = p_assignment_id;
  if not found then
    raise exception 'Assignment % not found', p_assignment_id;
  end if;
  if not public.authorizeforclassgrader(v_a.class_id) then
    raise exception 'Not authorized to view this assignment''s setup';
  end if;

  select ag.grader_repo, ag.config, ag.latest_autograder_sha, ag.workflow_sha
    into v_ag
    from public.autograder ag
   where ag.id = p_assignment_id;

  select exists (
    select 1 from public.assignment_handout_file_hashes h
     where h.assignment_id = p_assignment_id
       and h.sha = v_a.latest_template_sha
  ) into v_hashes_seeded;

  return jsonb_build_object(
    'repo_mode', v_a.repo_mode,
    'has_autograder', coalesce(v_a.has_autograder, true),
    'release_date', v_a.release_date,
    'template_repo', v_a.template_repo,
    'latest_template_sha', v_a.latest_template_sha,
    'workflow_sha_set', v_ag.workflow_sha is not null,
    'grader_repo', v_ag.grader_repo,
    'config_present', v_ag.config is not null,
    'graded_parts_count', coalesce(jsonb_array_length(
        case when jsonb_typeof(v_ag.config->'gradedParts') = 'array' then v_ag.config->'gradedParts' end), 0),
    'latest_autograder_sha', v_ag.latest_autograder_sha,
    'handout_hashes_seeded', coalesce(v_hashes_seeded, false)
  );
end;
$$;

comment on function public.get_assignment_repo_setup_checks(bigint) is
  'The pointers and derived state an assignment needs before students can be graded: handout repo and sha, workflow hash, grader repo, parsed config, grader sha, seeded handout hashes. Course staff only.';

revoke all on function public.get_assignment_repo_setup_checks(bigint) from public, anon;
grant execute on function public.get_assignment_repo_setup_checks(bigint) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 8. Metrics
-- ---------------------------------------------------------------------------------------------
-- Driver for the web_assignment_repo_setup_* gauges (lib/metrics.ts). Deliberately NOT a
-- postgres-exporter query: that ConfigMap is hashed into the primary's restart checksum.
--
-- Two populations, because the backfill below marks every historical assignment without a
-- recorded repository as failed, and those must not page anyone:
--   * count/oldest_seconds cover rows the new path has actually attempted (last_attempt_at set).
--   * at_risk covers any row, attempted or not, on an assignment that is open now or opens within
--     24 hours -- released, or about to be, and not yet due -- whose missing repository matters:
--     always for the handout, and for the solution only when the assignment is autograded.
create or replace function public.metrics_assignment_repo_setup()
returns table (
  class_id text,
  kind text,
  state text,
  count bigint,
  at_risk bigint,
  oldest_seconds double precision
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.class_id::text,
         s.kind::text,
         s.state::text,
         count(*) filter (where s.last_attempt_at is not null)::bigint,
         count(*) filter (
           where coalesce(a.release_date, a.created_at) <= now() + interval '24 hours'
             and a.due_date > now()
             and (s.kind = 'handout' or coalesce(a.has_autograder, true))
         )::bigint,
         coalesce(max(extract(epoch from now() - s.last_attempt_at))
                    filter (where s.state in ('queued', 'in_progress') and s.last_attempt_at is not null), 0)::double precision
    from public.assignment_repo_setup s
    join public.assignments a on a.id = s.assignment_id
   where s.state in ('queued', 'in_progress', 'failed')
   group by s.class_id, s.kind, s.state;
$$;

comment on function public.metrics_assignment_repo_setup() is
  'Not-ready staff-repository setup rows by class, kind and state: count of rows the server-side path attempted, count at risk (assignment open or opening within 24h and not yet due), and age of the oldest pending attempt. Driver for web_assignment_repo_setup_*.';

revoke all on function public.metrics_assignment_repo_setup() from public, anon, authenticated;
grant execute on function public.metrics_assignment_repo_setup() to service_role;

-- ---------------------------------------------------------------------------------------------
-- 9. Backfill
-- ---------------------------------------------------------------------------------------------
-- One row per existing assignment that needs repositories. Ready when the pointer is recorded --
-- for the solution, the pointer AND the parsed config, because the old solution setup wrote the
-- pointer before creating the repository and a failure after that left a pointer to nothing.
-- Failed otherwise -- with no job queued, so this migration creates nothing on GitHub. Those
-- failed rows are what put a Retry button in front of an instructor with a broken assignment.
-- "Ready" means the pointer exists; whether the repository behind it is complete is what the
-- readiness checklist shows.
insert into public.assignment_repo_setup (
  assignment_id, class_id, kind, state, repo_full_name, completed_at, last_error, last_error_at
)
select a.id,
       a.class_id,
       'handout',
       case when a.template_repo is not null then 'ready' else 'failed' end::public.assignment_repo_setup_state,
       a.template_repo,
       case when a.template_repo is not null then a.created_at end,
       case when a.template_repo is null then
         'No handout repository is recorded for this assignment. It was created before repository setup moved to the server; use Retry to create it.'
       end,
       case when a.template_repo is null then now() end
  from public.assignments a
 where a.repo_mode::text not in ('none', 'no_submission')
on conflict (assignment_id, kind) do nothing;

insert into public.assignment_repo_setup (
  assignment_id, class_id, kind, state, repo_full_name, completed_at, last_error, last_error_at
)
select a.id,
       a.class_id,
       'solution',
       case when ag.grader_repo is not null and ag.config is not null then 'ready' else 'failed' end::public.assignment_repo_setup_state,
       ag.grader_repo,
       case when ag.grader_repo is not null and ag.config is not null then a.created_at end,
       case
         when ag.grader_repo is null then
           'No solution repository is recorded for this assignment. It was created before repository setup moved to the server; use Retry to create it.'
         when ag.config is null then
           format('A solution repository (%s) is recorded but its pawtograder.yml was never read, so the old setup may have stopped part-way: it recorded the repository before creating it. If the repository exists, pushing to it records the config; otherwise use Retry.', ag.grader_repo)
       end,
       case when ag.grader_repo is null or ag.config is null then now() end
  from public.assignments a
  left join public.autograder ag on ag.id = a.id
 where a.repo_mode::text not in ('none', 'no_submission')
on conflict (assignment_id, kind) do nothing;

-- ---------------------------------------------------------------------------------------------
-- 10. Per-org lease attribution for the new methods
-- ---------------------------------------------------------------------------------------------
-- github-async-worker resolves a message's org per method, and claim_org_slot_and_read mirrors
-- that list in v_org_expr so the per-org slot budget is charged to the org the handler will call
-- (see the comment at the resolver in github-async-worker/index.ts). The two new methods carry
-- args.org, which the expression already reads first; they only have to be named. Without this
-- they would still drain, but charged to the '(unknown-method)' bucket rather than their org.
--
-- Re-created verbatim from 20260914120000_async_lease_pin_org.sql except for the method list.
create or replace function pgmq_public.claim_org_slot_and_read(
  queue_name text,
  sleep_seconds integer,
  n integer,
  holder text,
  lease_ttl_seconds integer,
  max_per_org integer,
  global_cap integer,
  pin_org text default null
)
returns setof pgmq_public.org_slot_row
language plpgsql
set search_path to ''
as $function$
declare
  -- pgmq.format_table_name is not just convenience. It is the injection guard, rejecting a
  -- queue_name containing $, ; or -- before it is ever interpolated with %I.
  v_qtable text := pgmq.format_table_name(queue_name, 'q');
  -- lower() because pgmq.format_table_name and pgmq.create both lowercase. 'Async_Calls' would
  -- otherwise find the queue TABLE but match no slot rows, which looks exactly like an exhausted
  -- pool and would claim nothing forever.
  v_queue text := lower(queue_name);
  v_own_slot int;
  v_own_count int;
  -- Folded through the SAME lower() the partition key uses. A caller pins with the org string a
  -- previous claim handed it, and that string is already folded, but a caller that assembles one
  -- from classes.github_org or from an envelope would otherwise fail to match its own org and read
  -- back 'no_demand' forever.
  v_pin text := lower(pin_org);
  -- THE PARTITION KEY, DEFINED ONCE. Both `demand` and `picked` below are handed THIS string by
  -- format(), because the two of them disagreeing about which org a message belongs to would mean
  -- claiming a slot for one org and then reading another org's work. It used to be written out once
  -- inside a `ready` CTE that `picked` then semijoined to on msg_id; carrying it as one interpolated
  -- expression is the same guarantee -- one definition, one place to edit -- without forcing every
  -- consumer to materialize the whole backlog first.
  --
  -- It is an expression over ONE QUEUE ROW and nothing else. `q` is the only alias it mentions, so
  -- any scan of a queue table can apply it directly, including one that stops after four rows. See
  -- the note above the classes index for why that matters and what it costs.
  --
  -- This MIRRORS the worker's own org resolver, the one guarding the circuit breaker in
  -- github-async-worker/index.ts (the `if (envelope.method === ...)` chain that ends in
  -- `throw new Error("Unknown method...")`). It has to: the budget must be charged to the org the
  -- handler is going to call, and that resolver is what decides which org that is.
  --
  --   create_repo, sync_student_team, sync_staff_team, sync_repo_permissions,
  --   archive_repo_and_lock, fetch_repo_analytics        -> args.org
  --   rerun_autograder                                   -> owner of args.repository
  --   sync_repo_to_handout                               -> owner of args.repository_full_name
  --
  -- The set is CLOSED, not open-ended: those eight are exactly the `case` labels in processEnvelope,
  -- whose `default` arm throws `Unknown async method`, so a ninth method fails on every delivery and
  -- ends up in the DLQ. Note the order, because it is the opposite of what "before it can reach
  -- here" would suggest: the claim runs FIRST, so an unknown method reaches this expression before
  -- any worker sees it, which is what the '(unknown-method)' bucket in decision 3 is for. The
  -- circuit-breaker resolver throws too, but that one is caught and reported to Sentry rather than
  -- failing the message. The three envelope fields are mutually exclusive by method, so the coalesce
  -- order among them does not matter. Four decisions:
  --
  -- 1. THE ENVELOPE FIRST. The handler calls GitHub against the owner baked into the envelope, not
  --    against whatever classes.github_org says today. If an instructor repoints a class at a new
  --    org while jobs are queued, attributing that in-flight work to the new org charges the budget
  --    to an org no handler is going to touch, and lets the old one exceed max_per_org.
  --    split_part(x, '/', 1) is the SQL spelling of the resolver's repo.split("/")[0].
  --
  --    KNOWN EXCEPTION, AND IT IS NOT THEORETICAL. That paragraph is true of syncStudentTeam and
  --    syncStaffTeam, which are called with args.org, but NOT of the invitation path in the same
  --    two handlers: github-async-worker/index.ts calls reinviteToOrgTeam with
  --    data.classes.github_org, the CURRENT value, a dozen lines above calling syncStudentTeam with
  --    args.org. So a repointed class makes one handler talk to two orgs at once: the invitation
  --    spends the NEW org's shared content limiter while the slot it is running under is charged to
  --    the OLD org. Concurrent stale and fresh envelopes can therefore push the new org past the
  --    occupancy this function exists to bound, and convoy invitations inside its limiter.
  --
  --    NOT FIXED HERE, because the two candidate fixes are product decisions rather than allocator
  --    ones: reject or re-enqueue a team-sync envelope whose args.org no longer matches its class,
  --    or make the invitation target args.org and accept that a repointed class stops inviting to
  --    the org it actually moved to. Changing this expression cannot fix it -- whichever org the
  --    allocator picks, the handler still calls two different ones. Raised by Codex on #982.
  -- 2. classes.github_org as the FALLBACK, and it carries real traffic: args.org is missing from
  --    about one envelope in seven, and those are not a random seventh. The lookup compares c.id::text rather than casting the envelope to bigint, which
  --    cannot raise on a malformed class_id, and it puts the cast on `classes` (a few hundred rows,
  --    indexed on exactly that expression above) instead of on every queued message. Because it
  --    sits inside the coalesce it runs only when every envelope arm came back null -- that same
  --    one row in seven -- rather than once per scanned row.
  --
  --    IT IS WRAPPED IN nullif(..., '') FOR THE SAME REASON THE THREE ENVELOPE ARMS ARE, and the
  --    consequence of leaving it unwrapped is worse here than a mis-labelled bucket. classes.github_org
  --    is nullable with no check constraint, and '' is a state this schema already expects: five other
  --    migrations guard it by hand (`c.github_org is not null and c.github_org <> ''` in
  --    20250908133405, 20251004115504 and 20260909170000, `nullif(trim(c.github_org), '') is not null`
  --    in 20260315200001 and 20260322000001). An unwrapped fallback answers `org = ''` for every message
  --    of such a class, and coalesce stops there, so the '(unresolved)' sentinel below is never
  --    reached. The claim then returns org = '' and _shared/orgLeaseRun.ts refuses to pin on it
  --    (`if (!held || heldQueueName === null || !heldOrgValue) return null`), so continuous refill
  --    quiesces on every top-up and the run silently degrades to the batch-at-a-time behaviour this
  --    whole branch exists to remove -- while every liveness signal stays green. With the nullif the
  --    class falls through to '(unresolved)', which is a non-empty org string like any other: it
  --    pins, it drains, and it is already documented in the function comment as a bucket a claim can
  --    come back holding. Whitespace-only is deliberately NOT trimmed here: ' ' resolves to a
  --    non-empty bucket that pins and drains correctly, so it does not exhibit this defect, and
  --    trimming it would silently re-bucket padded org names as an unrelated change.
  -- 3. A METHOD THIS LIST DOES NOT KNOW gets its own bucket rather than the class fallback. A method
  --    whose name we do not recognize is a method whose org field we may not recognize either, so
  --    falling back to the class would be the same silent mis-budgeting this whole expression exists
  --    to stop. The bucket still drains like any other org, so nothing is stranded. Because the
  --    worker's switch throws on every method outside the eight, a non-empty '(unknown-method)'
  --    bucket in async_worker_slots.org means the two lists have drifted, and the messages in it are
  --    on their way to the DLQ.
  -- 4. lower() over the whole thing. GitHub org names are case-insensitive and one class in prod
  --    already stores a mixed-case github_org, so 'Khoury-CS' and 'khoury-cs' are one org sharing
  --    one rate-limit bucket. Without the fold they would each draw a full max_per_org allowance
  --    against that single bucket.
  v_org_expr constant text := $ORG$
        case when q.message->>'method' in (
                  'create_repo', 'sync_student_team', 'sync_staff_team',
                  'sync_repo_permissions', 'archive_repo_and_lock', 'fetch_repo_analytics',
                  'rerun_autograder', 'sync_repo_to_handout',
                  'setup_handout_repo', 'setup_solution_repo')
             then lower(coalesce(
                    nullif(q.message->'args'->>'org', ''),
                    nullif(split_part(q.message->'args'->>'repository', '/', 1), ''),
                    nullif(split_part(q.message->'args'->>'repository_full_name', '/', 1), ''),
                    nullif((select c.github_org
                              from public.classes c
                             where c.id::text = q.message->>'class_id'), ''),
                    '(unresolved)'))
             else '(unknown-method)'
        end
  $ORG$;
  v_sql text;
begin
  if holder is null or holder = '' then
    raise exception 'claim_org_slot_and_read: holder must be a non-empty string';
  end if;
  if n is null or n < 1 then
    raise exception 'claim_org_slot_and_read: n must be >= 1 (got %)', n;
  end if;
  if sleep_seconds is null or sleep_seconds < 0 then
    raise exception 'claim_org_slot_and_read: sleep_seconds must be >= 0 (got %)', sleep_seconds;
  end if;
  if lease_ttl_seconds is null or lease_ttl_seconds < 1 then
    raise exception 'claim_org_slot_and_read: lease_ttl_seconds must be >= 1 (got %)', lease_ttl_seconds;
  end if;
  -- Empty string is a caller error rather than a way to spell "no pin", which is what the NULL
  -- default is for. Rejecting it matches how holder = '' is treated: a malformed argument arrives
  -- as an exception the worker reports, not as a silent change of behavior.
  if pin_org is not null and pin_org = '' then
    raise exception 'claim_org_slot_and_read: pin_org must be a non-empty org, or null for no pin';
  end if;

  -- A zero or negative budget is a legitimate "stop claiming" instruction, not an error, so report
  -- it as lack of capacity rather than raising.
  if max_per_org is null or max_per_org < 1 or global_cap is null or global_cap < 1 then
    return query select 'no_capacity'::text, null::text, null::bigint, null::integer,
                        null::timestamptz, null::timestamptz, null::jsonb;
    return;
  end if;

  -- FAIL LOUD ON AN UNSEEDED POOL. An empty pool and an empty queue used to produce the same answer,
  -- and that ambiguity is how the missing async_calls_low_priority pool became "drains nothing while
  -- every liveness signal stays green". A queue with no pool at all is a deployment error rather
  -- than a runtime state, so it arrives as an exception on the first call. One index-only lookup on
  -- the (queue_name, slot) key, taken before the advisory lock so a misconfigured caller cannot
  -- serialize anyone else while it fails.
  if not exists (select 1 from public.async_worker_slots s where s.queue_name = v_queue) then
    raise exception 'claim_org_slot_and_read: no slot pool seeded for queue %, so this queue can '
                    'never drain. Seed public.async_worker_slots in a migration.', v_queue;
  end if;

  -- ONE GLOBAL LOCK, NOT ONE PER QUEUE, and the difference affects correctness rather than style.
  -- The budgets this function enforces are counted across every pool (see `live` below), so the
  -- state the lock protects spans queues and the lock has to span them too. A per-queue key would
  -- let an allocator on async_calls and one on async_calls_low_priority read the same slot counts
  -- at the same instant and both admit a leaseholder, which is precisely the read-then-act race the
  -- lock exists to close. Keying on the queue name also made the lock sensitive to the caller's
  -- capitalization, so 'Async_Calls' and 'async_calls' serialized separately against one pool.
  -- 1346850129 is 0x50474D51 ('PGMQ') in the two-integer advisory lock space, which is disjoint
  -- from the single-bigint space the gradebook functions use.
  perform pg_advisory_xact_lock(1346850129, 0);

  -- TAKE OUR OWN ROW FIRST, AND TAKE IT BLOCKING.
  --
  -- The allocator used to express "reuse the slot I already hold" as an ORDER BY preference inside
  -- the claim statement, under FOR UPDATE SKIP LOCKED. That is not an invariant, it is a hint, and
  -- SKIP LOCKED discards it precisely when it matters: if the caller's own renewal timer holds the
  -- row lock at that instant, the preferred row is skipped and the claim takes a DIFFERENT free row
  -- instead. The holder then owns two rows in one pool, renew_org_slot refreshes both forever
  -- (it matches on queue and holder, not on slot), and the extra one occupies global_cap and
  -- max_per_org while no leaseholder is doing its work. The global advisory lock does not help,
  -- because it serializes allocators against each other and renew_org_slot never takes it.
  --
  -- So the caller's own row is resolved in its own statement, with a plain blocking FOR UPDATE, and
  -- the claim below is then restricted to that one row. A row already locked by the CURRENT
  -- transaction is not skipped by SKIP LOCKED, so the reuse becomes unconditional.
  --
  -- WHY THIS CANNOT DEADLOCK, now that two lock types are in play:
  --
  --   * Allocator against allocator is impossible. Every allocator takes the global advisory lock
  --     before any row lock and holds it until commit, so only one is ever inside this section.
  --   * Allocator against renew or release. This statement only ever waits on rows bearing its OWN
  --     holder. renew_org_slot and release_org_slot select rows by (queue_name, holder) and take no
  --     other lock of any kind, so once either of them is running it cannot wait on anything and
  --     cannot be the second edge of a cycle. Only a renew or release for THIS SAME holder can
  --     contend at all, and the wait is on one row of one single-row UPDATE.
  --   * Ordering. Our own row is locked BEFORE any free row. The reverse order would be the risky
  --     one, because then we could hold a free row while waiting for our own.
  --
  -- The cost is that a blocking wait happens while the global advisory lock is held, so a slow
  -- blocker stalls every allocator. The blocker is one single-row UPDATE with no further locks to
  -- acquire, so the wait is bounded by that statement rather than by anything a caller controls.
  --
  -- Locking every row we own rather than just one also repairs the damage the old race could
  -- already have done: a holder that ended up on two rows is cut back to one here, and the surplus
  -- is released rather than left to be renewed forever.
  with mine as (
    select s.slot
      from public.async_worker_slots s
     where s.queue_name = v_queue
       and s.holder = claim_org_slot_and_read.holder
     order by s.slot
       for update
  )
  select min(m.slot), count(*) into v_own_slot, v_own_count from mine m;

  if coalesce(v_own_count, 0) > 1 then
    update public.async_worker_slots s
       set org = null, holder = null, claimed_at = null, expires_at = '-infinity'
     where s.queue_name = v_queue
       and s.holder = claim_org_slot_and_read.holder
       and s.slot <> v_own_slot;
  end if;

  v_sql := format($QUERY$
    with demand as (
        -- HOW MANY READY MESSAGES EACH ORG HAS, except that the count is deliberately CAPPED and
        -- the scan is deliberately allowed to stop early when the caller pinned an org.
        --
        -- The org expression below is v_org_expr, the partition key declared once above, dropped
        -- in by format() at the sixth argument. Note that a literal percent sign cannot appear
        -- anywhere in this template -- including in these comments, which format() rewrites just
        -- like the SQL around them -- although it can appear inside an interpolated argument.
        --
        -- THE PIN FILTER IS HERE as well as in `winner` and in the status arm below, where it is
        -- now redundant. It is here because it is the only place it can stop the scan: a pinned
        -- caller has exactly one candidate org, so every row belonging to any other org is work
        -- this call will not use. The two redundant copies are left alone because they are where
        -- the pin's MEANING is argued, and re-testing an equality against the handful of rows
        -- `demand` returns costs nothing.
        --
        -- THE CAP, WHICH IS THE PART THAT NEEDS AN ARGUMENT. `ready` escapes this CTE through
        -- exactly one shape, least(ceil(ready / n) + a_all, max_per_org), which appears in the
        -- winner's admission test and in its second ORDER BY key; the status arm below needs only
        -- whether the org appears at all. That expression saturates: once ready >= n * max_per_org,
        -- ceil(ready / n) >= max_per_org, so least() returns max_per_org whatever a_all is, and
        -- below that the cap is not reached and the count is exact. A count clamped at
        -- n * max_per_org is therefore indistinguishable from the true count in every consumer.
        --
        -- The clamp holds a fortiori under what is actually in force, since the header proves the
        -- ceil arm cannot bind at all: the only thing this count decides today is whether the org
        -- appears. The saturation argument is written out anyway so the clamp stays justified if
        -- the admission test is ever repaired.
        --
        -- The clamp is applied ONLY on the pinned path, and that is not an accident. Clamping
        -- unpinned would need a per-org limit, which needs the orgs enumerated, which needs the
        -- whole scan -- there is nothing to save. It also keeps the clamp away from the one
        -- consumer whose value is not provably inert: the ORDER BY tiebreak. A pinned call has at
        -- most one candidate row, so it never orders anything.
        --
        -- LIMIT NULL is Postgres for "no limit", which is what the unpinned path gets: the same
        -- exact per-org counts over the same full scan as before.
        select r.org, count(*)::int as ready
          from (
                select r0.org
                  from (
                        select %6$s as org
                          from pgmq.%1$I q
                         where q.vt <= clock_timestamp()
                       ) r0
                 where $7 is null or r0.org = $7
                 limit case when $7 is null then null::bigint
                            else $2::bigint * $3::bigint end
               ) r
         group by 1
    ),
    live as (
        -- EVERY POOL, not just this queue's. Slot ROWS belong to a queue; the BUDGETS do not.
        -- global_cap bounds resident isolates against the edge tier's maxParallelism of 8, and
        -- max_per_org bounds concurrent handlers against one org's GitHub content quota. An isolate
        -- draining async_calls_low_priority occupies an admission slot and spends that org's GitHub
        -- quota exactly as one draining async_calls does. Counting per pool let each queue admit a
        -- full global_cap independently, so both bounds this feature exists to respect could be
        -- exceeded by a factor of the number of queues.
        select s.org, s.holder
          from public.async_worker_slots s
         where s.expires_at > clock_timestamp()
    ),
    active as (
        -- a_others excludes us, so a caller looping claim/work/claim is not counted as its own
        -- competitor. a_all includes us, because the target below needs the work already in flight.
        select l.org,
               count(*) filter (where l.holder is distinct from $1)::int as a_others,
               count(*)::int as a_all
          from live l group by 1
    ),
    winner as (
        select d.org
          from demand d
          left join active a on a.org = d.org
         -- $7 is the pinned org, or NULL for "pick the neediest". When it is set it is the ONLY
         -- candidate: a pinned caller is asking to stay where it is because it still has that org's
         -- work in flight, so falling through to a different org would recreate exactly the
         -- mid-stream rotation the pin exists to prevent. The ORDER BY below is then moot, since at
         -- most one row can survive this filter.
         where ($7 is null or d.org = $7)
           and (select count(*) from live l2 where l2.holder is distinct from $1) < $4
           -- target = ceil(ready/n) + slots already held, capped at max_per_org. In force today
           -- the ceil arm can never be the binding one, so this predicate is exactly
           -- a_others < max_per_org; the header proves that and says why the term is still here.
           -- Read the paragraph below as the record of why `+ a_all` was added, not as a live
           -- throttle.
           --
           -- The `+ a_all` term is what stops an org being throttled by its own progress. `ready`
           -- counts only visible messages, so each claim hides n of them: an org with 8 ready and
           -- max_per_org 2 would see ready fall to 4 after its first claim, compute a target of 1,
           -- and refuse the second slot it is entitled to. Adding back the n messages each active
           -- slot is already working on makes the target a statement about the org's whole backlog
           -- rather than about the part nobody has picked up yet. Bursts of 5 to 8, and the tail of
           -- every larger burst, ran at half their configured allowance without it.
           and coalesce(a.a_others, 0) < least(ceil(d.ready::numeric / $2) + coalesce(a.a_all, 0), $3)
         -- BREADTH BEFORE DEPTH. Slots held leads; unmet demand only breaks ties among orgs holding
         -- the same number. Org name last, purely for determinism.
         order by coalesce(a.a_others, 0) asc,
                  least(ceil(d.ready::numeric / $2) + coalesce(a.a_all, 0), $3) - coalesce(a.a_others, 0) desc,
                  d.org asc
         limit 1
    ),
    free_slot as (
        -- Within THIS queue's pool. queue_name is carried through to `claimed` because the key is
        -- (queue_name, slot) and slot 7 exists once per queue, so joining on slot alone would claim
        -- a row out of a different pool.
        --
        -- $6 is the slot this holder already owns here, locked by the step above, or NULL. When it
        -- is set it is the ONLY candidate: reusing our own row is what keeps one holder to one row
        -- per pool, and it is not a preference that can be lost. SKIP LOCKED does not skip a row
        -- locked by the CURRENT transaction, so having taken it above is exactly what makes it
        -- unskippable here. When it is NULL we own nothing, and any expired row will do.
        select s.queue_name, s.slot
          from public.async_worker_slots s
         where s.queue_name = $5
           and exists (select 1 from winner)
           and case when $6 is null then s.expires_at <= clock_timestamp() else s.slot = $6 end
         order by s.slot asc
         limit 1
         for update of s skip locked
    ),
    claimed as (
        update public.async_worker_slots s
           set org        = (select w.org from winner w),
               holder     = $1,
               claimed_at = clock_timestamp(),
               expires_at = clock_timestamp() + %2$L::interval
          from free_slot f
         where s.queue_name = f.queue_name
           and s.slot = f.slot
        returning s.org
    ),
    picked as (
        -- pgmq.read's CTE with one extra predicate: the same ORDER BY msg_id, the same LIMIT, the
        -- same FOR UPDATE SKIP LOCKED, and `OF q` rather than bare so locking stays on the queue
        -- table.
        --
        -- THE PREDICATE IS THE RESOLVER ITSELF, applied to the row in front of us, rather than a
        -- semijoin against a precomputed set of msg_ids. It is the same v_org_expr at the same
        -- format argument as in `demand`, so the two cannot disagree. The semijoin form had to
        -- materialize every ready row of the winning org and probe the queue's primary key once
        -- per row before the LIMIT could discard all but n of them, and at a 5000-message backlog a
        -- whole pinned claim cost 10,964 shared buffer hits to return four msg_ids. Written this
        -- way the LIMIT is what bounds the scan -- walk msg_id ascending, resolve, stop at the nth
        -- match -- and the same claim costs 111.
        --
        -- STOPPING EARLY IS A PLAN CHOICE, NOT A STRUCTURAL GUARANTEE, and the difference is what
        -- the note above the classes index is about: the correlated resolver is costed per row, so
        -- the LIMIT-fraction discount favors the ordered scan, and more decisively the deeper the
        -- queue. Make the resolver cheap and the planner goes back to scan-and-sort. The same note
        -- records what the bound actually is, which is the offset of the winning org's first ready
        -- message rather than the depth of the queue.
        --
        -- The SKIP LOCKED semantics are unchanged by that, and this is the reason the limit is NOT
        -- pushed into a subquery instead. LockRows sits under the Limit, so a row another reader
        -- holds is skipped and the scan CONTINUES to the next candidate. Picking four msg_ids
        -- first and locking them afterwards would return three messages whenever one of the four
        -- was busy, which is a different function.
        --
        -- If `claimed` produced no row the scalar subquery is NULL, every comparison is NULL, and
        -- nothing is picked. That is the "no org qualified or no slot free" path, and it claims
        -- nothing.
        --
        -- The `exists` says the same thing a second time, and it is not redundant. It is an
        -- uncorrelated subquery, so it is evaluated once and gates the scan as a one-time filter --
        -- the same idiom `free_slot` uses above. Without it the NULL comparison is a per-row filter
        -- that nothing can satisfy, and the scan still walks the entire queue in msg_id order
        -- before returning nothing. Every 'no_demand' and 'no_capacity' call takes that path, which
        -- is most of them once a burst is drained.
        select q.msg_id
          from pgmq.%3$I q
         where q.vt <= clock_timestamp()
           and exists (select 1 from claimed)
           and %6$s = (select k.org from claimed k)
         order by q.msg_id asc
         limit $2
         for update of q skip locked
    ),
    drained as (
        update pgmq.%4$I m
           set vt = clock_timestamp() + %5$L::interval,
               read_ct = m.read_ct + 1
          from picked p
         where m.msg_id = p.msg_id
        returning m.msg_id, m.read_ct, m.enqueued_at, m.vt, m.message
    )
    select 'claimed'::text, (select k.org from claimed k),
           d.msg_id, d.read_ct, d.enqueued_at, d.vt, d.message
      from drained d
    union all
    -- Zero message rows is two different answers and the caller has to tell them apart. An empty
    -- `demand` means the queue has no visible work, so the worker should move on to the next queue
    -- in its priority order. A non-empty `demand` means work is waiting and this caller has no room
    -- for it, so moving on would leave urgent repo work backlogged while the worker drains
    -- analytics. `demand` is already computed, so this costs nothing.
    -- Scoped to the pin, not to the queue. For a pinned caller 'no_demand' has to mean "the org you
    -- pinned has nothing ready", because that is the answer it acts on: it stops topping up and lets
    -- its in-flight work finish before it considers rotating. Reporting 'no_capacity' just because
    -- some OTHER org still has work would make a drained org look like a busy one forever.
    -- Note which way round the two answers are asymmetric for a caller deciding whether to release:
    -- 'no_demand' proves `claimed` never ran, whereas 'no_capacity' does NOT, because `claimed` can
    -- commit a live lease and `picked` still return nothing when every candidate row is locked. See
    -- the function comment below.
    select case when exists (select 1 from demand d where $7 is null or d.org = $7)
                then 'no_capacity' else 'no_demand' end,
           null::text, null::bigint, null::integer, null::timestamptz, null::timestamptz, null::jsonb
     where not exists (select 1 from drained)
  $QUERY$,
    v_qtable,
    make_interval(secs => lease_ttl_seconds),
    v_qtable,
    v_qtable,
    make_interval(secs => sleep_seconds),
    v_org_expr
  );

  return query execute v_sql using holder, n, max_per_org, global_cap, v_queue, v_own_slot, v_pin;
end;
$function$;

revoke all on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer, text)
  from public, anon, authenticated;
grant all on function pgmq_public.claim_org_slot_and_read(text, integer, integer, text, integer, integer, integer, text)
  to "service_role";
