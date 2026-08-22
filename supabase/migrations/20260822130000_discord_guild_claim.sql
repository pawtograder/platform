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

-- ============================================================================
-- 3. The claim
-- ============================================================================

-- Record that a class controls a Discord guild.
--
-- Called only from the install callback, which has already (a) verified the signed state it minted,
-- (b) re-checked that the caller is still an instructor of the class, and (c) confirmed with the bot
-- token that the bot can see the guild. This function is the transactional half: it serialises
-- concurrent claims on the class row, refuses a guild another live class holds, and stamps who and
-- when.
--
-- p_claimed_by is a parameter rather than auth.uid() because the only grantee is service_role, and a
-- service-role call carries no user. It is verified, not merely stored: this is now the sole writer
-- of discord_server_id, so a second authorization check here costs one index lookup and means a
-- bug in the route cannot connect a server on behalf of somebody who is not staff of the class.
CREATE OR REPLACE FUNCTION public.claim_discord_guild(
  p_class_id bigint,
  p_guild_id text,
  p_claimed_by uuid DEFAULT NULL
)
RETURNS TABLE (
  class_id bigint,
  guild_id text,
  claimed_by uuid,
  claimed_at timestamptz,
  -- The guild the class was on before, so the caller can tell a fresh connection from a move and
  -- report the teardown that a move triggers.
  previous_guild_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_guild text := btrim(COALESCE(p_guild_id, ''));
  v_claimant uuid := COALESCE(p_claimed_by, auth.uid());
  v_previous text;
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
  SELECT c.discord_server_id
  INTO v_previous
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
$$;

COMMENT ON FUNCTION public.claim_discord_guild(bigint, text, uuid) IS
  'Records that a class controls a Discord guild, after the install callback has confirmed the bot is in it. The only writer of classes.discord_server_id: instructor UPDATEs can no longer touch that column. Raises DISCORD_GUILD_ALREADY_CLAIMED (SQLSTATE 23505) when another unarchived class holds the guild, DISCORD_CLAIM_FORBIDDEN when the claimant is not staff, and DISCORD_CLAIM_INVALID for a malformed guild id.';

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
