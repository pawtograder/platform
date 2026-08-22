-- A guild claim must refuse an archived class.
--
-- 20260822130000 gates claim_discord_guild() on the claimant being an instructor of the class (or a
-- platform admin) and on no other *unarchived* class holding the guild. Neither of those, nor
-- isInstructorOfClass() in the install route, says anything about the state of the class doing the
-- claiming -- so an archived class could still connect a Discord server, and two separate mechanisms
-- from that same migration set then made it a cross-course problem rather than a tidiness one:
--
--   * The uniqueness index is partial on `COALESCE(archived, false) = false`. An archived class is
--     outside it, so an archived class and a live one can name the same guild at the same time, and
--     the live course's role sync, channel creation and message tracking share a server with a
--     course that is supposed to be finished. That is the exact collision the index exists to stop.
--   * release_discord_server_on_archive() (20260822150000) fires only on the false -> true
--     transition of `archived`. It cannot undo a claim made *after* archiving, so the stale link is
--     permanent until somebody disconnects by hand -- and 20260822150000's own reasoning is that a
--     stale link is dangerous precisely because paths like the slash-command resolver in
--     app/api/discord/interactions/route.ts match on `discord_server_id` with no archived filter.
--
-- The fix belongs here rather than in the route: this function is the sole writer of
-- discord_server_id, and "released on archive" and "cannot be re-acquired while archived" are two
-- halves of one invariant. A check in the route would leave the RPC able to reintroduce the state
-- the trigger just cleared.
--
-- 20260822130000 is already applied on deployments, so this is a CREATE OR REPLACE here rather than
-- an edit there. The body below is that migration's, unchanged except for the archived guard and the
-- one extra column the guard needs from the locking SELECT.

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
  -- `archived` alone, not is_class_active(archived, end_date), for the reason 20260822130000 gives
  -- for the index: `archived` is the condition the uniqueness index enforces, and a guard stricter
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
  'Records that a class controls a Discord guild, after the install callback has confirmed the bot is in it. The only writer of classes.discord_server_id: instructor UPDATEs can no longer touch that column. Raises DISCORD_GUILD_ALREADY_CLAIMED (SQLSTATE 23505) when another unarchived class holds the guild, DISCORD_CLAIM_CLASS_ARCHIVED (SQLSTATE 55000) when the claiming class is archived -- archiving releases the guild for another course, so an archived class must not be able to take one -- DISCORD_CLAIM_FORBIDDEN when the claimant is not staff, DISCORD_CLAIM_CLASS_NOT_FOUND when the class does not exist, and DISCORD_CLAIM_INVALID for a malformed guild id.';

-- CREATE OR REPLACE preserves the ACL, so the grants from 20260822130000 still stand. Restated
-- anyway: this function is the only writer of discord_server_id, and a future refactor that has to
-- DROP and recreate it must not silently hand it back to anon and authenticated.
REVOKE ALL ON FUNCTION public.claim_discord_guild(bigint, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_discord_guild(bigint, text, uuid) TO service_role;
