-- Cap a student's self-service Discord role-sync retries at five a day.
--
-- request_discord_reinvite already throttles to one retry per user per five minutes, which bounds a
-- button being held down. It does not bound a button being pressed all afternoon: five minutes apart
-- is 288 presses a day, and each one costs a Discord member lookup and possibly an invite creation.
-- Discord's rate limits are per-bot, so that budget is not spent against the pressing student alone
-- -- it is spent against every class the deployment serves.
--
-- Five a day is the shape of the thing being retried. A student's retry fixes exactly one situation:
-- the worker has not yet noticed they joined. If five spread over a day have not fixed it, the cause
-- is one they cannot fix -- the bot missing Manage Roles, its role below the class roles, a class
-- whose Discord roles were never created -- and the answer is an instructor, not another press.
--
-- Staff are exempt. A class-wide retry is the documented way out of a guild-level failure, and
-- rationing it would leave a broken class unfixable.

ALTER TABLE public.discord_membership_status
  ADD COLUMN IF NOT EXISTS self_retry_window_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS self_retry_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.discord_membership_status.self_retry_window_started_at IS
  'Start of the rolling 24h window for this user''s own retries of this membership. Rolls from the first press of a window rather than a fixed hour, so the budget cannot be doubled across a midnight boundary. Null until they press once. Staff retries do not touch it.';

COMMENT ON COLUMN public.discord_membership_status.self_retry_count IS
  'Retries the user has spent in the window above. Incremented only when a press actually queued work, so presses rejected by the five-minute throttle cost nothing.';

-- Recreated with the cap. Everything else is unchanged from
-- 20260811210000_discord_membership_reinvite.sql.
CREATE OR REPLACE FUNCTION public.request_discord_reinvite(
  p_class_id bigint,
  p_user_id uuid DEFAULT NULL
)
RETURNS TABLE (queued integer, roles_repaired integer)
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
  v_missing_roles text[] := ARRAY[]::text[];
  v_role_type text;
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
    RETURN QUERY SELECT 0, 0;
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
  -- operation, and it also covers the role-repair phase further down.
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
    RETURN QUERY SELECT v_queued, 0;
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

  RETURN QUERY SELECT v_queued, v_repaired;
END;
$$;
COMMENT ON FUNCTION public.request_discord_reinvite(bigint, uuid) IS
  'Re-queue the Discord membership check for one user, or for every user in the class not recorded as in_guild. The way out of a recorded cannot_invite once the underlying problem is fixed. A student retrying their own membership is capped at five a day on top of the five-minute throttle; staff are uncapped. Returns the number of users queued and the number of missing class Discord roles re-created.';

REVOKE ALL ON FUNCTION public.request_discord_reinvite(bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_discord_reinvite(bigint, uuid) TO authenticated, service_role;
