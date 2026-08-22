-- Repairs to the Discord reconciler and the per-guild circuit breaker.
--
-- Six things, all of them consequences of how 20260822120000 and 20260822180000 interact with code
-- that already existed.
--
-- NOTE FOR REGENERATION: this adds one column, discord_membership_status.last_reconciled_at, so
-- SupabaseTypes.d.ts is stale until `npm run client-local`. No TypeScript reads the column -- the
-- reconciler reaches it only through reconcile_stuck_discord_memberships() -- so nothing fails to
-- compile in the meantime.
--
--   1. The reconciler gets its own throttle column instead of spending the instructor's Re-invite one.
--   2. Its p_limit handling stops turning a NULL into a silent LIMIT 0.
--   3. An index for the >12h alert's scan, which had none.
--   4. The breaker's trip count decays, so a guild that was fixed months ago does not start its next
--      incident at the six-hour cap.
--   5. The breaker's backoff arithmetic stops being able to overflow integer.
--   6. Breaker rows are pruned, like the error log they are computed from already is.
--
-- Plus the COMMENT that 20260822160000 left describing a function body it had replaced.

-- ============================================================================
-- 1 + 2. The reconciler must not spend the instructor's retry throttle
-- ============================================================================

-- last_retry_requested_at has one meaning everywhere else: "a human asked for this student to be
-- retried, recently". request_discord_reinvite() writes it and gates on it with a five-minute window,
-- and components/discord/reinvite-button.tsx reads the same column to decide whether the Re-invite
-- button is enabled and what it says.
--
-- 20260822120000 had the reconciler stamp it too, to keep its own passes from doubling up. The two
-- uses cannot share one column. The reconciler runs at minutes 7, 22, 37 and 52 and stamps now(), so
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

COMMENT ON FUNCTION public.reconcile_stuck_discord_memberships(integer, integer) IS
  'Re-enqueue Discord membership checks for active-class users whose membership status has gone unobserved for p_stale_minutes, skipping terminal (cannot_invite) rows, guilds with an open circuit breaker, and work already queued. Returns how many were enqueued. Throttles itself on last_reconciled_at and defers to humans by reading last_retry_requested_at; it must never write the latter, which is the instructor Re-invite throttle and the Re-invite button''s enabled state.';

REVOKE ALL ON FUNCTION public.reconcile_stuck_discord_memberships(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stuck_discord_memberships(integer, integer) TO service_role;

-- ============================================================================
-- 3. The index the >12h alert scan needs
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

COMMENT ON FUNCTION public.open_discord_circuit(text, text, text, integer, text) IS
  'Open or extend a Discord per-guild circuit breaker and return the guild''s trip count. Escalates exponentially to a six-hour cap, but resets the count to 1 when the guild has been quiet for 24 hours: nothing closes a breaker or clears the count, so without decay a guild that misbehaved once last term would start its next incident already at the cap.';

REVOKE ALL ON FUNCTION public.open_discord_circuit(text, text, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_discord_circuit(text, text, text, integer, text) TO service_role;

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

COMMENT ON FUNCTION public.cleanup_discord_async_errors() IS
  'Daily trim of the Discord breaker''s inputs and state: discord_async_errors older than 7 days, and discord_circuit_breakers rows untouched for 30 days that are not currently open. Bounds the metrics endpoint''s per-guild gauge, which would otherwise carry a permanent series for every guild that ever tripped.';

REVOKE ALL ON FUNCTION public.cleanup_discord_async_errors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_discord_async_errors() TO service_role;

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

REVOKE ALL ON FUNCTION public.store_discord_channel_if_current(bigint, public.discord_channel_type, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_discord_channel_if_current(bigint, public.discord_channel_type, text, text, bigint)
  TO service_role;

-- ============================================================================
-- 8. The comment 20260822160000 left behind
-- ============================================================================

-- 20260822150000 set this comment and 20260822160000 replaced the function body without replacing the
-- comment, so the description still said the teardown happens via clear_discord_roles_on_server_change
-- -- which is the assumption 20260822160000 exists to correct.
COMMENT ON FUNCTION public.release_discord_server_on_archive() IS
  'Clears classes.discord_server_id when a class is archived, and performs the tracking teardown inline via clear_discord_tracking_for_class(). Inline and not delegated: clear_discord_roles_on_server_change is BEFORE UPDATE OF discord_server_id, and PostgreSQL schedules those triggers from the UPDATE statement''s column list, so an archive naming only `archived` never fires it however this trigger mutates NEW.';
