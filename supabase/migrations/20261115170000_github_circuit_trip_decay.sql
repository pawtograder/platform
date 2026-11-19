-- Decay the GitHub circuit breaker's trip count after a day of quiet.
--
-- open_github_circuit adds one to github_circuit_breakers.trip_count on every closed -> open
-- transition (immediate_error excepted), and nothing ever lowered it. Once the count reaches 3, every
-- rate-limit trip opens the circuit for a flat 24 hours instead of the 3m/6m backoff. So the count was
-- a lifetime total, not a count of the current incident.
--
-- On 2026-11-15 this blocked every GitHub operation for neu-cs2000 for a full day. CS 2000 released two
-- assignments together (about 1,050 repositories), and GitHub answered with a secondary rate limit
-- after 44 minutes. That was trip 5, and trips 1-4 dated from September 2025. A rate limit that clears
-- in minutes became a 24-hour org-wide block. In that time 133 create_repo jobs were dead-lettered, and
-- 15 students' submissions were refused.
--
-- The fix is the one open_discord_circuit already uses (20260822120000): when a breaker has been quiet
-- for 24 hours, its next trip counts as the first. "Quiet" is read from updated_at, which every trip and
-- every extension of an open window touches. An immediate_error open touches it too, so per-repo errors
-- at org scope keep the count alive. Those are rare (at most three per org in the 90 days to
-- 2026-11-15), so that does not stop decay in practice. An immediate_error after a quiet day also clears
-- the stale count, although it still does not add a trip of its own.
--
-- The escalation itself is unchanged: 3m/6m backoff, then 24 hours from the third trip within the
-- decay window. The error_threshold and immediate_error windows are unchanged too.
--
-- Also fixed here: the backoff multiplied by power(2, trip_count - 1) and cast to integer BEFORE the
-- 43200 cap, so a high enough trip count raised "integer out of range" inside the worker's
-- error-handling path. The cap is now applied in double precision and the capped value is cast, which
-- cannot overflow.
--
-- No backfill. Rows with a stale count (two orgs had trip_count >= 3 on 2026-11-15) are reset by the
-- decay on their next trip, because their updated_at is already more than a day old.
--
-- CREATE OR REPLACE keeps the existing grants: service_role only, from
-- 20261015120000_lock_down_security_definer_functions.

create or replace function public.open_github_circuit(
  p_scope text,
  p_key text,
  p_event text,
  p_retry_after_seconds integer default null,
  p_reason text default null
) returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_row public.github_circuit_breakers%rowtype;
  v_base_seconds integer;
  v_prior_trips integer;
  v_trip_count integer;
  v_advisory_lock_key bigint;
  -- How long a breaker must be quiet before its next trip counts as the first. A day, the same as the
  -- Discord breaker: a storm that recurs over a few windows still escalates, but last term's incident
  -- does not set the penalty for this term's blip.
  v_decay interval := interval '24 hours';
begin
  -- Serialize per scope+key so concurrent trips cannot lose an update to the count.
  v_advisory_lock_key := ('x' || substr(md5(p_scope || '|' || p_key), 1, 16))::bit(64)::bigint;
  perform pg_advisory_xact_lock(v_advisory_lock_key);

  select * into v_row from public.github_circuit_breakers where scope = p_scope and key = p_key for update;

  -- Base window by event type.
  if p_event = 'extreme' then
    v_base_seconds := 43200; -- 12h
  elsif p_event = 'secondary' then
    v_base_seconds := 180; -- 3m
  elsif p_event = 'primary' then
    v_base_seconds := 60; -- 1m
  elsif p_event = 'error_threshold' then
    v_base_seconds := coalesce(p_retry_after_seconds, 28800); -- 8h
  elsif p_event = 'immediate_error' then
    v_base_seconds := coalesce(p_retry_after_seconds, 30); -- 30s
  else
    v_base_seconds := coalesce(p_retry_after_seconds, 60);
  end if;

  if not found then
    insert into public.github_circuit_breakers(scope, key, state, open_until, last_reason, updated_at, trip_count)
    values (p_scope, p_key, 'open', now() + make_interval(secs => v_base_seconds), p_reason, now(), 1);
    v_trip_count := 1;
  elsif v_row.state = 'open' and (v_row.open_until is null or v_row.open_until > now()) then
    -- Already open: the same incident, not a new trip. The count is unchanged and the window is only
    -- ever extended, never shortened.
    v_trip_count := v_row.trip_count;
    if p_event not in ('error_threshold', 'immediate_error') then
      v_base_seconds := least(43200::double precision,
                              v_base_seconds * power(2, greatest(v_trip_count - 1, 0)))::integer;
    end if;
    update public.github_circuit_breakers
       set open_until = greatest(coalesce(v_row.open_until, now()), now() + make_interval(secs => v_base_seconds)),
           last_reason = coalesce(p_reason, v_row.last_reason),
           updated_at = now()
     where scope = p_scope and key = p_key;
    -- No event row when already open.
    return v_trip_count;
  else
    -- Closed, or open with an expired window: a new trip. Trips before a quiet day no longer count.
    if v_row.updated_at < now() - v_decay then
      v_prior_trips := 0;
    else
      v_prior_trips := v_row.trip_count;
    end if;

    -- immediate_error opens are temporary and do not count as a trip.
    if p_event = 'immediate_error' then
      v_trip_count := v_prior_trips;
    else
      v_trip_count := v_prior_trips + 1;
    end if;

    if v_trip_count >= 3 and p_event not in ('error_threshold', 'immediate_error') then
      v_row.open_until := now() + interval '24 hours';
    else
      if p_event not in ('error_threshold', 'immediate_error') then
        -- Capped before the cast: the product is double precision and could exceed integer.
        v_base_seconds := least(43200::double precision,
                                v_base_seconds * power(2, greatest(v_trip_count - 1, 0)))::integer;
      end if;
      v_row.open_until := now() + make_interval(secs => v_base_seconds);
    end if;

    update public.github_circuit_breakers
       set state = 'open',
           open_until = v_row.open_until,
           last_reason = coalesce(p_reason, v_row.last_reason),
           updated_at = now(),
           trip_count = v_trip_count
     where scope = p_scope and key = p_key;
  end if;

  -- Log an event only for a new trip.
  insert into public.github_circuit_breaker_events(scope, key, reason)
  values (p_scope, p_key, coalesce(p_reason, 'unspecified'));

  return v_trip_count;
end;
$function$;
