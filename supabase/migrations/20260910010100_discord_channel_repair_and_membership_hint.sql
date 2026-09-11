-- Give Discord channels a repair path, and stop the batch role sync paying for the same guild
-- member lookup twice.
--
-- Two independent problems, both observed in production on 2026-09-09/10 against class 636.
--
-- 1. A class's #scheduling and #operations channels had no way back once their create_channel
--    envelopes failed. All five of the class's connect-time envelopes -- three create_role, two
--    create_channel -- died together on `403 Missing Permissions` when the bot was connected without
--    Manage Roles or Manage Channels. isBotPermissionProblem() classifies that as terminal, so they
--    dead-lettered at retry_count 0 rather than retrying. Once permissions were fixed, the three
--    roles came back and the two channels did not:
--
--      - request_discord_reinvite() repairs missing ROLES class-wide (the v_missing_roles phase
--        below) and has no channel equivalent, so the retry button rebuilt half the class.
--      - trigger_discord_create_roles_on_server_connect is AFTER UPDATE OF discord_server_id, so it
--        cannot re-fire for a guild that never changed.
--      - claim_discord_guild() on a same-guild refresh only clears the circuit breaker.
--
--    Nothing else enqueues them. The channels stayed missing until they were re-driven by hand, and
--    would have stayed missing all semester -- silently, because the enqueuers that post to them
--    read the channel back with a non-STRICT SELECT and simply find nothing.
--
--    Repair covers 'scheduling' and 'operations' only: exactly what the connect trigger creates.
--    'general' and 'regrades' are the other resource-less types, but they are created lazily by
--    their own enqueuers on first use, and eagerly creating them here would put channels in guilds
--    that never asked for one.
--
-- 2. add_member_role re-read a guild member the enqueuer had just read. processBatchRoleSync() calls
--    GET /guilds/{g}/members/{u} for every candidate, then enqueues an add_member_role whose handler
--    opened by calling the identical endpoint about a second later -- and the worker processes those
--    four-wide in parallel. Discord's per-route bucket for that endpoint is small, so the second wave
--    is where the 429s landed: `remaining: 0` with a sub-second reset, which is a route bucket and
--    not the global 50/s ceiling the shared limiter covers. Halving the traffic is the fix; the
--    limiter cannot see a per-route bucket.
--
--    enqueue_discord_role_sync() grows an optional p_membership_verified_at, stamped into the
--    envelope. The worker trusts it for a short TTL (MEMBERSHIP_HINT_TTL_MS) and otherwise looks the
--    member up as before, so every other caller -- the user_roles trigger, the interactions route,
--    a manual retry -- is unchanged.

-- Recreated rather than replaced: adding a defaulted parameter changes the signature, and leaving
-- the four-argument version in place would make every existing PERFORM ambiguous ("function is not
-- unique") rather than resolving to the new default.
DROP FUNCTION IF EXISTS public.enqueue_discord_role_sync(uuid, bigint, public.app_role, text);

CREATE FUNCTION public.enqueue_discord_role_sync(
  p_user_id uuid,
  p_class_id bigint,
  p_role public.app_role,
  p_action text DEFAULT 'add'::text,
  -- When the caller last saw this user in the guild. Only processBatchRoleSync passes it, and only
  -- immediately after a 200 from the member endpoint. NULL -- every other caller -- leaves the
  -- worker's own lookup exactly as it was.
  p_membership_verified_at timestamptz DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_guild_id text;
  v_discord_user_id text;
  v_discord_role_id text;
  v_class_slug text;
BEGIN
  -- Get Discord server info from class
  SELECT c.discord_server_id, c.slug
  INTO v_guild_id, v_class_slug
  FROM public.classes c
  WHERE c.id = p_class_id;

  -- Skip if no Discord server configured
  IF v_guild_id IS NULL THEN
    RETURN;
  END IF;

  -- Get user's Discord ID
  SELECT u.discord_id INTO v_discord_user_id
  FROM public.users u
  WHERE u.user_id = p_user_id;

  -- Skip if user doesn't have Discord linked
  IF v_discord_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Note: We don't check if user is in server here - the async worker will handle that
  -- and create an invite if needed. This allows the role sync to be queued even if
  -- the user isn't in the server yet.

  -- Get Discord role ID for this class and role type
  SELECT dr.discord_role_id INTO v_discord_role_id
  FROM public.discord_roles dr
  WHERE dr.class_id = p_class_id
    AND dr.role_type = p_role::text;

  -- Skip if role doesn't exist yet (will be created when server is connected)
  IF v_discord_role_id IS NULL THEN
    RETURN;
  END IF;

  -- Enqueue role add/remove operation
  IF p_action = 'add' THEN
    PERFORM pgmq_public.send(
      queue_name := 'discord_async_calls',
      message := jsonb_strip_nulls(
        jsonb_build_object(
          'method', 'add_member_role',
          'args', jsonb_build_object(
            'guild_id', v_guild_id,
            'user_id', v_discord_user_id,
            'role_id', v_discord_role_id
          ),
          'class_id', p_class_id,
          -- Stripped when NULL by the wrapper above, so an envelope from any other caller is byte
          -- for byte what it was before this migration.
          'membership_verified_at', to_char(
            p_membership_verified_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
          )
        )
      )
    );
  ELSIF p_action = 'remove' THEN
    -- No hint on this path. remove_member_role does not look the member up at all, so there is
    -- nothing for one to save.
    PERFORM pgmq_public.send(
      queue_name := 'discord_async_calls',
      message := jsonb_build_object(
        'method', 'remove_member_role',
        'args', jsonb_build_object(
          'guild_id', v_guild_id,
          'user_id', v_discord_user_id,
          'role_id', v_discord_role_id
        ),
        'class_id', p_class_id
      )
    );
  END IF;
END;
$function$
;

COMMENT ON FUNCTION public.enqueue_discord_role_sync(uuid, bigint, public.app_role, text, timestamptz) IS
  'Queue an add/remove of a class Discord role for one user. p_membership_verified_at lets a caller that has just confirmed the user is in the guild say so, which spares the worker an identical member lookup; leave it NULL and the worker checks for itself.';

REVOKE ALL ON FUNCTION public.enqueue_discord_role_sync(uuid, bigint, public.app_role, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_role_sync(uuid, bigint, public.app_role, text, timestamptz) TO service_role;

-- Recreated rather than replaced: the return type gains a column, which CREATE OR REPLACE cannot do.
DROP FUNCTION IF EXISTS public.request_discord_reinvite(bigint, uuid);

CREATE FUNCTION public.request_discord_reinvite(
  p_class_id bigint,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (queued integer, roles_repaired integer, channels_repaired integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_is_staff boolean;
  v_guild_id text;
  v_queued integer := 0;
  v_repaired integer := 0;
  v_channels_repaired integer := 0;
  v_missing_roles text[] := ARRAY[]::text[];
  v_role_type text;
  v_missing_channels text[] := ARRAY[]::text[];
  v_channel_type text;
  v_row record;
  -- Self-service daily budget, read and written only on the student path below.
  v_self_window timestamptz;
  v_self_count integer;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Access denied: authentication required';
  END IF;

  v_is_staff := public.authorizeforclassgrader(p_class_id::bigint);

  -- A student may retry their own membership -- that is the self-service half of the
  -- GitHub pattern, where the resend banner is rendered to the student themselves. Acting
  -- on anyone else, or on the whole class, is a staff action.
  IF NOT v_is_staff THEN
    IF p_user_id IS NULL OR p_user_id <> v_caller THEN
      RAISE EXCEPTION 'Access denied: must be a grader or instructor for this class';
    END IF;

    -- Passing your own id is not on its own a claim on this class. Without this an
    -- authenticated user could name any class id, satisfy the check above, and reach the
    -- role-repair phase below -- which scans the class independently of the membership loop
    -- and would enqueue create_role against a Discord server they have nothing to do with.
    IF NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.class_id = p_class_id AND ur.user_id = v_caller AND ur.disabled = false
    ) THEN
      RAISE EXCEPTION 'Access denied: no active enrollment in this class';
    END IF;
  END IF;

  SELECT c.discord_server_id INTO v_guild_id
  FROM public.classes c
  WHERE c.id = p_class_id;

  -- Nothing to retry against. Reported as zero rather than as an error: the caller is a
  -- button on a roster page, and a class with no Discord server is a configuration state,
  -- not a failure of this request.
  IF v_guild_id IS NULL THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;

  -- Serialize the whole retry per class, for the rest of this transaction.
  --
  -- Every phase below is read-then-write. The throttle predicate reads
  -- last_retry_requested_at and the loop body writes it, so two staff pressing the button at
  -- the same moment both saw an unthrottled row and both enqueued add_member_role for the
  -- same users. The worker handles those messages in parallel and creates a Discord invite
  -- per message before upserting the one tracking row, so the loser's invite stays live in
  -- Discord with no record of it -- the orphan-invite shape this branch has been removing
  -- everywhere else. A class-scoped lock is the right grain: this function is a per-class
  -- operation, and it also covers the role- and channel-repair phases further down.
  PERFORM pg_advisory_xact_lock(hashtext('discord_reinvite:' || p_class_id::text));

  -- A student's own retries are capped per day, on top of the five-minute throttle below.
  --
  -- The throttle alone bounds a held-down button, not a determined one: five minutes apart is 288
  -- presses a day, each of which costs a Discord member lookup and possibly an invite creation. That
  -- is a rate-limit problem the guild's other students then share, since Discord's limits are
  -- per-bot. A handful a day is all a student can act on -- the failures that survive more than one
  -- retry need an instructor, not another press.
  --
  -- Staff are exempt. A class-wide retry is the documented way out of a guild-level failure, and
  -- rationing it would leave a broken class unfixable.
  --
  -- Read before the loop rather than inside it, because the budget belongs to the caller, not to
  -- each row: the student path only ever touches its own row, and reading it here means the refusal
  -- happens before any work is queued.
  IF NOT v_is_staff THEN
    SELECT dms.self_retry_window_started_at, dms.self_retry_count
    INTO v_self_window, v_self_count
    FROM public.discord_membership_status dms
    WHERE dms.class_id = p_class_id
      AND dms.user_id = v_caller
      AND dms.guild_id = v_guild_id;

    -- A window older than a day is spent; the next press starts a fresh one. Rolling from the first
    -- press of the window rather than at a fixed hour, so the budget cannot be doubled by pressing
    -- either side of a midnight boundary.
    IF v_self_window IS NULL OR v_self_window < now() - INTERVAL '24 hours' THEN
      v_self_window := now();
      v_self_count := 0;
    END IF;

    IF COALESCE(v_self_count, 0) >= 5 THEN
      RAISE EXCEPTION
        'Discord role sync limit reached: this can be requested at most 5 times a day. If your roles are still missing, contact your instructors.'
        USING ERRCODE = '53400';
    END IF;
  END IF;

  FOR v_row IN
    SELECT ur.user_id, ur.role, dms.id AS status_id,
           EXISTS (
             SELECT 1 FROM public.discord_roles dr
             WHERE dr.class_id = p_class_id AND dr.role_type = ur.role::text
           ) AS role_exists
    FROM public.user_roles ur
    JOIN public.users u ON u.user_id = ur.user_id
    LEFT JOIN public.discord_membership_status dms
      ON dms.class_id = ur.class_id
     AND dms.user_id = ur.user_id
     AND dms.guild_id = v_guild_id
    WHERE ur.class_id = p_class_id
      AND ur.disabled = false
      -- Without a linked Discord account there is no member to look up and no invite that
      -- would reach anyone. enqueue_discord_role_sync would return silently; skipping here
      -- keeps the returned count honest.
      AND u.discord_id IS NOT NULL
      AND (p_user_id IS NULL OR ur.user_id = p_user_id)
      -- A class-wide retry targets everyone not recorded as being in the server, which
      -- includes users with no row at all. Requiring a row excluded exactly the students the
      -- sync has never reached -- and for a class outside the active-class window that is
      -- permanent, because the hourly batch will never create one, while the settings page
      -- reported there was nothing to queue. A retry aimed at a single user runs whatever
      -- their state is, including none, because that is the case it exists for.
      AND (p_user_id IS NOT NULL OR dms.id IS NULL OR dms.state <> 'in_guild')
      -- Throttle. The work this queues is one Discord member lookup plus, at most, an
      -- invite creation, so the window only has to stop a button being held down; it is
      -- not the five-day email throttle the GitHub resend banner needs.
      AND (dms.last_retry_requested_at IS NULL OR dms.last_retry_requested_at < now() - INTERVAL '5 minutes')
    -- Deterministic, so a class-wide retry that is interrupted repeats in the same order.
    ORDER BY ur.user_id
  LOOP
    -- The class's Discord role for this user's role type does not exist, so
    -- enqueue_discord_role_sync would return without queueing anything. Repair that first
    -- and leave the user un-stamped and uncounted: they are not throttled for a retry that
    -- never happened, and the count stays true.
    IF NOT v_row.role_exists THEN
      CONTINUE;
    END IF;

    -- No membership hint: this path has not looked the user up, which is the whole reason it is
    -- queueing the work.
    PERFORM public.enqueue_discord_role_sync(v_row.user_id, p_class_id, v_row.role, 'add');

    IF v_row.status_id IS NOT NULL THEN
      UPDATE public.discord_membership_status
      SET last_retry_requested_at = now()
      WHERE id = v_row.status_id;
    END IF;

    -- Deliberately no row is created for a user who has none. Seeding one meant choosing a state
    -- before anything had been observed, and `not_joined` is what the alerts read as "an invite is
    -- waiting on their dashboard, no action needed" -- false the moment it is written, and false
    -- indefinitely if the worker never gets there. The enum has no value for "queued, not yet
    -- checked", and inventing one would have to reach the roster column and its filter as well.
    --
    -- The cost is that such a user is not throttled until the worker records their first real
    -- outcome, about a minute later. Pressing again before then re-enqueues an add_member_role,
    -- which is idempotent at the Discord end and can no longer mint a duplicate invite now that
    -- claim_discord_invite() decides that centrally. A brief unthrottled window is the cheaper error
    -- than telling staff an invite exists when none does.

    v_queued := v_queued + 1;
  END LOOP;

  -- Spend a day's budget only when the press actually queued something. A press that queued nothing
  -- -- inside the five-minute throttle, already in_guild, or the class's roles missing -- cost no
  -- Discord work, so charging for it would let a student burn the day's allowance on presses that
  -- never reached Discord.
  --
  -- UPDATE, never INSERT. request_discord_reinvite deliberately creates no membership row (see the
  -- comment in the loop above), and that carries here: a student with no row yet is not counted,
  -- exactly as they are not throttled. The row is written when their invite is minted, about a
  -- minute later, so the uncounted window is small and self-closing.
  IF NOT v_is_staff AND v_queued > 0 THEN
    UPDATE public.discord_membership_status
    SET self_retry_window_started_at = v_self_window,
        self_retry_count = COALESCE(v_self_count, 0) + 1
    WHERE class_id = p_class_id
      AND user_id = v_caller
      AND guild_id = v_guild_id;
  END IF;

  -- Which of the class's Discord roles are missing, computed independently of anyone's
  -- membership state.
  --
  -- Deliberately not derived from the loop above. That loop only sees users who need a
  -- membership retry, so a class where role creation failed but everyone has since joined the
  -- server produced no candidates, no repair, and no way to ever create the role -- and the
  -- batch worker records in_guild even when enqueue_discord_role_sync silently finds no role,
  -- so nothing anywhere said the roles were missing.
  --
  -- Restricted to the role types discord_roles accepts. app_role also has 'admin', which
  -- discord_roles_role_type_check rejects, so enqueueing it would have Discord create a role
  -- the insert then refuses to track -- an orphan in the guild, re-created on every retry.
  -- Staff only, as a second boundary. Repair is class-wide work: it enqueues Discord mutations
  -- for a whole guild, which is not something a student's retry of their own membership should
  -- ever reach, whatever the enrollment check above concluded. A student in a class whose roles
  -- are missing gets queued 0 and repaired 0, which is accurate -- their retry cannot succeed
  -- until staff restore the roles.
  IF NOT v_is_staff THEN
    RETURN QUERY SELECT v_queued, 0, 0;
    RETURN;
  END IF;

  --
  -- All three supported types, not just the ones currently enrolled.
  -- trigger_sync_existing_users_on_role_creation only calls sync_existing_users_after_roles_created
  -- when COUNT(DISTINCT role_type) = 3, so repairing a class with no grader would create student and
  -- instructor, never reach three, and never fire the sync that assigns roles to the users already
  -- in the guild. Creating an unused role costs nothing -- the class-connect flow creates all three
  -- unconditionally -- and it is what makes the repair actually finish.
  SELECT COALESCE(array_agg(rt.role_type), ARRAY[]::text[])
  INTO v_missing_roles
  FROM unnest(ARRAY['student', 'grader', 'instructor']) AS rt(role_type)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.discord_roles dr
    WHERE dr.class_id = p_class_id AND dr.role_type = rt.role_type
  );

  -- Re-create them. The worker writes the discord_roles row when it succeeds, so the next
  -- press of the button finds the role and queues the users skipped above.
  FOREACH v_role_type IN ARRAY v_missing_roles LOOP
    -- Users are left un-stamped on the missing-role path, so nothing throttles a second press
    -- while the worker is still working. This is what stops that becoming a second Discord
    -- role: create_role is not idempotent at the Discord end -- it creates the role and only
    -- then inserts the row, while discord_roles allows one row per (class_id, role_type) -- so
    -- a duplicate leaves an untracked role in the guild that nothing refers to again.
    -- Concurrent callers are handled by the class-scoped lock taken above.
    IF EXISTS (
      SELECT 1
      FROM pgmq.q_discord_async_calls q
      WHERE q.message ->> 'method' = 'create_role'
        AND (q.message ->> 'class_id')::bigint = p_class_id
        AND q.message ->> 'role_type' = v_role_type
    ) THEN
      CONTINUE;
    END IF;

    PERFORM public.enqueue_discord_role_creation(p_class_id, v_role_type, v_guild_id);
    v_repaired := v_repaired + 1;
  END LOOP;

  -- The channel half of the same repair, and the reason this migration exists.
  --
  -- Exactly the two types trigger_discord_create_roles_on_server_connect creates. The other two
  -- resource-less types are deliberately excluded: 'general' and 'regrades' are created lazily by
  -- their own enqueuers the first time something needs to post to them, so a class that has never
  -- had a regrade request is *correctly* without a #regrades channel and creating one here would put
  -- an unused channel in every connected guild.
  --
  -- Resource-scoped channels -- per assignment, per lab section, per help queue -- are also out of
  -- scope. They are created by triggers on their own rows, there can be dozens of them, and a repair
  -- that enqueued the missing ones would turn one button press into an unbounded burst against the
  -- per-guild channel-creation limit. This restores the class-level channels the connect flow
  -- promises; the rest stay with the triggers that own them.
  SELECT COALESCE(array_agg(ct.channel_type), ARRAY[]::text[])
  INTO v_missing_channels
  FROM unnest(ARRAY['scheduling', 'operations']) AS ct(channel_type)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.discord_channels dc
    WHERE dc.class_id = p_class_id
      AND dc.channel_type = ct.channel_type::public.discord_channel_type
      -- resource_id IS NULL is what makes this a class-level channel; the unique constraint on
      -- (class_id, channel_type, resource_id) is NULLS NOT DISTINCT, so there is at most one.
      AND dc.resource_id IS NULL
  );

  FOREACH v_channel_type IN ARRAY v_missing_channels LOOP
    -- Same reasoning as the role loop: create_channel is not idempotent at the Discord end. It
    -- creates the channel and only then tries to store the row, and store_discord_channel_if_current
    -- reports the duplicate rather than preventing it -- by which point the extra channel is already
    -- in the guild, visible to students, and referenced by nothing. A press while the previous
    -- press's envelope is still queued must therefore enqueue nothing.
    IF EXISTS (
      SELECT 1
      FROM pgmq.q_discord_async_calls q
      WHERE q.message ->> 'method' = 'create_channel'
        AND (q.message ->> 'class_id')::bigint = p_class_id
        AND q.message ->> 'channel_type' = v_channel_type
    ) THEN
      CONTINUE;
    END IF;

    -- Name passed explicitly to match what the connect trigger sends, rather than relying on the
    -- enqueuer's default for these two types.
    PERFORM public.enqueue_discord_channel_creation(
      p_class_id,
      v_channel_type::public.discord_channel_type,
      NULL,
      v_channel_type,
      v_guild_id
    );
    v_channels_repaired := v_channels_repaired + 1;
  END LOOP;

  RETURN QUERY SELECT v_queued, v_repaired, v_channels_repaired;
END;
$$;

COMMENT ON FUNCTION public.request_discord_reinvite(bigint, uuid) IS
  'Re-queue the Discord membership check for one user, or for every user in the class not recorded as in_guild. The way out of a recorded cannot_invite once the underlying problem is fixed. A student retrying their own membership is capped at five a day on top of the five-minute throttle; staff are uncapped. Returns the number of users queued, the number of missing class Discord roles re-created, and the number of missing class-level channels (#scheduling, #operations) re-created.';

REVOKE ALL ON FUNCTION public.request_discord_reinvite(bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_discord_reinvite(bigint, uuid) TO authenticated, service_role;
