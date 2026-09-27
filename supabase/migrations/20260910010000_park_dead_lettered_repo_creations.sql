-- Stop the repo reconciler re-enqueueing a create_repo job that has already been dead-lettered.
--
-- THE INCIDENT (2026-09-09, CS 4535). A private handout in an org whose "Allow forking of private
-- repositories" member privilege is off made every create_repo for assignment 1226 fail with
-- 403 "The repository exists, but forking is disabled." Nothing classified that as terminal, so
-- the repository rows never received a `creation_error` and reconcile_stuck_repo_creations kept
-- treating them as TRANSIENT. Three repos were re-enqueued six times over 8.5 hours -- 108 GitHub
-- calls that could never succeed -- and three students had no repo for 17 hours, until an
-- instructor noticed and made the handout public.
--
-- The companion change to this one teaches the worker to classify that specific 403 as a
-- NonRetryableRepoError, which writes `creation_error` and parks the row on the FIRST failure.
-- This migration is the GENERIC backstop for the same shape: it does not care WHY the job failed,
-- only that the job we last queued is now in the dead-letter queue. Any future unclassified
-- terminal error is capped at one cycle instead of eight.
--
-- WHY THE DLQ IS THE RIGHT EVIDENCE, AND WHY IT IS A DIFFERENT QUESTION FROM repo_ids_with_
-- queued_create(). That function answers "is a job still alive?" and deliberately does NOT look at
-- the DLQ, because for PARKING an exhausted row, a dead-lettered job counts as gone -- absence
-- from the live queues is what permits parking. This asks the opposite question: "did the job we
-- queued end up dead-lettered?", and a positive answer is grounds to park EARLY, before the
-- eight-attempt ceiling. Both are needed; neither subsumes the other.
--
-- WHY IT COMPARES AGAINST last_creation_attempt_at. Nothing consumes the DLQ, so an entry lives
-- there until an operator drains it. Without a recency test, one dead-lettered job would bar a
-- repository from automatic retry forever -- including immediately after an instructor clicks
-- Retry, which would park the fresh job before it ever ran. retry_repository_creation clears
-- creation_error, zeroes creation_attempts and re-enqueues, and every path that queues a job
-- writes last_creation_attempt_at, so "dead-lettered at or after the last thing we queued" is
-- exactly "the current attempt died" and an older entry is correctly ignored.

-- Which repositories have a dead-lettered create_repo, and when the most recent one landed.
--
-- Unlike repo_ids_with_queued_create() this is not gathered once into an array by the caller: the
-- live queues can hold a whole class's provisioning burst, whereas the DLQ only grows when a job
-- fails terminally and only shrinks when an operator drains it, so it stays small enough to scan
-- directly. It compares as text for the same reason the in-flight probe does -- the envelope's
-- repo_id is a JSON string and the queue tables have no index on it.
create or replace function public.repo_ids_with_dead_lettered_create()
returns table(repo_id text, dead_lettered_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select q.message->>'repo_id', max(q.enqueued_at)
    from pgmq.q_async_calls_dlq q
   where q.message->>'method' = 'create_repo'
     and q.message->>'repo_id' is not null
   group by 1;
$$;

revoke all on function public.repo_ids_with_dead_lettered_create() from public, anon, authenticated;
grant execute on function public.repo_ids_with_dead_lettered_create() to service_role;

comment on function public.repo_ids_with_dead_lettered_create() is
  'Repositories whose create_repo job was dead-lettered, with the most recent dead-letter time. '
  'Used by reconcile_stuck_repo_creations to park a row early instead of re-enqueueing a job that '
  'has already failed terminally. Compare against repositories.last_creation_attempt_at so an '
  'entry predating an instructor Retry does not park the fresh attempt.';

-- Re-create the reconciler with the extra park step. Everything else is unchanged from
-- 20260816120000_bound_repo_creation_retries.sql; the new block is the second UPDATE, and the
-- re-enqueue loop needs no new predicate because it already skips rows with a creation_error.
create or replace function public.reconcile_stuck_repo_creations(p_stale_minutes integer default 15)
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
  v_inflight_repo_ids text[];
begin
  v_inflight_repo_ids := public.repo_ids_with_queued_create();

  -- Park anything that has exhausted its automatic retries, whose last job is no longer anywhere
  -- in a queue, and which has gone quiet for the interval its next attempt would have waited.
  -- Park on evidence, not on a timer: a create_repo job can legitimately live far longer than any
  -- interval we would guess (github-async-worker requeues an `extreme` rate limit for 12 hours),
  -- and requeueWithDelay never touches the repository row, so updated_at stays pinned at the last
  -- enqueue for that whole time. The queue is a table, so ask it instead.
  update public.repositories rp
     set creation_error = format(
           'Repository creation did not succeed after %s automatic attempts. Check the assignment template repository and GitHub org configuration, then use Retry.',
           v_max_attempts)
    from public.assignments a
   where a.id = rp.assignment_id
     and rp.is_github_ready = false
     and rp.creation_error is null
     and rp.creation_attempts >= v_max_attempts
     and rp.id::text <> all (v_inflight_repo_ids)
     and rp.updated_at < now() - make_interval(
           mins => p_stale_minutes * (2 ^ least(rp.creation_attempts, v_max_backoff_doublings))::int
         )
     and a.repo_mode not in ('none', 'no_submission');

  -- NEW: park a row whose most recently queued job was dead-lettered, whatever the attempt count.
  -- This is the early exit the attempt ceiling above cannot provide: eight attempts against a
  -- deterministic misconfiguration is 32 hours of doomed GitHub calls, and the DLQ already knows
  -- after the first one. No in-flight row is touched -- if a job is live, it is not our evidence,
  -- and the row is left to run.
  --
  -- The wording deliberately does not guess at the cause. The worker records a precise reason on
  -- the row for every error class it can classify (see NonRetryableRepoError); this message is the
  -- fallback for the ones it cannot, and it points the instructor at Retry once they have fixed
  -- whatever the linked Sentry issue named.
  update public.repositories rp
     set creation_error = 'Repository creation failed and the job was dead-lettered, so automatic retries have stopped. Check the assignment template repository and GitHub org configuration (a private template needs org permission to be forked), then use Retry.'
    from public.assignments a
   where a.id = rp.assignment_id
     and rp.is_github_ready = false
     and rp.creation_error is null
     and rp.last_creation_attempt_at is not null
     and rp.id::text <> all (v_inflight_repo_ids)
     and a.repo_mode not in ('none', 'no_submission')
     and exists (
           select 1
             from public.repo_ids_with_dead_lettered_create() d
            where d.repo_id = rp.id::text
              and d.dead_lettered_at >= rp.last_creation_attempt_at
         );

  for r in
    select rp.id
      from public.repositories rp
      join public.assignments a on a.id = rp.assignment_id
      join public.classes c on c.id = rp.class_id
     where rp.is_github_ready = false
       and rp.creation_error is null
       and rp.creation_attempts < v_max_attempts
       and a.repo_mode not in ('none', 'no_submission')
       -- Recurring per-class work must not run for courses that have ended, EXCEPT to finish
       -- following up an attempt somebody actually made -- otherwise a row queued by an
       -- instructor Retry on an archived class could never converge on ready or on parked.
       and (
         public.is_class_active(c.archived, c.end_date)
         or rp.last_creation_attempt_at > now() - interval '7 days'
       )
       -- Same evidence the park uses, for the same reason in reverse: skip a row whose job is
       -- still there and let it run; if it is gone, this is the path that replaces it.
       and rp.id::text <> all (v_inflight_repo_ids)
       -- Exponential backoff: each failed attempt doubles the wait, capped.
       and rp.updated_at < now() - make_interval(
             mins => p_stale_minutes * (2 ^ least(rp.creation_attempts, v_max_backoff_doublings))::int
           )
  loop
    begin
      perform public.enqueue_create_repo_for_repository(r.id);
      v_count := v_count + 1;
    exception
      when others then
        raise warning 'reconcile: failed to enqueue repository %: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$$;
