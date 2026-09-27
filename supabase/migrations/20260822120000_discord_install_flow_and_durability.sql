-- Discord: verified install flow, per-guild circuit breaker, reconciler, and teardown durability.
--
-- This is the squashed form of what was developed as twelve migrations (20260822120000 through
-- 20260823030000). None of them ever reached staging, so there is no deployed history to preserve and
-- nothing gained by shipping the intermediate states: seven functions were defined two or three times
-- across that set, and the earlier bodies were dead on arrival -- a reader could not tell which copy
-- was live without diffing timestamps, and every later fix had to be applied to whichever copy came
-- last, which is how the teardown function came to be extended three times and still miss a table.
--
-- Each function here is its final body, kept at the position its first version occupied so it is
-- defined before the repair loops at the bottom that call it. The backfills are retained rather than
-- dropped: they are no-ops on a database that has never had any of this applied, and correct on one
-- that has partial state from a preview deployment.
--
-- What this adds, in order:
--
--   1. discord_circuit_breakers + discord_async_errors, and the open/record/threshold/cleanup state
--      machine over them. One bot token serves every course, so a single guild that has locked the bot
--      out can otherwise burn the shared rate limit for all of them.
--   2. classes.discord_server_claimed_by / _at, and one-active-class-per-guild. Replaces the free-text
--      "Discord Server ID" box, which authorized nothing -- any guild the bot was in, including another
--      course's, could be claimed by anyone who could edit the class.
--   3. claim_discord_guild() / disconnect_discord_guild(): the only writers of discord_server_id, both
--      service_role-only, both re-checking that the actor is staff.
--   4. Teardown that actually runs: on a server change, on disconnect, and on archive -- clearing every
--      pointer a class holds into a guild it is leaving, and revoking the invites into it.
--   5. reconcile_stuck_discord_memberships() + a 15-minute pg_cron pass, because all membership
--      observation happened inside one hourly envelope and a dropped envelope looked exactly like a
--      healthy one.
--   6. store_discord_channel_if_current() / the guild revalidation writes, so an in-flight envelope
--      cannot record a channel or role into a guild the class has since left.
--   7. get_stuck_discord_membership_alerts(), which applies the alert's predicates in SQL. Filtering a
--      capped sample in the edge function let permanently-dead rows -- always the oldest -- crowd out
--      live failures and silence the alert entirely.
--   8. discord_channels uniqueness with NULLS NOT DISTINCT, so the ON CONFLICT arbiter arbitrates for
--      the class-level channel types, whose resource_id is NULL.
--   9. trg_update_discord_profile_on_insert, so linking a Discord account fires the link handler on the
--      INSERT that is the link, rather than relying on GoTrue happening to update the row afterwards.

-- Per-guild circuit breaker and a reconciler for stuck Discord membership work.
--
-- WHY PER-GUILD, AND WHY IT MATTERS MORE HERE THAN PER-ORG DOES FOR GITHUB
--
-- The GitHub worker authenticates as a per-org installation: an org whose installation is broken
-- burns its own rate limit and nobody else's, so its circuit breaker is mostly a courtesy to that
-- org. Discord is the opposite. One bot token serves every course on the platform, and Discord's
-- primary rate limit (50 requests/second) is charged against that token, not against the guild. So a
-- single misconfigured guild -- the bot dropped from the server, its channel-view permission
-- revoked, a stale discord_server_id -- turns every enrolled student into a 403/50001 and spends the
-- whole platform's Discord budget discovering the same fact. That is not hypothetical: 557 of the
-- 594 dead-letter rows on 2026-08-11 were one guild's 403, repeated once per enrolled student.
--
-- Hence a breaker keyed on the guild. Once a guild has produced a storm of permission errors, work
-- for THAT guild is deferred and every other course keeps its share of the token.
--
-- Contents:
--   1. discord_circuit_breakers  -- breaker state, keyed (scope, key); scope is 'guild' today.
--   2. discord_async_errors      -- the per-guild error log the threshold check counts.
--   3. get_discord_circuit / open_discord_circuit / record_discord_async_error /
--      check_discord_error_threshold -- the four RPCs the worker calls, mirroring the GitHub set.
--   4. get_discord_circuit_breaker_statuses -- the gauge the metrics endpoint exports.
--   5. reconcile_stuck_discord_memberships  -- re-enqueue membership work the hourly sync lost.
--   6. invoke_discord_reconciler_background_task + a pg_cron schedule every 15 minutes.

-- ============================================================================
-- 1. Breaker state
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.discord_circuit_breakers (
  -- 'guild' today. Kept as a column rather than baked into the key so a future method-scoped
  -- breaker ('guild_method', like GitHub's 'org_method') needs no migration of this table.
  scope text NOT NULL,
  key text NOT NULL,
  state text NOT NULL DEFAULT 'closed', -- 'open' | 'closed'
  open_until timestamptz,
  last_reason text,
  trip_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

COMMENT ON TABLE public.discord_circuit_breakers IS
  'Per-guild Discord circuit breaker state. Open means the worker defers that guild''s operations, which protects the single shared bot token''s rate limit from one misconfigured server.';

ALTER TABLE public.discord_circuit_breakers ENABLE ROW LEVEL SECURITY;

-- No authenticated access at all, unlike discord_channels and friends. last_reason carries raw
-- Discord error text and the key is a guild snowflake; neither is anything the app renders, so
-- there is no reason for a browser-held key to reach this table.
REVOKE ALL ON TABLE public.discord_circuit_breakers FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON TABLE public.discord_circuit_breakers TO service_role;

DROP POLICY IF EXISTS "discord_circuit_breakers_service_role_all" ON public.discord_circuit_breakers;

CREATE POLICY "discord_circuit_breakers_service_role_all"
ON public.discord_circuit_breakers
AS permissive
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- ============================================================================
-- 2. The error log the threshold reads
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.discord_async_errors (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  -- github_async_errors calls this column `org`; the Discord equivalent of an org is the guild.
  guild_id text NOT NULL,
  method text NOT NULL,
  error_data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.discord_async_errors IS
  'Discord async worker failures that count toward the per-guild circuit breaker (bot permission and configuration errors). Trimmed to 7 days by cleanup_discord_async_errors().';

-- The threshold check is always "this guild, this window", so the composite index is the one that
-- matters; the created_at index serves the daily cleanup.
CREATE INDEX IF NOT EXISTS idx_discord_async_errors_guild_created_at
  ON public.discord_async_errors (guild_id, created_at);

CREATE INDEX IF NOT EXISTS idx_discord_async_errors_created_at
  ON public.discord_async_errors (created_at);

ALTER TABLE public.discord_async_errors ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.discord_async_errors FROM anon, authenticated;

GRANT SELECT, INSERT, DELETE ON TABLE public.discord_async_errors TO service_role;

DROP POLICY IF EXISTS "discord_async_errors_service_role_all" ON public.discord_async_errors;

CREATE POLICY "discord_async_errors_service_role_all"
ON public.discord_async_errors
AS permissive
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- ============================================================================
-- 3. The RPCs the worker calls
-- ============================================================================

-- Read a breaker. Returns no row when the guild has never tripped, which the caller reads as closed.
CREATE OR REPLACE FUNCTION public.get_discord_circuit(
  p_scope text,
  p_key text
) RETURNS TABLE (state text, open_until timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT cb.state, cb.open_until
  FROM public.discord_circuit_breakers cb
  WHERE cb.scope = p_scope AND cb.key = p_key;
$$;

-- anon and authenticated are named explicitly, not left to a PUBLIC-only revoke: Supabase grants
-- EXECUTE to both as their own ACL entries at CREATE time, so revoking PUBLIC removes nothing.
REVOKE ALL ON FUNCTION public.get_discord_circuit(text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_discord_circuit(text, text) TO service_role;

-- ============================================================================
-- 4 + 5. Breaker: decay the trip count, and stop the backoff overflowing
-- ============================================================================

-- Two problems with the escalation, both from trip_count only ever going up.
--
-- Nothing sets state back to 'closed' and nothing resets trip_count -- a breaker "closes" only by its
-- open_until passing -- so the count is a lifetime total, not an incident total. A guild that had a
-- bad week last term therefore starts its next incident at LEAST(21600, base * 2^4): a single
-- transient blip on a server that has been healthy for months parks that class's role and invite work
-- for six hours, and the reconciler skips it for the same six hours. The escalation is meant to say
-- "this guild keeps doing this", and after a day of quiet that is no longer what the count means.
--
-- The overflow is smaller but sharper: `(v_base_seconds * power(2, ...))::integer` cast BEFORE the
-- 21600 cap, so a p_retry_after_seconds above about 134 million raised "integer out of range" from
-- inside an error path -- the one place a raise is least affordable, because open_discord_circuit is
-- called from the worker's failure handling. Capping in double precision and casting the capped value
-- cannot overflow, since the result is never above 21600.
CREATE OR REPLACE FUNCTION public.open_discord_circuit(
  p_scope text,
  p_key text,
  p_event text, -- 'permission_storm' | 'rate_limit' | anything else (uses p_retry_after_seconds)
  p_retry_after_seconds integer DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.discord_circuit_breakers%rowtype;
  v_base_seconds integer;
  v_trip_count integer;
  v_lock_key bigint;
  -- How long a guild must be quiet before its next trip counts as a first offence rather than as a
  -- continuation. A day: long enough that a storm which recurs across a couple of breaker windows
  -- still escalates, short enough that last term's incident does not price this term's blip.
  v_decay interval := interval '24 hours';
BEGIN
  -- Serialize per (scope, key). Four envelopes are processed in parallel per worker and two workers
  -- run per minute, so without this the first trip for a guild is a lost-update race between
  -- concurrent INSERTs and the trip count silently stops incrementing.
  v_lock_key := ('x' || substr(md5(p_scope || '|' || p_key), 1, 16))::bit(64)::bigint;
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_row
  FROM public.discord_circuit_breakers
  WHERE scope = p_scope AND key = p_key
  FOR UPDATE;

  IF p_event = 'permission_storm' THEN
    v_base_seconds := COALESCE(p_retry_after_seconds, 1800); -- 30m: needs a Discord admin to act
  ELSIF p_event = 'rate_limit' THEN
    v_base_seconds := COALESCE(p_retry_after_seconds, 60);
  ELSE
    v_base_seconds := COALESCE(p_retry_after_seconds, 300);
  END IF;

  IF NOT FOUND THEN
    -- Capped on the first trip as well as on later ones. This branch used the caller's seconds raw, so
    -- a large p_retry_after_seconds -- a Retry-After echoed from Discord, say -- parked a guild far
    -- beyond the six-hour ceiling every other path respects, and nothing could shorten the window
    -- afterwards because the already-open branch only ever extends it.
    v_base_seconds := LEAST(21600, v_base_seconds);
    INSERT INTO public.discord_circuit_breakers (scope, key, state, open_until, last_reason, trip_count, updated_at)
    VALUES (p_scope, p_key, 'open', now() + make_interval(secs => v_base_seconds), p_reason, 1, now());
    RETURN 1;
  END IF;

  IF v_row.state = 'open' AND (v_row.open_until IS NULL OR v_row.open_until > now()) THEN
    -- Already open: this is the same storm, not a new trip. The window is never shortened, so a
    -- later short event (a 60s rate limit) cannot cut a 30-minute permission window short.
    UPDATE public.discord_circuit_breakers
    SET open_until = GREATEST(COALESCE(v_row.open_until, now()), now() + make_interval(secs => v_base_seconds)),
        last_reason = COALESCE(p_reason, v_row.last_reason),
        updated_at = now()
    WHERE scope = p_scope AND key = p_key;
    RETURN v_row.trip_count;
  END IF;

  -- Closed, or open with an expired window: a new trip. Repeat offenders back off further, capped at
  -- six hours so a guild is always retried within one working day -- but only while the repeats are
  -- recent. `updated_at` is touched on every trip and every extension, so it is the last time this
  -- guild was in trouble.
  IF v_row.updated_at < now() - v_decay THEN
    v_trip_count := 1;
  ELSE
    v_trip_count := v_row.trip_count + 1;
  END IF;

  -- Capped before the cast, not after: the product is double precision and could exceed integer.
  v_base_seconds := LEAST(21600::double precision, v_base_seconds * power(2, LEAST(v_trip_count - 1, 4)))::integer;

  UPDATE public.discord_circuit_breakers
  SET state = 'open',
      open_until = now() + make_interval(secs => v_base_seconds),
      last_reason = COALESCE(p_reason, v_row.last_reason),
      trip_count = v_trip_count,
      updated_at = now()
  WHERE scope = p_scope AND key = p_key;

  RETURN v_trip_count;
END;
$$;

REVOKE ALL ON FUNCTION public.open_discord_circuit(text, text, text, integer, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.open_discord_circuit(text, text, text, integer, text) TO service_role;

-- Log one failure against a guild.
CREATE OR REPLACE FUNCTION public.record_discord_async_error(
  p_guild_id text,
  p_method text,
  p_error_data jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.discord_async_errors (guild_id, method, error_data)
  VALUES (p_guild_id, p_method, p_error_data);
END;
$$;

REVOKE ALL ON FUNCTION public.record_discord_async_error(text, text, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.record_discord_async_error(text, text, jsonb) TO service_role;

-- How many failures this guild has logged inside the window.
--
-- The GitHub twin takes a p_threshold argument and ignores it -- the caller compares the returned
-- count itself -- so it is not carried over here. The comparison stays in the worker, where the
-- threshold is next to the code that acts on it.
CREATE OR REPLACE FUNCTION public.check_discord_error_threshold(
  p_guild_id text,
  p_window_minutes integer DEFAULT 5
) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT count(*)::integer
  FROM public.discord_async_errors
  WHERE guild_id = p_guild_id
    AND created_at >= now() - make_interval(mins => p_window_minutes);
$$;

REVOKE ALL ON FUNCTION public.check_discord_error_threshold(text, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.check_discord_error_threshold(text, integer) TO service_role;

-- ============================================================================
-- 6. Prune breaker rows, as the error log is already pruned
-- ============================================================================

-- discord_async_errors is trimmed daily; discord_circuit_breakers, computed from it, was not. A row is
-- inserted the first time a guild trips and then lives forever, so the table accumulates one row per
-- guild that has ever had a bad five minutes -- including guilds no class uses any more, since a
-- disconnect or archive releases the guild without touching its breaker. That also makes
-- get_discord_circuit_breaker_statuses() unbounded, and it feeds the metrics endpoint, so every one of
-- those rows is a permanent Prometheus series keyed on a guild snowflake.
--
-- Folded into the existing daily cleanup rather than added as a second function: it is the same job on
-- the same schedule, and the two must not be able to drift onto different retentions.
CREATE OR REPLACE FUNCTION public.cleanup_discord_async_errors()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.discord_async_errors
  WHERE created_at < now() - interval '7 days';

  -- Only breakers that are demonstrably not open. An open_until of NULL on an open row means "open
  -- indefinitely", so it is excluded rather than treated as expired -- deleting that row would silently
  -- un-park a guild. Thirty days keeps trip_count long enough to still mean something under the decay
  -- rule above (24 hours) while bounding the table by guilds seen in the last month.
  DELETE FROM public.discord_circuit_breakers
  WHERE updated_at < now() - interval '30 days'
    AND NOT (state = 'open' AND (open_until IS NULL OR open_until > now()));
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_discord_async_errors() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.cleanup_discord_async_errors() TO service_role;

SELECT cron.unschedule('cleanup-discord-async-errors-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'cleanup-discord-async-errors-daily');

SELECT cron.schedule(
  'cleanup-discord-async-errors-daily',
  '20 2 * * *', -- 02:20 UTC, twenty minutes after the GitHub equivalent so they do not overlap
  $$SELECT public.cleanup_discord_async_errors();$$
);

-- ============================================================================
-- 4. The gauge the metrics endpoint exports
-- ============================================================================

-- Deliberately a separate function from get_circuit_breaker_statuses() rather than a UNION inside
-- it: that one is the GitHub breaker's gauge, alerts are written against its label set, and the two
-- breakers have different remediations (a GitHub installation vs a Discord server admin).
CREATE OR REPLACE FUNCTION public.get_discord_circuit_breaker_statuses()
RETURNS TABLE (
  scope text,
  key text,
  is_open boolean,
  state text,
  open_until timestamptz,
  trip_count integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    cb.scope,
    cb.key,
    (cb.state = 'open' AND (cb.open_until IS NULL OR cb.open_until >= now())) AS is_open,
    cb.state,
    cb.open_until,
    cb.trip_count
  FROM public.discord_circuit_breakers cb
  ORDER BY cb.scope, cb.key;
$$;

REVOKE ALL ON FUNCTION public.get_discord_circuit_breaker_statuses() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_discord_circuit_breaker_statuses() TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_stuck_discord_memberships(
  p_stale_minutes integer DEFAULT 180,
  p_limit integer DEFAULT 200
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r record;
  v_count integer := 0;
BEGIN
  FOR r IN
    WITH queued AS (
      -- One pass over the queue instead of an EXISTS per candidate. pgmq's q_* tables are indexed on
      -- msg_id and vt only, so a per-row probe would be one sequential scan per candidate over the
      -- highest-churn table in the database.
      SELECT DISTINCT
        q.message -> 'args' ->> 'guild_id' AS guild_id,
        q.message -> 'args' ->> 'user_id' AS discord_user_id
      FROM pgmq.q_discord_async_calls q
      WHERE q.message ->> 'method' = 'add_member_role'
    )
    SELECT ur.user_id, ur.class_id, ur.role, dms.id AS status_id
    FROM public.user_roles ur
    JOIN public.classes c ON c.id = ur.class_id
    JOIN public.users u ON u.user_id = ur.user_id
    LEFT JOIN public.discord_membership_status dms
      ON dms.class_id = ur.class_id
     AND dms.user_id = ur.user_id
     AND dms.guild_id = c.discord_server_id
    WHERE ur.disabled = false
      AND u.discord_id IS NOT NULL
      AND c.discord_server_id IS NOT NULL
      -- Same active-class scoping as get_discord_role_sync_candidates(). A class that has ended is
      -- not stuck, it is finished, and its students are reached by the manual retry button instead.
      AND public.is_class_active(c.archived, c.end_date)
      AND (dms.id IS NULL OR dms.state = 'not_joined')
      -- With no status row at all there is no observation to age, so user_roles.updated_at stands in
      -- for "not brand new": an enrollment created a minute ago already has an add_member_role in
      -- flight from its own trigger, and the queue check below cannot see that message once a worker
      -- has read it. user_roles has no created_at column, and its updated_at is stamped by a BEFORE
      -- UPDATE trigger, so an unrelated edit (a section move) postpones this user by one window --
      -- the cheap error, since the edit itself re-enqueues their role sync.
      AND COALESCE(dms.last_observed_at, ur.updated_at) < now() - make_interval(mins => p_stale_minutes)
      -- Do not fight a human. request_discord_reinvite() stamps this, and a reconciler pass that
      -- re-enqueued on top of it would double the Discord work for the students an instructor is
      -- already retrying. READ ONLY here -- the write moved to last_reconciled_at below.
      AND (dms.last_retry_requested_at IS NULL
           OR dms.last_retry_requested_at < now() - make_interval(mins => p_stale_minutes))
      -- Do not fight ourselves either. Without this an envelope that dead-letters -- leaving the queue
      -- without anything updating last_observed_at -- comes back on every pass for as long as the row
      -- survives.
      AND (dms.last_reconciled_at IS NULL
           OR dms.last_reconciled_at < now() - make_interval(mins => p_stale_minutes))
      AND EXISTS (
        SELECT 1 FROM public.discord_roles dr
        WHERE dr.class_id = ur.class_id AND dr.role_type = ur.role::text
      )
      AND NOT EXISTS (
        SELECT 1 FROM queued qd
        WHERE qd.guild_id = c.discord_server_id AND qd.discord_user_id = u.discord_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.discord_circuit_breakers cb
        WHERE cb.scope = 'guild'
          AND cb.key = c.discord_server_id
          AND cb.state = 'open'
          AND (cb.open_until IS NULL OR cb.open_until > now())
      )
    -- Oldest observation first, so a bounded pass makes progress on the worst cases rather than
    -- re-picking the same arbitrary set each time.
    ORDER BY COALESCE(dms.last_observed_at, ur.updated_at) ASC
    -- COALESCE before GREATEST. GREATEST ignores NULLs, so `GREATEST(NULL, 0)` is 0 and an explicit
    -- `p_limit => NULL` became LIMIT 0 -- a pass that reconciled nothing and returned 0, which reads
    -- exactly like a healthy platform. The default is repeated here because a NULL argument is not
    -- the same thing as an omitted one and only the latter gets the parameter default.
    LIMIT GREATEST(COALESCE(p_limit, 200), 0)
  LOOP
    BEGIN
      PERFORM public.enqueue_discord_role_sync(r.user_id, r.class_id, r.role, 'add');

      -- last_reconciled_at, not last_retry_requested_at. A candidate with no status row at all cannot
      -- be stamped; it is bounded by the queue check until the first outcome creates its row, which
      -- record_discord_membership_status() does on every path.
      IF r.status_id IS NOT NULL THEN
        UPDATE public.discord_membership_status
        SET last_reconciled_at = now()
        WHERE id = r.status_id;
      END IF;

      v_count := v_count + 1;
    EXCEPTION
      WHEN others THEN
        -- One bad candidate must not abort the pass; the next run picks it up again.
        RAISE WARNING 'reconcile_stuck_discord_memberships: failed for user % in class %: %',
          r.user_id, r.class_id, sqlerrm;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_stuck_discord_memberships(integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reconcile_stuck_discord_memberships(integer, integer) TO service_role;

-- ============================================================================
-- 6. Cron: invoke the reconciler edge function every 15 minutes
-- ============================================================================

-- The edge function calls reconcile_stuck_discord_memberships() and emits the >12h Sentry alerts,
-- which plpgsql cannot do. Same shape as invoke_github_repo_reconciler_background_task().
CREATE OR REPLACE FUNCTION public.invoke_discord_reconciler_background_task()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.call_edge_function_internal(
    '/functions/v1/discord-reconciler',
    'POST',
    '{"Content-type":"application/json","x-supabase-webhook-source":"discord-reconciler"}'::jsonb,
    '{}'::jsonb,
    5000,
    null, null, null, null, null
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_discord_reconciler_background_task() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.invoke_discord_reconciler_background_task() TO service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discord-reconciler') THEN
      PERFORM cron.unschedule('discord-reconciler');
    END IF;
    PERFORM cron.schedule(
      'discord-reconciler',
      -- Offset from the hourly batch role sync (minute 0) so a reconciler pass never reads the
      -- status rows the sync is in the middle of rewriting.
      '7-52/15 * * * *',
      $$SELECT public.invoke_discord_reconciler_background_task();$$
    );
    RAISE NOTICE 'Discord reconciler cron scheduled every 15 minutes';
  END IF;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'Skipping discord-reconciler cron schedule: insufficient privilege';
END;
$cron$;

-- Discord guild claim: an instructor must prove control of a server before a class can point at it.
--
-- Until now `classes.discord_server_id` was a free-text field an instructor typed into and saved,
-- permitted by the RLS policy classes_instructor_update_calendar_or_discord_ids via the column
-- allow-list in only_calendar_or_discord_ids_changed(). Two things were wrong with that:
--
--   1. No proof of control. One bot token serves every course on the deployment, so any guild the
--      bot happens to be in is reachable from any class -- including another course's server. The
--      async worker then creates roles, creates channels and mints invites in it. Typing 18 digits
--      was the whole authorization step.
--   2. No uniqueness. Nothing stopped two classes from naming the same guild, after which both
--      courses' role syncs, channel creation and message tracking fought over one server.
--
-- GitHub has neither hole: `github_org` is picked by a platform admin from an admin-gated list and
-- installing the App requires org-owner consent. This migration gives Discord the equivalent shape.
-- The web app now runs an install-then-claim flow (app/api/discord/install + .../install/callback):
-- the instructor is sent to Discord's own consent screen, picks the server there, and the callback
-- confirms with the bot token that the bot really is in the guild it came back with before calling
-- the RPC below. `discord_server_id` stops being instructor-writable, so that RPC is the only writer.
--
-- `discord_channel_group_id` stays instructor-writable. It names a category *inside* an
-- already-claimed guild, so it carries none of the cross-tenant risk -- and it is the one field an
-- instructor legitimately edits by hand.

-- ============================================================================
-- 1. Who claimed the server, and when
-- ============================================================================

-- FK to public.users(user_id), which is what every other user reference in the Discord schema uses
-- (discord_membership_status, discord_invites) -- not auth.users. ON DELETE SET NULL rather than
-- CASCADE: deleting a user must not delete their courses, and losing the name of the person who
-- connected the server is an acceptable loss where losing the class is not.
ALTER TABLE public.classes
  ADD COLUMN IF NOT EXISTS discord_server_claimed_by uuid REFERENCES public.users (user_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS discord_server_claimed_at timestamptz;

COMMENT ON COLUMN public.classes.discord_server_claimed_by IS
  'The instructor who last claimed discord_server_id through claim_discord_guild(). NULL means the server predates the claim flow (set directly through the old free-text field) or the user has since been deleted -- in both cases the server is still usable and re-claiming it records provenance without disturbing the install.';

COMMENT ON COLUMN public.classes.discord_server_claimed_at IS
  'When discord_server_id was last claimed. NULL for servers configured before the claim flow existed.';

-- Rows that already carry a discord_server_id keep NULL provenance. Deliberately no backfill: there
-- is nobody to attribute those to and inventing an attribution would be worse than admitting we do
-- not know. They are not stranded -- claim_discord_guild() treats a claim of the guild the class is
-- already on as an idempotent provenance refresh, so the first time an instructor runs the install
-- flow the columns fill in without the server-change teardown firing.

-- ============================================================================
-- 2. One active class per guild
-- ============================================================================

-- Fail loudly and early if the data already violates what the index is about to enforce. Without
-- this the migration dies inside CREATE UNIQUE INDEX with a message naming a duplicate key value and
-- no way to find the courses involved. No production class uses this feature yet, so this is
-- expected to be a no-op.
DO $$
DECLARE
  v_dupes text;
BEGIN
  SELECT string_agg(format('guild %s: classes %s', d.discord_server_id, d.class_ids), '; ')
  INTO v_dupes
  FROM (
    SELECT c.discord_server_id, string_agg(c.id::text, ',' ORDER BY c.id) AS class_ids
    FROM public.classes c
    WHERE c.discord_server_id IS NOT NULL
      AND COALESCE(c.archived, false) = false
    GROUP BY c.discord_server_id
    HAVING count(*) > 1
  ) d;

  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot enforce one Discord server per active class: % . Clear discord_server_id on the classes that should not own the server (or archive them) and re-run.', v_dupes;
  END IF;
END $$;

-- is_class_active(archived, end_date) is the predicate the rest of the Discord code scopes on, and
-- it is NOT usable here: index predicates must be IMMUTABLE, and that function is STABLE because it
-- compares against CURRENT_DATE. Even inlined the end_date half would be rejected for the same
-- reason -- an index whose contents depend on today's date cannot be maintained.
--
-- So the index enforces the immutable half, `archived = false`, and claim_discord_guild() below
-- checks exactly the same condition rather than the wider is_class_active(). Two predicates that
-- disagree would mean the RPC accepting a claim the index then rejects, surfacing an unexplained
-- constraint violation instead of the message written for the case.
--
-- The cost is that an unarchived class that ended last term keeps its guild reserved. That is the
-- safe direction to fail, and the remediation -- archive the finished course -- is one an instructor
-- already has, so the alternative (letting a new class take over a server that another class's
-- worker still has channels in) is not worth the convenience.
CREATE UNIQUE INDEX IF NOT EXISTS classes_discord_server_id_active_key
  ON public.classes (discord_server_id)
  WHERE discord_server_id IS NOT NULL AND COALESCE(archived, false) = false;

COMMENT ON INDEX public.classes_discord_server_id_active_key IS
  'One unarchived class per Discord guild. Partial rather than plain unique: archived classes keep their historical server id, and NULL means no server. The active-class predicate is archived-only because is_class_active() is not IMMUTABLE and so cannot appear here.';

CREATE OR REPLACE FUNCTION public.claim_discord_guild(p_class_id bigint, p_guild_id text, p_claimed_by uuid DEFAULT NULL::uuid)
 RETURNS TABLE(class_id bigint, guild_id text, claimed_by uuid, claimed_at timestamp with time zone, previous_guild_id text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_guild text := btrim(COALESCE(p_guild_id, ''));
  v_claimant uuid := COALESCE(p_claimed_by, auth.uid());
  v_previous text;
  v_archived boolean;
  v_conflict_id bigint;
  v_conflict_active boolean;
  v_now timestamptz := now();
BEGIN
  IF p_class_id IS NULL THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_INVALID: a class id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Discord snowflakes are 17-20 decimal digits today and grow only at the top end. Validated here
  -- and not just in the route because this value is interpolated into REST paths by the worker: a
  -- guild id containing a slash or a query string would be a path-traversal primitive against the
  -- Discord API, and every downstream consumer trusts this column.
  IF v_guild !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_INVALID: % is not a Discord server id', v_guild
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- FOR UPDATE so two callbacks for the same class cannot interleave their read and write, and so a
  -- concurrent claim of the same guild by a different class blocks rather than racing the check
  -- below. The lock is taken before anything is validated: an authorization failure rolls back.
  --
  -- FOUND, not a sentinel column selected alongside: SELECT ... INTO with no matching row sets
  -- every target to NULL, so a `v_found boolean` would come back NULL and `IF NOT v_found` would
  -- fall through -- reporting a claim on a class that does not exist.
  --
  -- `archived` is read under the same lock as the rest, so a class being archived concurrently
  -- either commits before this lock is taken (and is refused below) or waits behind it (and its
  -- BEFORE UPDATE trigger then clears the guild this call just wrote). Reading it in a second
  -- statement would leave a window where both could succeed.
  SELECT c.discord_server_id, COALESCE(c.archived, false)
  INTO v_previous, v_archived
  FROM public.classes c
  WHERE c.id = p_class_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_CLASS_NOT_FOUND: class % does not exist', p_class_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- A null claimant is refused rather than recorded as "unknown". Provenance is half the point of
  -- this function, and an unattributed claim is exactly the state the old free-text field left us in.
  IF v_claimant IS NULL THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_FORBIDDEN: a claiming user is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Instructor of this class, or a platform admin. authorize_for_admin() is deliberately not reused:
  -- it returns true unconditionally when auth.role() = 'service_role', which is every caller of this
  -- function, so it would authorize nothing at all here.
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.class_id = p_class_id
      AND ur.user_id = v_claimant
      AND ur.disabled = false
      AND ur.role = 'instructor'::public.app_role
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = v_claimant
      AND ur.disabled = false
      AND ur.role = 'admin'::public.app_role
  ) THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_FORBIDDEN: user % is not an instructor of class %', v_claimant, p_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Checked after authorization, not before: an archived class is a fact about the course, and the
  -- error naming it should only reach somebody who is already established as staff of it.
  --
  -- `archived` alone, not is_class_active(archived, end_date), for the same reason the uniqueness
  -- index above uses it: `archived` is the condition the uniqueness index enforces, and a guard stricter
  -- than the index would refuse claims the index would have accepted. An unarchived class whose
  -- end_date has passed can still connect a server, exactly as before.
  IF v_archived THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_CLASS_ARCHIVED: class % is archived, so it cannot connect a Discord server. Un-archive the course first.', p_class_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- The same condition the unique index enforces, so the two cannot disagree.
  SELECT c.id, public.is_class_active(c.archived, c.end_date)
  INTO v_conflict_id, v_conflict_active
  FROM public.classes c
  WHERE c.discord_server_id = v_guild
    AND c.id <> p_class_id
    AND COALESCE(c.archived, false) = false
  LIMIT 1;

  IF v_conflict_id IS NOT NULL THEN
    -- One sentinel, two remediations. A live course holding the server needs a human conversation;
    -- a finished-but-unarchived one just needs archiving, and saying "another course" without saying
    -- which kind sends the instructor to the wrong fix.
    IF v_conflict_active THEN
      RAISE EXCEPTION 'DISCORD_GUILD_ALREADY_CLAIMED: Discord server % is already connected to another course (class %)', v_guild, v_conflict_id
        USING ERRCODE = 'unique_violation';
    ELSE
      RAISE EXCEPTION 'DISCORD_GUILD_ALREADY_CLAIMED: Discord server % is still connected to class %, a course that has ended but has not been archived. Archive it to reuse the server.', v_guild, v_conflict_id
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  IF v_previous IS NOT DISTINCT FROM v_guild THEN
    -- Re-claiming the guild the class is already on: re-running the install flow to widen the bot's
    -- permissions, or filling in provenance for a server configured before this migration.
    -- discord_server_id is left out of the UPDATE entirely. Both server-change triggers already
    -- guard on IS DISTINCT FROM and so would not fire on a same-value write, but not writing it at
    -- all is the statement that this branch is not a move, and it keeps the row's teardown path
    -- one behaviour rather than two that happen to agree.
    UPDATE public.classes
    SET discord_server_claimed_by = v_claimant,
        discord_server_claimed_at = v_now
    WHERE id = p_class_id;
  ELSE
    -- A move. Both existing triggers on UPDATE OF discord_server_id do their work here, unchanged:
    -- clear_discord_roles_on_server_change (BEFORE) drops the tracked roles, channels and messages
    -- from the old guild and nulls discord_channel_group_id, and
    -- trigger_discord_create_roles_on_server_connect (AFTER) then finds no roles and enqueues a
    -- fresh set plus the #scheduling and #operations channels in the new one. Nothing about the
    -- claim path bypasses them -- this is an ordinary UPDATE of the column.
    UPDATE public.classes
    SET discord_server_id = v_guild,
        discord_server_claimed_by = v_claimant,
        discord_server_claimed_at = v_now
    WHERE id = p_class_id;
  END IF;

  -- A verified claim is the signal that whatever parked this guild has been dealt with.
  --
  -- discord_circuit_breakers is keyed by (scope, key) = ('guild', <guild id>) with no class, which is
  -- correct -- the shared bot token is what a storm burns -- but it means an open breaker outlives the
  -- configuration that caused it. Two ways that bit:
  --
  --   * An instructor whose bot role was too low fixes it and re-runs the install. That path takes the
  --     same-guild refresh branch above, so nothing about the class changes, and the guild stayed
  --     parked for up to six hours while the panel reported it healthy.
  --   * A guild released by one course and claimed by another handed the new course the old one's open
  --     breaker, so its first role sync and its channel creation were deferred before it had made a
  --     single Discord call.
  --
  -- Clearing the error history too, not just the breaker row: check_discord_error_threshold() counts
  -- over a five-minute window, so leaving the samples behind lets a single fresh failure re-trip
  -- immediately on evidence from the configuration that was just replaced.
  DELETE FROM public.discord_circuit_breakers WHERE scope = 'guild' AND key = v_guild;
  -- Aliased: this function's RETURNS TABLE declares a `guild_id` output column, which shadows the
  -- table's own column in an unqualified predicate ("column reference guild_id is ambiguous").
  DELETE FROM public.discord_async_errors AS e WHERE e.guild_id = v_guild;

  RETURN QUERY SELECT p_class_id, v_guild, v_claimant, v_now, v_previous;

EXCEPTION
  WHEN unique_violation THEN
    -- Either the check above (re-raised as-is, message and all) or the unique index catching a claim
    -- that committed between the check and the UPDATE. The index's own message names a constraint
    -- and a key value, which is not something to show an instructor, so it is translated to the same
    -- sentinel the route already handles.
    IF SQLERRM LIKE 'DISCORD_GUILD_ALREADY_CLAIMED%' THEN
      RAISE;
    END IF;
    RAISE EXCEPTION 'DISCORD_GUILD_ALREADY_CLAIMED: Discord server % was just connected to another course', v_guild
      USING ERRCODE = 'unique_violation';
END;
$function$;

-- service_role only, matching every other Discord RPC that acts on behalf of a caller the function
-- cannot see (record_discord_membership_status, store_discord_role_if_current). anon and
-- authenticated are named explicitly because Supabase's default privileges grant EXECUTE to both as
-- their own ACL entries at CREATE time, and REVOKE ... FROM PUBLIC leaves those entries in place --
-- a PUBLIC-only revoke here would hand the publishable anon key the ability to point any class at
-- any guild, which is the entire hole this migration closes.
REVOKE ALL ON FUNCTION public.claim_discord_guild(bigint, text, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_discord_guild(bigint, text, uuid) TO service_role;

-- ============================================================================
-- 4. discord_server_id is no longer instructor-writable
-- ============================================================================

-- The column allow-list behind classes_instructor_update_calendar_or_discord_ids, minus
-- discord_server_id. Callers checked before changing this:
--
--   * classes_instructor_update_calendar_or_discord_ids (the only policy referencing it, defined in
--     20251213194246_calendar_discord.sql) -- the intended target. Its USING clause is unchanged, so
--     instructors keep the same rows; only the set of columns they may change narrows.
--   * only_discord_ids_changed(classes) -- a separate function with its own copy of the list, not a
--     caller of this one. It has no policy referencing it anywhere in the migrations, but it is
--     tightened identically below so a future policy cannot pick up the loose version by mistake.
--
-- The other entries stay exactly as 20260122080057 left them (that migration added
-- office_hours_description); dropping any of them would silently break the calendar and office-hours
-- settings forms on the same page.
CREATE OR REPLACE FUNCTION public.only_calendar_or_discord_ids_changed(new_row public.classes)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (
      SELECT COALESCE(
        (
          SELECT bool_and(changed.key = ANY(ARRAY[
            -- discord_server_id is absent on purpose: claim_discord_guild() is its only writer.
            -- A category id inside a guild the class already controls, so it stays editable.
            'discord_channel_group_id',
            'office_hours_ics_url',
            'events_ics_url',
            'office_hours_description',
            'updated_at'
          ]))
          FROM (
            SELECT t.key
            FROM jsonb_each(to_jsonb(new_row)) AS t(key, value)
            WHERE (to_jsonb(old_row)->t.key) IS DISTINCT FROM t.value
          ) AS changed
        ),
        true  -- no differences -> allow
      )
      FROM public.classes old_row
      WHERE old_row.id = new_row.id
    ),
    false -- no matching row found
  );
$$;

COMMENT ON FUNCTION public.only_calendar_or_discord_ids_changed(public.classes) IS
  'True when an instructor UPDATE of public.classes touches nothing outside the calendar / Discord-category / office-hours settings. discord_server_id was removed from the allow-list when the guild claim flow landed: pointing a class at a Discord server now requires proving the bot is in it, so claim_discord_guild() is the only writer.';

-- Tightened for the same reason and with the same one-line difference. The new provenance columns
-- are absent from both lists, so an instructor cannot forge a claim timestamp or reassign the claim
-- to somebody else either.
CREATE OR REPLACE FUNCTION public.only_discord_ids_changed(new_row public.classes)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (
      SELECT COALESCE(
        (
          SELECT bool_and(changed.key = ANY(ARRAY[
            'discord_channel_group_id',
            'updated_at' -- allow automatic timestamp touches if present
          ]))
          FROM (
            SELECT t.key
            FROM jsonb_each(to_jsonb(new_row)) AS t(key, value)
            WHERE (to_jsonb(old_row)->t.key) IS DISTINCT FROM t.value
          ) AS changed
        ),
        true  -- no differences -> allow
      )
      FROM public.classes old_row
      WHERE old_row.id = new_row.id
    ),
    false -- no matching row found
  );
$$;

COMMENT ON FUNCTION public.only_discord_ids_changed(public.classes) IS
  'True when an instructor UPDATE of public.classes touches nothing outside the Discord category id. Kept in step with only_calendar_or_discord_ids_changed: discord_server_id is written only by claim_discord_guild().';

-- Disconnecting a class from its Discord server.
--
-- The instructor-writable allow-list above drops discord_server_id so that claim_discord_guild()
-- is its only writer. That closed the hijack hole, but it also removed the
-- only way to set the column back to NULL: the claim function validates its argument against
-- '^[0-9]{17,20}$' and so cannot express "no server". An instructor who connected the wrong server,
-- or who is done with Discord for the term, had no way out except asking an administrator to run SQL.
--
-- This adds the missing inverse. It is a separate function rather than a NULL-accepting branch of
-- claim_discord_guild() because the two have different preconditions: a claim requires proof that the
-- bot is in the guild, and a disconnect requires nothing except being staff on the class. Folding
-- them together would mean one function whose argument decides which half of its validation runs.

CREATE OR REPLACE FUNCTION public.disconnect_discord_guild(
  p_class_id bigint,
  p_actor uuid DEFAULT NULL
)
RETURNS TABLE (
  class_id bigint,
  -- The guild the class was on, so the caller can distinguish a real disconnect from a no-op and
  -- name the server in its confirmation message.
  previous_guild_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := COALESCE(p_actor, auth.uid());
  v_previous text;
BEGIN
  IF p_class_id IS NULL THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_INVALID: a class id is required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- FOR UPDATE so a disconnect and a concurrent claim for the same class serialize rather than
  -- interleaving their read and write. FOUND rather than a sentinel column, for the reason spelled
  -- out in claim_discord_guild(): SELECT ... INTO with no matching row sets every target to NULL.
  SELECT c.discord_server_id
  INTO v_previous
  FROM public.classes c
  WHERE c.id = p_class_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_CLASS_NOT_FOUND: class % does not exist', p_class_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_FORBIDDEN: an acting user is required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Same gate as claim_discord_guild(), and the same reason for not reusing authorize_for_admin():
  -- it returns true unconditionally for service_role, which is every caller of this function.
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.class_id = p_class_id
      AND ur.user_id = v_actor
      AND ur.disabled = false
      AND ur.role = 'instructor'::public.app_role
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = v_actor
      AND ur.disabled = false
      AND ur.role = 'admin'::public.app_role
  ) THEN
    RAISE EXCEPTION 'DISCORD_CLAIM_FORBIDDEN: user % is not an instructor of class %', v_actor, p_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Already disconnected. Returning instead of raising keeps a double-submitted button idempotent,
  -- and the NULL previous_guild_id tells the caller nothing was torn down.
  IF v_previous IS NULL THEN
    RETURN QUERY SELECT p_class_id, NULL::text;
    RETURN;
  END IF;

  -- clear_discord_roles_on_server_change fires on this UPDATE and does the teardown: it drops the
  -- tracked roles, channels and messages for the old guild and nulls discord_channel_group_id. The
  -- AFTER trigger that enqueues a fresh set of roles guards on the new value being non-null, so a
  -- disconnect tears down without immediately rebuilding.
  --
  -- Provenance is cleared alongside. Leaving a claimed_by/claimed_at pointing at a server the class
  -- is no longer on would make the settings page report a claim for nothing.
  UPDATE public.classes
  SET discord_server_id = NULL,
      discord_server_claimed_by = NULL,
      discord_server_claimed_at = NULL
  WHERE id = p_class_id;

  RETURN QUERY SELECT p_class_id, v_previous;
END;
$$;

COMMENT ON FUNCTION public.disconnect_discord_guild(bigint, uuid) IS
  'Clears classes.discord_server_id for a class, releasing the guild for another course to claim. The inverse of claim_discord_guild(), and the only other writer of that column. Idempotent: disconnecting an already-disconnected class returns a NULL previous_guild_id rather than raising. Raises DISCORD_CLAIM_FORBIDDEN when the actor is not staff on the class.';

REVOKE ALL ON FUNCTION public.disconnect_discord_guild(bigint, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.disconnect_discord_guild(bigint, uuid) TO service_role;

-- The archive path now does its own teardown.
CREATE OR REPLACE FUNCTION public.release_discord_server_on_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(OLD.archived, false) = false
     AND COALESCE(NEW.archived, false) = true
     AND NEW.discord_server_id IS NOT NULL THEN
    RAISE LOG 'Releasing Discord server % from archived class %', NEW.discord_server_id, NEW.id;

    -- Called directly, NOT left to clear_discord_roles_on_server_change. That trigger is
    -- `BEFORE UPDATE OF discord_server_id`, and an archive statement names only `archived`, so
    -- PostgreSQL never schedules it however this trigger mutates NEW.
    PERFORM public.clear_discord_tracking_for_class(NEW.id);

    NEW.discord_server_id := NULL;
    NEW.discord_channel_group_id := NULL;
    NEW.discord_server_claimed_by := NULL;
    NEW.discord_server_claimed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- BEFORE UPDATE, so the write lands in the same row version rather than as a second UPDATE, and so
-- clear_discord_roles_on_server_change (also BEFORE, on discord_server_id) sees the change.
DROP TRIGGER IF EXISTS trg_release_discord_server_on_archive ON public.classes;

CREATE TRIGGER trg_release_discord_server_on_archive
  BEFORE UPDATE OF archived ON public.classes
  FOR EACH ROW
  EXECUTE FUNCTION public.release_discord_server_on_archive();

-- Any class already in this state. There are no production classes using the feature, so this is
-- expected to be a no-op, but a deployment that archived a Discord-connected class before this
-- migration would otherwise keep the stale link forever.
UPDATE public.classes
SET discord_server_id = NULL,
    discord_server_claimed_by = NULL,
    discord_server_claimed_at = NULL
WHERE COALESCE(archived, false) = true
  AND discord_server_id IS NOT NULL;

-- Revoke a class's outstanding Discord invites when it lets go of a guild.
--
-- clear_discord_tracking_for_class() drops every pointer the class holds INTO the guild -- roles,
-- channels, messages, and the discussion-topic channel id. It left the fifth
-- one alone: discord_invites. Those rows are not pointers, they are live capabilities. Invites are
-- minted with `max_age = 604800` and `max_uses = 5` (see createGuildInvite in
-- supabase/functions/_shared/DiscordWrapper.ts), and the partial uniqueness index above is
-- conditioned on `archived = false`, so a released guild is claimable by another course the
-- instant the release commits. For up to seven days after that, a former student of course A could
-- follow their old link and walk into course B's server -- as a member, with whatever @everyone can
-- read there.
--
-- Nothing surfaced it either. components/discord/pending-invites.tsx filters to invites whose
-- guild_id still equals the class's discord_server_id, which is precisely the set that stops
-- matching at teardown, so the rows became invisible at the same moment they became dangerous.
--
-- WHY THIS NEEDED A NEW ASYNC METHOD
--
-- The teardown is SQL, running inside a BEFORE trigger on `classes`, and it cannot call Discord. The
-- worker already had revokeInvite() -- it uses it to compensate for an invite it has just created and
-- could not store -- but there was no way for SQL to ASK for a revocation. `delete_invite` is that
-- request. It is not gated by the circuit breaker; the reasoning is on CIRCUIT_GATED_METHODS in
-- discord-async-worker/index.ts, and the short form is that the guild an outstanding invite points
-- into is often the very guild whose breaker is open, and parking a revocation behind it outlasts the
-- invite.
--
-- WHERE THE OLD GUILD ID COMES FROM
--
-- Not from `classes`. Three things are true at once:
--
--   * On a move or a disconnect the teardown runs from clear_discord_roles_on_server_change, a BEFORE
--     UPDATE OF discord_server_id trigger. A SELECT from inside a BEFORE trigger does see the OLD row
--     (verified: the statement's snapshot predates its own write), so reading classes here would
--     happen to work -- by relying on snapshot semantics for a security property, which is not a
--     thing to rely on.
--   * On the archive path release_discord_server_on_archive assigns NEW.discord_server_id := NULL
--     AFTER calling this function, so the ordering that makes the read work is a line of code away
--     from being reordered.
--   * The archived-class repair loop at the end of this migration calls it OUTSIDE any trigger, for classes already
--     archived with discord_server_id already NULL. There is no old value in the table to read at
--     all.
--
-- So the guild id comes from `discord_invites.guild_id`, which records the guild each invite was
-- actually minted into. That is the correct source rather than merely the available one: an invite is
-- a capability against one specific guild, and the row already says which.
--
-- WHAT IS SKIPPED, AND WHAT DELIBERATELY IS NOT
--
--   * `used = true` invites are STILL revoked. `used` is our own bookkeeping -- mark_discord_invite_used
--     sets it when the intended student turns up, and sync_all_discord_roles_for_user sets it in bulk
--     -- and it says nothing about Discord's own counter. With `max_uses = 5`, an invite marked used
--     has up to four uses left, and a link that has been clicked once is a link that has been seen
--     and can be pasted anywhere. Filtering on `used` would leave the majority of the hole open.
--   * Invites that have already expired are skipped, with a margin. `expires_at` is not a value
--     Discord returned: the worker computes it as `now() + 604800s` on its own clock right after the
--     POST, so an exact `expires_at > now()` test would trust two clocks to agree about the edge.
--     Ten minutes is wider than any skew worth tolerating, and since invites live seven days, an
--     invite that is expired at teardown is almost always expired by days. A skipped row still gets
--     deleted below -- it is dead either way, it just does not cost a Discord round trip.
--
-- The rows are deleted after the sends, in the same transaction. pgmq_public.send is transactional,
-- so a rollback takes the revocations with it and nothing is enqueued for invites that still exist.
-- Deleting them is also what lets the class be re-invited: enqueue_discord_invites_for_existing_users
-- skips a user who already has an unused, unexpired row, so a surviving row for the old guild would
-- suppress the fresh invite into the new one.
--
-- One accepted imprecision. This function knows only the class id, so on a move it revokes every
-- outstanding invite for the class, including any into a guild the class happens to be moving BACK
-- to after a previous stint there. That case self-heals, but not by the route it looks like: the
-- AFTER trigger's enqueue_discord_invites_for_existing_users enqueues NOTHING here, because it looks
-- up discord_roles and this function has just deleted those rows in the same statement. The actual
-- healer is one step further out and asynchronous -- enqueue_discord_roles_creation runs, the worker
-- inserts the new roles, and trg_sync_existing_users_on_role_creation fires
-- sync_existing_users_after_roles_created once all three role types exist, which has no discord_roles
-- guard and enqueues add_member_role for every linked, active user. So students wait one async round
-- trip for a fresh invite rather than getting one synchronously. If create_role fails permanently for
-- one of the three types that chain never completes; request_discord_reinvite's repair phase and the
-- reconciler are the backstops. The alternative, threading the incoming guild id through, would mean
-- a second signature for a function three callers and two triggers already share. A briefly reissued
-- invite link is a much smaller problem than a live one nobody can see.

CREATE OR REPLACE FUNCTION public.clear_discord_tracking_for_class(p_class_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_invite RECORD;
  v_revocations integer := 0;
BEGIN
  DELETE FROM public.discord_roles WHERE class_id = p_class_id;
  -- Channels matter more than roles: the message enqueuers select channel ids by class and type, so
  -- a stale row keeps posting course activity into a guild the class has left.
  DELETE FROM public.discord_channels WHERE class_id = p_class_id;
  -- Tracked messages name message ids inside those channels; an update would edit content in the old
  -- guild rather than posting fresh in the new one.
  DELETE FROM public.discord_messages WHERE class_id = p_class_id;
  -- The fourth pointer. Nulled rather than deleted, because the topic itself is course content that
  -- outlives any Discord server -- only its channel link is stale.
  UPDATE public.discussion_topics
  SET discord_channel_id = NULL
  WHERE class_id = p_class_id AND discord_channel_id IS NOT NULL;

  -- The fifth, and the only one that is a live capability rather than a stale pointer. Deleting the
  -- row hides the invite; revoking it is what makes the invite stop working. See the header.
  FOR v_invite IN
    SELECT i.invite_code, i.guild_id
    FROM public.discord_invites i
    WHERE i.class_id = p_class_id
      AND i.expires_at > now() - interval '10 minutes'
  LOOP
    -- Same envelope shape as every other enqueue_discord_* function: method, args, class_id. No
    -- api_gateway_calls row -- that table is written by the GitHub async gateway's enqueuers, and no
    -- Discord enqueuer has ever logged to it.
    PERFORM pgmq_public.send(
      queue_name := 'discord_async_calls',
      message := jsonb_build_object(
        'method', 'delete_invite',
        'args', jsonb_build_object(
          'invite_code', v_invite.invite_code,
          'guild_id', v_invite.guild_id
        ),
        'class_id', p_class_id
      )
    );
    v_revocations := v_revocations + 1;
  END LOOP;

  IF v_revocations > 0 THEN
    RAISE LOG 'Enqueued % Discord invite revocation(s) for class %', v_revocations, p_class_id;
  END IF;

  -- Every row, not just the ones revoked above: an expired invite is not worth a Discord call but it
  -- is still a row naming a guild the class has left, and leaving it would suppress the replacement
  -- invite for that user.
  DELETE FROM public.discord_invites WHERE class_id = p_class_id;

  -- The sixth, and the one this function used to leave behind. Same argument as the expired invites
  -- above: a discord_membership_status row names a guild_id, so once the class leaves that guild the
  -- row is a permanent record of a failure in a server nobody owns any more.
  --
  -- Leaving them was not merely untidy. Nothing else deletes them (only the Discord-unlink trigger,
  -- per user), the unique key is (class_id, user_id, guild_id) so a move mints a fresh row beside the
  -- old one, and every reader hides them by joining classes.discord_server_id = guild_id -- so they
  -- were invisible, immortal, and one per enrolled student per guild the course ever used. The
  -- >12h alert pass in discord-reconciler selects the OLDEST cannot_invite rows first, and these are
  -- structurally the oldest, so a couple of large courses that had ever moved or been archived could
  -- fill its entire per-pass sample with rows the filter then discards -- and the alert would never
  -- fire again for anybody. Deleting them here removes that class of failure at the source.
  DELETE FROM public.discord_membership_status WHERE class_id = p_class_id;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_discord_tracking_for_class(bigint) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.clear_discord_tracking_for_class(bigint) TO service_role;

-- Unchanged behaviour, now expressed through the shared function.
CREATE OR REPLACE FUNCTION public.clear_discord_roles_on_server_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.clear_discord_tracking_for_class(NEW.id);
  -- The category the channels were created under is likewise an id in the old guild. BEFORE trigger,
  -- so assigning to NEW is what persists.
  NEW.discord_channel_group_id := NULL;
  RETURN NEW;
END;
$$;

-- Repair anything the previous migration released without tearing down.
DO $$
DECLARE
  v_class_id bigint;
BEGIN
  FOR v_class_id IN
    SELECT c.id
    FROM public.classes c
    WHERE COALESCE(c.archived, false) = true
      AND (
        EXISTS (SELECT 1 FROM public.discord_roles r WHERE r.class_id = c.id)
        OR EXISTS (SELECT 1 FROM public.discord_channels ch WHERE ch.class_id = c.id)
        OR EXISTS (SELECT 1 FROM public.discord_messages m WHERE m.class_id = c.id)
      )
  LOOP
    RAISE LOG 'Clearing orphaned Discord tracking for archived class %', v_class_id;
    PERFORM public.clear_discord_tracking_for_class(v_class_id);
  END LOOP;
END $$;

UPDATE public.classes
SET discord_channel_group_id = NULL
WHERE COALESCE(archived, false) = true
  AND discord_server_id IS NULL
  AND discord_channel_group_id IS NOT NULL;

COMMENT ON FUNCTION public.claim_discord_guild(bigint, text, uuid) IS
  'Records that a class controls a Discord guild, after the install callback has confirmed the bot is in it. The only writer of classes.discord_server_id: instructor UPDATEs can no longer touch that column. Raises DISCORD_GUILD_ALREADY_CLAIMED (SQLSTATE 23505) when another unarchived class holds the guild, DISCORD_CLAIM_CLASS_ARCHIVED (SQLSTATE 55000) when the claiming class is archived -- archiving releases the guild for another course, so an archived class must not be able to take one -- DISCORD_CLAIM_FORBIDDEN when the claimant is not staff, DISCORD_CLAIM_CLASS_NOT_FOUND when the class does not exist, and DISCORD_CLAIM_INVALID for a malformed guild id.';

-- ============================================================================
-- 7. store_discord_channel_if_current: name the conflict it means
-- ============================================================================

-- Body unchanged except for the ON CONFLICT target. A bare `ON CONFLICT DO NOTHING` swallows a
-- violation of ANY unique constraint on the table, and discord_channels has two: the
-- (class_id, channel_type, resource_id) one this insert is about, and (class_id, discord_channel_id).
-- The second firing means something quite different -- this channel is already tracked under another
-- type -- and reporting it as an ordinary "already tracked" hid it. Naming the target is also what the
-- role counterpart store_discord_role_if_current() does.
CREATE OR REPLACE FUNCTION public.store_discord_channel_if_current(
  p_class_id bigint,
  p_channel_type public.discord_channel_type,
  p_discord_channel_id text,
  p_guild_id text,
  p_resource_id bigint DEFAULT NULL
)
RETURNS TABLE (stored boolean, superseded boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_guild text;
  v_inserted boolean := false;
BEGIN
  -- FOR UPDATE, so a server change cannot commit between this read and the insert below. Same lock
  -- the role version takes, and against the same writers: claim_discord_guild(),
  -- disconnect_discord_guild() and the archive trigger all UPDATE this row.
  SELECT c.discord_server_id INTO v_current_guild
  FROM public.classes c
  WHERE c.id = p_class_id
  FOR UPDATE;

  -- Superseded, not failed. The channel really was created; it just belongs to a server this class no
  -- longer uses, so the honest outcome is to not record it and let the caller archive the envelope.
  -- The orphaned Discord channel is left behind exactly as a move or disconnect leaves the others.
  IF v_current_guild IS DISTINCT FROM p_guild_id THEN
    RETURN QUERY SELECT false, true;
    RETURN;
  END IF;

  INSERT INTO public.discord_channels (class_id, discord_channel_id, channel_type, resource_id)
  VALUES (p_class_id, p_discord_channel_id, p_channel_type, p_resource_id)
  ON CONFLICT (class_id, channel_type, resource_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN QUERY SELECT v_inserted, false;
END;
$$;

COMMENT ON FUNCTION public.store_discord_channel_if_current(bigint, public.discord_channel_type, text, text, bigint) IS
  'Records a created Discord channel only if the class is still on the guild it was created in. The channel counterpart of store_discord_role_if_current: closes the window across the createChannel() call, where a concurrent move, disconnect or archive would otherwise have its teardown undone by an unconditional insert.';

REVOKE ALL ON FUNCTION public.store_discord_channel_if_current(bigint, public.discord_channel_type, text, text, bigint)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.store_discord_channel_if_current(bigint, public.discord_channel_type, text, text, bigint)
  TO service_role;

-- ============================================================================
-- The reconciler must not spend the instructor's retry throttle
-- ============================================================================

-- last_retry_requested_at has one meaning everywhere else: "a human asked for this student to be
-- retried, recently". request_discord_reinvite() writes it and gates on it with a five-minute window,
-- and components/discord/reinvite-button.tsx reads the same column to decide whether the Re-invite
-- button is enabled and what it says.
--
-- The reconciler needs a throttle of its own to keep its passes from doubling up, and the obvious
-- shortcut -- stamping that same column -- does not work. The two uses cannot share one. The
-- reconciler runs at minutes 7, 22, 37 and 52 and would stamp now(), so
-- for five minutes out of every fifteen -- a third of the term -- an instructor pressing Re-invite got
-- `queued = 0` and a button that said somebody had already asked a moment ago. On exactly the students
-- the reconciler had just picked up, which are exactly the stuck ones an instructor opens the roster to
-- fix. There is no error; the retry simply does not happen.
--
-- So the reconciler gets its own column and keeps READING the human one, which is the "do not fight a
-- human" guard it always wanted. Dropping the write without replacing it does not work: the pgmq
-- `queued` CTE covers the in-flight window, but an envelope that dead-letters leaves the queue without
-- anything updating last_observed_at, and the candidate then comes back every fifteen minutes forever.
-- That is what the stamp was really preventing.
ALTER TABLE public.discord_membership_status
  ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;

COMMENT ON COLUMN public.discord_membership_status.last_reconciled_at IS
  'When reconcile_stuck_discord_memberships() last re-enqueued this row. The reconciler''s own throttle, deliberately separate from last_retry_requested_at: that column is the instructor Re-invite throttle and the Re-invite button''s enabled state, and sharing it meant an automated pass disabled the button for the students it had just picked up.';

COMMENT ON FUNCTION public.reconcile_stuck_discord_memberships(integer, integer) IS
  'Re-enqueue Discord membership checks for active-class users whose membership status has gone unobserved for p_stale_minutes, skipping terminal (cannot_invite) rows, guilds with an open circuit breaker, and work already queued. Returns how many were enqueued. Throttles itself on last_reconciled_at and defers to humans by reading last_retry_requested_at; it must never write the latter, which is the instructor Re-invite throttle and the Re-invite button''s enabled state.';

-- ============================================================================
-- The index the >12h alert scan needs
-- ============================================================================

-- discord-reconciler runs every fifteen minutes and asks
-- `state = 'cannot_invite' AND first_observed_at < now() - 12h`, with no class_id. The only index on
-- the table is (class_id, state) from 20260811183000, whose leading column that predicate does not
-- constrain, so the query scans. discord_membership_status has one row per enrolled student per class
-- and nothing prunes it -- rows deliberately survive a student being dropped -- so this is the one
-- query in the feature whose cost grows with total historical enrollment.
CREATE INDEX IF NOT EXISTS idx_discord_membership_status_state_first_observed
  ON public.discord_membership_status (state, first_observed_at);

COMMENT ON INDEX public.idx_discord_membership_status_state_first_observed IS
  'Serves the discord-reconciler >12h stuck alert, which filters on state and first_observed_at with no class scope. (class_id, state) cannot serve it: class_id leads and is unconstrained.';

COMMENT ON FUNCTION public.open_discord_circuit(text, text, text, integer, text) IS
  'Open or extend a Discord per-guild circuit breaker and return the guild''s trip count. Escalates exponentially to a six-hour cap, but resets the count to 1 when the guild has been quiet for 24 hours: nothing closes a breaker or clears the count, so without decay a guild that misbehaved once last term would start its next incident already at the cap.';

COMMENT ON FUNCTION public.cleanup_discord_async_errors() IS
  'Daily trim of the Discord breaker''s inputs and state: discord_async_errors older than 7 days, and discord_circuit_breakers rows untouched for 30 days that are not currently open. Bounds the metrics endpoint''s per-guild gauge, which would otherwise carry a permanent series for every guild that ever tripped.';

-- Spelled out because the obvious reading of this trigger is wrong: it looks like it should delegate
-- the teardown to clear_discord_roles_on_server_change, and it deliberately does not.
COMMENT ON FUNCTION public.release_discord_server_on_archive() IS
  'Clears classes.discord_server_id when a class is archived, and performs the tracking teardown inline via clear_discord_tracking_for_class(). Inline and not delegated: clear_discord_roles_on_server_change is BEFORE UPDATE OF discord_server_id, and PostgreSQL schedules those triggers from the UPDATE statement''s column list, so an archive naming only `archived` never fires it however this trigger mutates NEW.';

COMMENT ON FUNCTION public.clear_discord_tracking_for_class(bigint) IS
  'Drops every pointer a class holds into its Discord server -- the discord_roles / discord_channels / discord_messages rows, discussion_topics.discord_channel_id, and the discord_membership_status rows for the guild it is leaving -- and revokes its outstanding invites, by enqueueing a delete_invite for each and then deleting the discord_invites rows. Shared by the server-change trigger, the archive trigger and the repair loops so they cannot drift. Does not touch discord_channel_group_id, which is a column on classes and must be assigned by a BEFORE trigger.';

-- Repair what every teardown before this migration left behind: invites into a guild their class no
-- longer uses. Same shape as the archived-class repair loop above, and the same reason for having one --
-- the fix is worthless for the servers that have already been released.
--
-- Deliberately NOT keyed on `used`. `IS DISTINCT FROM` rather than `<>` so a class whose
-- discord_server_id is NULL -- disconnected, or archived, which nulls it -- is caught rather than
-- dropped by three-valued logic; those are the classes with the most to answer for.
--
-- The size of this is bounded by the number of unexpired invites into guilds their class has left,
-- which is a one-off backlog rather than anything recurring, and most of them will already have
-- lapsed at Discord and answer 404 for one request each. That is well inside the 50-per-second
-- primary limit on the shared token, and unlike the fan-out the circuit breaker exists for, nothing
-- re-enqueues behind it.
DO $$
DECLARE
  v_invite RECORD;
  v_revocations integer := 0;
BEGIN
  FOR v_invite IN
    SELECT i.invite_code, i.guild_id, i.class_id
    FROM public.discord_invites i
    JOIN public.classes c ON c.id = i.class_id
    WHERE i.expires_at > now() - interval '10 minutes'
      AND c.discord_server_id IS DISTINCT FROM i.guild_id
  LOOP
    PERFORM pgmq_public.send(
      queue_name := 'discord_async_calls',
      message := jsonb_build_object(
        'method', 'delete_invite',
        'args', jsonb_build_object(
          'invite_code', v_invite.invite_code,
          'guild_id', v_invite.guild_id
        ),
        'class_id', v_invite.class_id
      )
    );
    v_revocations := v_revocations + 1;
  END LOOP;

  IF v_revocations > 0 THEN
    RAISE LOG 'Backfill: enqueued % revocation(s) for invites into released Discord guilds', v_revocations;
  END IF;
END $$;

-- And drop the rows, expired ones included, for the same reason the function does.
DELETE FROM public.discord_invites i
USING public.classes c
WHERE c.id = i.class_id
  AND c.discord_server_id IS DISTINCT FROM i.guild_id;

-- Make the discord_channels arbiter actually arbitrate, for the channel types that have no resource.
--
-- store_discord_channel_if_current() ends with
--   ON CONFLICT (class_id, channel_type, resource_id) DO NOTHING
-- and reports `stored = false` so the worker can log that the channel it just created in Discord is a
-- duplicate nobody will ever post to. That never fired for four of the seven channel types.
--
-- discord_channels_class_id_channel_type_resource_id_key is a plain UNIQUE constraint, and a btree
-- unique index treats NULLs as distinct. `resource_id` is NULL for 'scheduling', 'operations',
-- 'regrades' and 'general' -- the ones enqueue_discord_channel_creation() is called with a defaulted
-- resource id for -- so two rows for the same (class_id, channel_type) were always legal. Confirmed
-- against a migrated database: two calls with p_resource_id => NULL both returned stored = true and
-- left two rows.
--
-- The consequence is not just an unreported duplicate. The message enqueuers read the channel back
-- with a non-STRICT `SELECT dc.discord_channel_id INTO v_discord_channel_id ... WHERE channel_type =
-- '...'`, which has no ORDER BY and silently takes whichever row the planner returns, so a class with
-- two #regrades rows sends some of its regrade notifications to a channel nobody is watching. The
-- enqueuers' own check-then-enqueue (SELECT, then enqueue if NULL, with no lock) is what produces the
-- pair: two regrade requests before the channel exists yield two create_channel envelopes.
--
-- NULLS NOT DISTINCT is the fix rather than a COALESCE expression index, because the intent really is
-- "one channel per (class, type) when the type has no resource" -- exactly what the constraint name
-- says. Pre-branch code inserted these rows with a bare .insert() and no ON CONFLICT, so duplicates
-- may already exist and are deduped first; the surviving row is the oldest, which is the one the
-- enqueuers' arbitrary SELECT has been most likely to return and therefore the one already in use.

DO $dedupe$
DECLARE
  v_deleted integer;
BEGIN
  WITH ranked AS (
    SELECT id,
           row_number() OVER (
             PARTITION BY class_id, channel_type
             ORDER BY id ASC
           ) AS rn
    FROM public.discord_channels
    WHERE resource_id IS NULL
  )
  DELETE FROM public.discord_channels dc
  USING ranked r
  WHERE dc.id = r.id AND r.rn > 1;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted > 0 THEN
    -- Logged rather than silent: each dropped row is a channel that still exists in Discord and is now
    -- untracked, which is a thing an administrator may want to go and delete by hand.
    RAISE LOG 'Deduped % duplicate resource-less discord_channels row(s); the newer Discord channels are now untracked', v_deleted;
  END IF;
END;
$dedupe$;

ALTER TABLE public.discord_channels
  DROP CONSTRAINT IF EXISTS discord_channels_class_id_channel_type_resource_id_key;

ALTER TABLE public.discord_channels
  ADD CONSTRAINT discord_channels_class_id_channel_type_resource_id_key
  UNIQUE NULLS NOT DISTINCT (class_id, channel_type, resource_id);

COMMENT ON CONSTRAINT discord_channels_class_id_channel_type_resource_id_key ON public.discord_channels IS
  'One tracked channel per (class, type, resource). NULLS NOT DISTINCT because resource_id is NULL for the class-level types (scheduling, operations, regrades, general) and the default NULLS DISTINCT let those duplicate freely -- which store_discord_channel_if_current''s ON CONFLICT arbiter silently failed to catch, and which made the message enqueuers pick one of two channels at random.';

-- Select the >12h stuck-membership alert in one query, instead of filtering a capped sample in the edge
-- function.
--
-- discord-reconciler's alert pass used to pull up to 2000 rows ordered oldest-first and then apply, in
-- TypeScript, (a) "is this row for the guild the class is on now", (b) a hand-ported copy of
-- is_class_active(), and (c) an active-enrollment check issued as up to twenty sequential chunked
-- user_roles reads with two hand-written truncation guards.
--
-- Every one of those predicates removes rows, and all of them ran AFTER the cap. Dead rows are
-- structurally the oldest -- a departed guild freezes first_observed_at forever, and a dropped student's
-- row is kept on purpose so an instructor re-enabling them does not lose the history -- so the sample
-- could fill entirely with rows the filters then discarded, and the alert would report nothing while a
-- real class was locked out. That is not a tuning problem; a cap applied before the predicates cannot be
-- made safe by raising it. clear_discord_tracking_for_class() above deletes the membership rows for a
-- guild a class leaves, which removes the largest source, but dropped students on a live guild produce the same shape.
--
-- Answering in SQL makes the cap irrelevant: the predicates are applied first and the result is already
-- one row per class, which is all the alert ever used the rows for. It also replaces up to twenty
-- serial round trips per pass with one.
--
-- is_class_active() is called rather than re-expressed, so the alert half and the re-enqueue half
-- cannot drift -- the whole point of the helper.

CREATE OR REPLACE FUNCTION public.get_stuck_discord_membership_alerts(
  p_hours integer DEFAULT 12
)
RETURNS TABLE (
  class_id bigint,
  class_name text,
  guild_id text,
  affected_users bigint,
  oldest_first_observed_at timestamptz,
  last_observed_at timestamptz,
  discord_error_code integer,
  detail text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  WITH live AS (
    SELECT dms.class_id,
           c.name AS class_name,
           dms.guild_id,
           dms.first_observed_at,
           dms.last_observed_at,
           dms.discord_error_code,
           dms.detail
    FROM public.discord_membership_status dms
    JOIN public.classes c ON c.id = dms.class_id
    WHERE dms.state = 'cannot_invite'
      AND dms.first_observed_at < now() - make_interval(hours => GREATEST(COALESCE(p_hours, 12), 0))
      -- The guild the class is on NOW. A row for a guild it has left is not a live failure, and
      -- get_discord_membership_status_for_class() hides those from instructors for the same reason.
      AND c.discord_server_id = dms.guild_id
      AND public.is_class_active(c.archived, c.end_date)
      -- Still expected in the server. A student who reached cannot_invite and was then dropped keeps
      -- their row deliberately, so without this the class is paged every fifteen minutes about somebody
      -- who is not supposed to be there.
      AND EXISTS (
        SELECT 1
        FROM public.user_roles ur
        WHERE ur.class_id = dms.class_id
          AND ur.user_id = dms.user_id
          AND ur.disabled = false
      )
  )
  -- One row per class: one misconfigured guild affects every enrolled student, and per-student events
  -- are the dead-letter flood again with Sentry standing in for pgmq. The reported cause is the oldest
  -- row's, which is the failure the alert is about.
  SELECT DISTINCT ON (l.class_id)
         l.class_id,
         l.class_name,
         l.guild_id,
         count(*) OVER (PARTITION BY l.class_id) AS affected_users,
         l.first_observed_at,
         l.last_observed_at,
         l.discord_error_code,
         l.detail
  FROM live l
  ORDER BY l.class_id, l.first_observed_at ASC;
$$;

COMMENT ON FUNCTION public.get_stuck_discord_membership_alerts(integer) IS
  'One row per class whose Discord membership has been failing longer than p_hours, already scoped to the class''s current guild, to active classes, and to still-enrolled users. Serves discord-reconciler''s >12h alert. Exists so those predicates are applied before any row cap rather than after it: filtering a capped sample in the client let permanently-dead rows, which are always the oldest, crowd out live failures and silence the alert entirely.';

REVOKE ALL ON FUNCTION public.get_stuck_discord_membership_alerts(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_stuck_discord_membership_alerts(integer) TO service_role;

-- Make linking a Discord account actually fire the link handler, on the INSERT that is the link.
--
-- `update_discord_profile()` is what copies a Discord identity onto `public.users` (discord_id,
-- discord_username) and then calls `check_discord_role_sync_after_link()`, which enqueues a role sync
-- for every active enrollment in a class with a Discord server -- i.e. it is already the "auto-invite
-- on link" mechanism. But it was only ever attached to auth.identities on UPDATE:
--
--   trg_update_discord_profile           AFTER UPDATE ON auth.identities
--   trg_update_discord_profile_on_update AFTER UPDATE ON auth.identities   (a duplicate of the above)
--
-- Linking an account INSERTs a row into auth.identities. Verified against a migrated database: after
-- the INSERT, `users.discord_id` is still NULL and no sync is enqueued; it only populates when
-- something later UPDATEs that identity row. So the entire Discord link has been relying on GoTrue
-- happening to touch the row after creating it (last_sign_in_at / updated_at on the sign-in that
-- completes the OAuth round trip). When it does, the link works and looks fine; nothing in the schema
-- makes it happen, and the invite arrives on whatever schedule that incidental write does.
--
-- The GitHub side has had `update_github_profile_trigger AFTER INSERT ON auth.identities` since the
-- beginning. This is the missing Discord half of the same pair. 20260103201410_fix-discord-link.sql
-- added the second UPDATE trigger, which suggests the symptom was noticed and diagnosed as "the
-- handler does not run often enough" rather than "it is on the wrong event" -- two copies on UPDATE
-- cannot fix a missing INSERT, and running the handler twice per update is not free.
--
-- `check_discord_role_sync_after_link()` is deliberately NOT taught about the student-join feature
-- flag here. It enqueues; the worker decides. discord-async-worker already re-checks
-- discord_student_join_enabled() before creating an invite for a student, and the flag's contract is
-- that role syncing for students ALREADY in the server keeps working while invitations are off --
-- a distinction only the worker has the information to make.

DROP TRIGGER IF EXISTS trg_update_discord_profile_on_insert ON auth.identities;

CREATE TRIGGER trg_update_discord_profile_on_insert
  AFTER INSERT ON auth.identities
  FOR EACH ROW
  WHEN (NEW.provider = 'discord')
  EXECUTE FUNCTION public.update_discord_profile();

COMMENT ON FUNCTION public.update_discord_profile() IS
  'Copies a linked Discord identity onto public.users and, on a first-time link, calls check_discord_role_sync_after_link() to enqueue a role sync (and therefore an invite) for the user''s active enrollments. Attached to auth.identities on both INSERT and UPDATE: the INSERT is the link, and before trg_update_discord_profile_on_insert existed the handler ran only if something later happened to update the identity row.';

-- The redundant one. Same event, same function, same row -- so the handler ran twice per identity
-- update, doing the UPDATE on public.users twice. Harmless for the sync itself (the second pass sees
-- discord_id already set and skips check_discord_role_sync_after_link), which is why it went unnoticed.
DROP TRIGGER IF EXISTS trg_update_discord_profile_on_update ON auth.identities;
