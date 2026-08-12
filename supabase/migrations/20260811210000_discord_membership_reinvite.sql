-- Discord membership: give a recorded failure a way back.
--
-- The previous migration stopped retrying membership operations that cannot succeed, and
-- recorded the outcome in discord_membership_status so an instructor can see who is stuck
-- and why. That is the right half of the trade, but it left no way out: once a student is
-- recorded cannot_invite, the only thing that can clear the row is the hourly batch sync,
-- and for a class past its end date that sync no longer runs at all. An instructor who
-- fixes the bot's permissions had no way to say "try again now".
--
-- GitHub solves the same problem with a human-triggered re-invite: the student banner in
-- components/github/resend-org-invitation.tsx and the instructor buttons on the
-- repositories and enrollments pages all funnel into reinviteToOrgTeam(). Discord had no
-- equivalent -- SyncRolesButton and the /sync-roles slash command act only on the caller's
-- own roles, so an instructor could see a stuck student and do nothing about it.
--
-- This migration adds that step. It deliberately does not perform Discord calls itself:
-- re-enqueueing add_member_role re-runs the membership check, mints a fresh invite when
-- one is needed, and records the result -- including in_guild on success, which clears the
-- stuck row. The retry is therefore the existing path, triggered on demand.

-- ============================================================================
-- 1. When a human last asked for a retry
-- ============================================================================

-- Distinct from last_observed_at, which the batch sync stamps on every pass. This column
-- only moves when a person presses the button, which is what the throttle and the UI's
-- "requested a moment ago" state both need to know.
ALTER TABLE public.discord_membership_status
  ADD COLUMN IF NOT EXISTS last_retry_requested_at timestamptz;

COMMENT ON COLUMN public.discord_membership_status.last_retry_requested_at IS
  'When a human last requested a membership retry for this row, via request_discord_reinvite(). Null means never. Used to throttle the button and to show that a retry is already in flight.';

-- ============================================================================
-- 2. The re-invite step
-- ============================================================================

-- Re-queue the Discord membership check for one user, or for every user in the class who
-- is not currently recorded as being in the server.
--
-- Returns how many users were queued and how many missing Discord roles were re-created,
-- so the caller can report what happened rather than claiming success it cannot see. Zero
-- queued is a legitimate result: everyone eligible was either already in the server or
-- inside the throttle window.
--
-- The roles_repaired half exists because enqueue_discord_role_sync() returns silently when
-- the class has no discord_roles row for a user's role type, which is the state a class is
-- left in when its create_role operation failed terminally. Without the repair this
-- function would report "queued 12 students" and enqueue nothing at all, permanently, for
-- exactly the classes in the worst shape.
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
    ELSE
      -- No row yet -- a user who has never been checked, reachable only through the
      -- single-user branch above. Recording the request now means the throttle applies to
      -- them too, instead of the button being unlimited for exactly the users whose state
      -- is unknown. state is seeded to not_joined because that is what a pending check
      -- means to a reader; the worker overwrites it with the real answer within the minute.
      INSERT INTO public.discord_membership_status (class_id, user_id, guild_id, state, detail, last_retry_requested_at)
      VALUES (p_class_id, v_row.user_id, v_guild_id, 'not_joined', 'Membership retry requested; awaiting the next sync.', now())
      ON CONFLICT (class_id, user_id, guild_id) DO UPDATE
      SET last_retry_requested_at = now();
    END IF;

    v_queued := v_queued + 1;
  END LOOP;

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

  SELECT COALESCE(array_agg(DISTINCT ur.role::text), ARRAY[]::text[])
  INTO v_missing_roles
  FROM public.user_roles ur
  WHERE ur.class_id = p_class_id
    AND ur.disabled = false
    AND ur.role::text IN ('student', 'grader', 'instructor')
    AND NOT EXISTS (
      SELECT 1 FROM public.discord_roles dr
      WHERE dr.class_id = p_class_id AND dr.role_type = ur.role::text
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
  'Re-queue the Discord membership check for one user, or for every user in the class not recorded as in_guild. The way out of a recorded cannot_invite once the underlying problem is fixed. Returns the number of users queued and the number of missing class Discord roles re-created.';

-- Named explicitly, not left to a PUBLIC-only revoke: Supabase grants EXECUTE to anon and
-- authenticated as their own ACL entries when the function is created, so revoking PUBLIC
-- removes nothing. anon must not reach a SECURITY DEFINER function that enqueues work.
-- authenticated keeps EXECUTE because the body authorizes its own caller.
REVOKE ALL ON FUNCTION public.request_discord_reinvite(bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_discord_reinvite(bigint, uuid) TO authenticated, service_role;

-- ============================================================================
-- 3. Surface the retry timestamp to the roster
-- ============================================================================

-- Unchanged except for the added last_retry_requested_at column, which the UI uses to
-- disable the button inside the throttle window rather than letting the instructor press
-- it and get a silent zero back.
--
-- Dropped first because adding a column to a RETURNS TABLE changes the function's return
-- type, which CREATE OR REPLACE refuses. Nothing in the database depends on it -- the only
-- callers are the frontend hook and this file -- so there is no dependent object to lose.
DROP FUNCTION IF EXISTS public.get_discord_membership_status_for_class(bigint);

CREATE OR REPLACE FUNCTION public.get_discord_membership_status_for_class(p_class_id bigint)
RETURNS TABLE (
  user_id uuid,
  name text,
  sortable_name text,
  email text,
  discord_username text,
  state public.discord_membership_state,
  discord_error_code integer,
  detail text,
  last_observed_at timestamptz,
  last_retry_requested_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.authorizeforclassgrader(p_class_id::bigint) THEN
    RAISE EXCEPTION 'Access denied: must be a grader or instructor for this class';
  END IF;

  RETURN QUERY
  SELECT
    dms.user_id,
    p.name,
    p.sortable_name,
    u.email,
    u.discord_username,
    dms.state,
    dms.discord_error_code,
    dms.detail,
    dms.last_observed_at,
    dms.last_retry_requested_at
  FROM public.discord_membership_status dms
  -- Linked accounts only, matching get_discord_role_sync_candidates(). A user who unlinks
  -- Discord drops out of the candidate query, so their last recorded state can never be
  -- refreshed or cleared -- and nothing deletes the row. Without this filter the alerts kept
  -- naming them as having an invite waiting, on the same page where the roster column
  -- correctly reads "Not linked" from users.discord_id, so the two contradicted each other.
  JOIN public.users u ON u.user_id = dms.user_id AND u.discord_id IS NOT NULL
  -- Restricted to the class's *current* server. The status table is keyed on guild_id, so
  -- changing discord_server_id leaves the old guild's rows behind; without this join an
  -- instructor would keep seeing failures from a server the class no longer uses, and two
  -- rows for one student would race to define their state.
  JOIN public.classes c ON c.id = dms.class_id AND c.discord_server_id = dms.guild_id
  -- An active enrollment is required, not merely preferred. get_discord_role_sync_candidates()
  -- skips disabled roles, so once a student drops, their last recorded status is never refreshed
  -- again -- a LEFT JOIN would list them as still needing Discord access forever, and with a null
  -- profile the roster would fall back to showing their email. LATERAL with LIMIT 1 so a user
  -- holding more than one active role in the class cannot duplicate their row.
  JOIN LATERAL (
    SELECT ur.private_profile_id
    FROM public.user_roles ur
    WHERE ur.user_id = dms.user_id
      AND ur.class_id = dms.class_id
      AND ur.disabled = false
    LIMIT 1
  ) ur ON true
  LEFT JOIN public.profiles p ON p.id = ur.private_profile_id
  WHERE dms.class_id = p_class_id
  -- The enum is ordered by how much attention the state needs, so DESC puts cannot_invite
  -- first. in_guild rows are returned too: the roster has to tell "checked, and they are in"
  -- apart from "never checked", and only the presence of a row distinguishes them.
  ORDER BY dms.state DESC, p.sortable_name NULLS LAST;
END;
$$;

COMMENT ON FUNCTION public.get_discord_membership_status_for_class(bigint) IS
  'Where each checked student in a class stands with its Discord server, and why. Drives the roster-page surface for what used to be an invisible queue failure.';

REVOKE ALL ON FUNCTION public.get_discord_membership_status_for_class(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_discord_membership_status_for_class(bigint) TO authenticated, service_role;
