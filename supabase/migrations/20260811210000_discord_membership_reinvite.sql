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
  'Re-queue the Discord membership check for one user, or for every user in the class not recorded as in_guild. The way out of a recorded cannot_invite once the underlying problem is fixed. Returns the number of users queued and the number of missing class Discord roles re-created.';

-- Named explicitly, not left to a PUBLIC-only revoke: Supabase grants EXECUTE to anon and
-- authenticated as their own ACL entries when the function is created, so revoking PUBLIC
-- removes nothing. anon must not reach a SECURITY DEFINER function that enqueues work.
-- authenticated keeps EXECUTE because the body authorizes its own caller.
REVOKE ALL ON FUNCTION public.request_discord_reinvite(bigint, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_discord_reinvite(bigint, uuid) TO authenticated, service_role;

-- ============================================================================
-- 3. Forget what was observed when the Discord account changes
-- ============================================================================

-- discord_membership_status is keyed on (class, user, guild) and records nothing about *which*
-- Discord account was checked, so a state observed for one account is silently reused for the next.
-- Unlinking only hides the row -- the instructor read filters on discord_id IS NOT NULL -- so linking
-- a different account brings the old row back: a stale in_guild then excludes that user from
-- class-wide retries as already in the server, permanently for a class outside the active sync
-- window, because nothing else will ever rewrite the row.
--
-- Deleting on any change of discord_id is the smaller fix than widening the key. The row is a cache
-- of one observation, the next sync re-observes within the hour for an active class, and a manual
-- retry covers the rest. It also clears the rows a plain unlink leaves behind.
CREATE OR REPLACE FUNCTION public.clear_discord_membership_status_on_identity_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.discord_membership_status WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.clear_discord_membership_status_on_identity_change() IS
  'Drops a user''s recorded Discord membership when their linked account changes, so an observation of one Discord account is never reused for another.';

DROP TRIGGER IF EXISTS clear_discord_membership_status_on_identity_change ON public.users;
CREATE TRIGGER clear_discord_membership_status_on_identity_change
AFTER UPDATE OF discord_id ON public.users
FOR EACH ROW
WHEN (NEW.discord_id IS DISTINCT FROM OLD.discord_id)
EXECUTE FUNCTION public.clear_discord_membership_status_on_identity_change();

-- ============================================================================
-- 3a. Fire the existing-user sync once a class's roles are all present
-- ============================================================================

-- trigger_sync_existing_users_on_role_creation counts the three role types inside the same
-- transaction as the INSERT that fired it, and processBatch runs up to four create_role envelopes in
-- parallel. Concurrent inserts cannot see each other, so all three triggers can count fewer than
-- three, none of them calls sync_existing_users_after_roles_created, and no later insert ever fires
-- it again -- the roles exist and nobody is assigned to them, which is the state the repair is
-- supposed to end.
--
-- Called by the worker after its tracking row is committed, so this sees the siblings the trigger
-- could not. Whichever worker finishes last observes three and fires the sync. More than one may
-- observe three and fire it twice; that costs a duplicate enqueue, and add_member_role is idempotent
-- at the Discord end, which is the cheaper end of the trade against never firing at all.
CREATE OR REPLACE FUNCTION public.sync_discord_users_if_roles_complete(p_class_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role_count integer;
BEGIN
  SELECT COUNT(DISTINCT dr.role_type) INTO v_role_count
  FROM public.discord_roles dr
  WHERE dr.class_id = p_class_id
    AND dr.role_type IN ('student', 'grader', 'instructor');

  IF v_role_count < 3 THEN
    RETURN false;
  END IF;

  PERFORM public.sync_existing_users_after_roles_created(p_class_id);
  RETURN true;
END;
$$;

COMMENT ON FUNCTION public.sync_discord_users_if_roles_complete(bigint) IS
  'Runs the existing-user Discord sync once all three class roles exist. Called after a create_role worker commits, because the insert trigger counts inside its own transaction and concurrent creations cannot see each other.';

REVOKE ALL ON FUNCTION public.sync_discord_users_if_roles_complete(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_discord_users_if_roles_complete(bigint) TO service_role;

-- ============================================================================
-- 3b. Claim the one invite slot per (user, class, guild)
-- ============================================================================

-- Store a freshly created Discord invite, but only if it is still needed, and report which invite
-- the student will actually be given.
--
-- discord_invites holds one row per (user_id, class_id, guild_id) and every invite is created with
-- `unique: true`, so two workers creating invites for the same user produce two live Discord invites
-- and one row. Read-then-write cannot prevent that: processBatch runs up to four envelopes in
-- parallel, an hourly batch_role_sync and an add_member_role envelope can reach the same absent user
-- at once, and the retry RPC's advisory lock covers the enqueue, not the worker. Both saw no
-- outstanding invite, both created one, and the later upsert replaced the earlier URL -- leaving the
-- first invite live in Discord with nothing pointing at it, and the student holding a link that had
-- been quietly swapped.
--
-- The conditional upsert is why this is a function rather than a PostgREST call: the row must be
-- replaced when the invite it names is used or expired, and left alone when it is still good, which
-- `.upsert()` cannot express. Returning the winning URL lets a caller that lost revoke the invite it
-- just created and hand the student the one that was already stored.
CREATE OR REPLACE FUNCTION public.claim_discord_invite(
  p_user_id uuid,
  p_class_id bigint,
  p_guild_id text,
  p_invite_code text,
  p_invite_url text,
  p_expires_at timestamptz
)
RETURNS TABLE (winning_invite_url text, claimed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
BEGIN
  INSERT INTO public.discord_invites AS di (user_id, class_id, guild_id, invite_code, invite_url, expires_at, used)
  VALUES (p_user_id, p_class_id, p_guild_id, p_invite_code, p_invite_url, p_expires_at, false)
  ON CONFLICT (user_id, class_id, guild_id) DO UPDATE
  SET invite_code = excluded.invite_code,
      invite_url = excluded.invite_url,
      expires_at = excluded.expires_at,
      used = false
  -- Only when what is already there cannot be used. A live invite belongs to whichever worker got
  -- here first and must not be swapped out from under the student.
  WHERE di.used = true OR di.expires_at <= now()
  RETURNING di.invite_url INTO v_url;

  IF v_url IS NOT NULL THEN
    RETURN QUERY SELECT v_url, true;
    RETURN;
  END IF;

  -- The DO UPDATE was filtered out, so a usable invite is already stored. Hand its URL back.
  SELECT di.invite_url INTO v_url
  FROM public.discord_invites di
  WHERE di.user_id = p_user_id AND di.class_id = p_class_id AND di.guild_id = p_guild_id;

  RETURN QUERY SELECT v_url, false;
END;
$$;

COMMENT ON FUNCTION public.claim_discord_invite(uuid, bigint, text, text, text, timestamptz) IS
  'Atomically store a new Discord invite unless a usable one is already recorded. Returns the URL the student will be given and whether this caller''s invite won, so a loser can revoke the invite it created rather than leaving it live and untracked.';

REVOKE ALL ON FUNCTION public.claim_discord_invite(uuid, bigint, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_discord_invite(uuid, bigint, text, text, text, timestamptz) TO service_role;

-- ============================================================================
-- 4. Refuse a write from a Discord account that is no longer linked
-- ============================================================================

-- The trigger above closes the case where the account changes and nothing rewrites the row. It does
-- not close the ordering window: a worker reads discord_id, does its Discord call, and by the time
-- it records the outcome the user may have relinked. The trigger has already deleted the old rows,
-- so the in-flight write recreates one describing an account nobody uses -- an `in_guild` for the
-- old account then excludes the new one from class-wide retries, indefinitely for an inactive class.
--
-- The write now carries the account it observed and is dropped unless that is still the linked one.
-- Nullable, and skipped when null, so a caller that does not know the account keeps the old
-- behaviour rather than having its write silently discarded.
ALTER TABLE public.discord_membership_status
  ADD COLUMN IF NOT EXISTS observed_discord_id text;

COMMENT ON COLUMN public.discord_membership_status.observed_discord_id IS
  'The Discord account this observation was made against. Compared with users.discord_id on write so a result captured before a relink cannot describe the account that replaced it.';

CREATE OR REPLACE FUNCTION public.record_discord_membership_status(
  p_class_id bigint,
  p_user_id uuid,
  p_guild_id text,
  p_state public.discord_membership_state,
  -- Ahead of the optional pair, because a parameter with no default cannot follow one that has it.
  p_observed_discord_id text,
  p_discord_error_code integer DEFAULT NULL,
  p_detail text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_current_discord_id text;
BEGIN
  -- Required, with no default. A default would let a six-argument call from a worker that has not
  -- been redeployed bind to this function and write with no identity check at all, which is exactly
  -- the silent path dropping the old overload was meant to remove. Without one, such a call finds no
  -- matching function and fails, which is the intended boundary during a rollout.
  IF p_observed_discord_id IS NULL THEN
    RAISE EXCEPTION 'record_discord_membership_status requires the observed Discord account';
  END IF;

  -- FOR UPDATE, so an identity change cannot commit between this read and the upsert below. Without
  -- the lock the comparison could still see the old account, the relink and its trigger could delete
  -- the rows, and this statement would then recreate the stale one after the cleanup had run --
  -- leaving exactly the row the check exists to prevent. Holding the lock makes the relink wait: it
  -- proceeds after this transaction commits, and its trigger then clears what was written here.
  SELECT u.discord_id INTO v_current_discord_id
  FROM public.users u
  WHERE u.user_id = p_user_id
  FOR UPDATE;

  -- Superseded. Discarded rather than raised: the caller has already completed its Discord work
  -- and cannot undo it, and the account it was about is no longer the user's, so there is nothing
  -- to record and nothing for it to do about the failure.
  IF v_current_discord_id IS DISTINCT FROM p_observed_discord_id THEN
    RAISE NOTICE 'Discarding Discord membership status for user % : observed account % is no longer linked',
      p_user_id, p_observed_discord_id;
    RETURN;
  END IF;

  INSERT INTO public.discord_membership_status AS dms (
    class_id, user_id, guild_id, state, discord_error_code, detail, observed_discord_id
  )
  VALUES (p_class_id, p_user_id, p_guild_id, p_state, p_discord_error_code, p_detail, p_observed_discord_id)
  ON CONFLICT (class_id, user_id, guild_id) DO UPDATE
  SET state = excluded.state,
      discord_error_code = excluded.discord_error_code,
      detail = excluded.detail,
      observed_discord_id = excluded.observed_discord_id,
      last_observed_at = now(),
      -- Reset the count when the state changes so observed_count always describes
      -- the current state rather than the history of the row.
      observed_count = CASE WHEN dms.state = excluded.state THEN dms.observed_count + 1 ELSE 1 END,
      first_observed_at = CASE WHEN dms.state = excluded.state THEN dms.first_observed_at ELSE now() END;
END;
$$;

REVOKE ALL ON FUNCTION public.record_discord_membership_status(bigint, uuid, text, public.discord_membership_state, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_discord_membership_status(bigint, uuid, text, public.discord_membership_state, text, integer, text) TO service_role;

-- The six-argument form is superseded. Dropped rather than left in place, so a caller that has not
-- been updated fails loudly instead of silently writing rows with no account recorded against them.
DROP FUNCTION IF EXISTS public.record_discord_membership_status(bigint, uuid, text, public.discord_membership_state, integer, text);

-- ============================================================================
-- 5. Surface the retry timestamp to the roster
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

-- ============================================================================
-- 7. Student Discord invitations are opt-in per course
-- ============================================================================

-- Whether this course lets students join its Discord server.
--
-- Mirrors courseFeatureEnabled() in lib/courseFeatures.ts: classes.features is a bare jsonb array of
-- {name, enabled}, with no default and no CHECK, so a missing entry means the feature's own default
-- and a non-array value means no entries at all. This one defaults OFF -- before the dashboard panel
-- existed there was no student-facing route to an invitation, so defaulting on would newly invite
-- every student of every course that happens to have a server configured.
CREATE OR REPLACE FUNCTION public.discord_student_join_enabled(p_class_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      -- jsonb_typeof, not a cast. classes.features is unconstrained jsonb, so an entry like
      -- {"name":"discord-student-join","enabled":"unknown"} is permitted -- and `->> 'enabled'`
      -- followed by ::boolean would raise on it, aborting this function inside the hourly candidate
      -- query and stopping Discord sync for every course in the run. Anything that is not a JSON
      -- boolean falls through to the feature default instead.
      SELECT CASE WHEN jsonb_typeof(f -> 'enabled') = 'boolean' THEN (f -> 'enabled')::boolean END
      FROM public.classes c,
           LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(c.features) = 'array' THEN c.features ELSE '[]'::jsonb END
           ) AS f
      WHERE c.id = p_class_id
        AND f ->> 'name' = 'discord-student-join'
      LIMIT 1
    ),
    false
  );
$$;

COMMENT ON FUNCTION public.discord_student_join_enabled(bigint) IS
  'True when a course has opted in to student Discord invitations. Defaults false. The worker checks this before creating an invite, so a course that has not opted in produces none.';

REVOKE ALL ON FUNCTION public.discord_student_join_enabled(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.discord_student_join_enabled(bigint) TO authenticated, service_role;

-- The candidate query carries the flag, so the worker does not need a query per class. Dropped
-- first because adding a column changes the return type.
DROP FUNCTION IF EXISTS public.get_discord_role_sync_candidates();

CREATE OR REPLACE FUNCTION public.get_discord_role_sync_candidates()
RETURNS TABLE (
  user_id uuid,
  class_id bigint,
  -- The enum, not text: the worker feeds this straight back into
  -- enqueue_discord_role_sync(), which takes an app_role.
  role public.app_role,
  discord_id text,
  discord_server_id text,
  -- When false the worker still checks membership and syncs roles for students who are already in
  -- the server; it just does not create an invitation for the ones who are not.
  student_join_enabled boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    ur.user_id,
    c.id AS class_id,
    ur.role,
    u.discord_id,
    c.discord_server_id,
    public.discord_student_join_enabled(c.id) AS student_join_enabled
  FROM public.user_roles ur
  JOIN public.classes c ON c.id = ur.class_id
  JOIN public.users u ON u.user_id = ur.user_id
  WHERE ur.disabled = false
    AND u.discord_id IS NOT NULL
    AND c.discord_server_id IS NOT NULL
    AND public.is_class_active(c.archived, c.end_date);
$$;

COMMENT ON FUNCTION public.get_discord_role_sync_candidates() IS
  'User-role records eligible for Discord role sync, scoped to active classes, with whether each class has opted in to student invitations.';

REVOKE ALL ON FUNCTION public.get_discord_role_sync_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_discord_role_sync_candidates() TO service_role;

-- ============================================================================
-- 8. Forget a class's Discord roles when it changes server
-- ============================================================================

-- discord_roles has no guild column, so a row created for guild A stays valid-looking after a class
-- moves to guild B. trigger_discord_create_roles_on_server_connect skips creation whenever any role
-- row exists for the class, so nothing replaces them, and enqueue_discord_role_sync goes on pairing
-- guild A's role ids with guild B -- every add_member_role failing with Unknown Role. The repair in
-- request_discord_reinvite cannot help either: it looks for *missing* rows, and these are present.
--
-- BEFORE, so it runs ahead of the AFTER trigger that creates them: that trigger then finds no rows
-- and enqueues a fresh set for the new guild. Trigger execution order is otherwise alphabetical by
-- name, which is not something to rely on for correctness.
CREATE OR REPLACE FUNCTION public.clear_discord_roles_on_server_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.discord_roles WHERE class_id = NEW.id;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.clear_discord_roles_on_server_change() IS
  'Drops a class''s tracked Discord roles when its server changes, so role ids from the previous guild are not reused against the new one. discord_roles has no guild key, so the rows are otherwise indistinguishable from current ones.';

DROP TRIGGER IF EXISTS clear_discord_roles_on_server_change ON public.classes;
CREATE TRIGGER clear_discord_roles_on_server_change
BEFORE UPDATE OF discord_server_id ON public.classes
FOR EACH ROW
WHEN (NEW.discord_server_id IS DISTINCT FROM OLD.discord_server_id)
EXECUTE FUNCTION public.clear_discord_roles_on_server_change();
