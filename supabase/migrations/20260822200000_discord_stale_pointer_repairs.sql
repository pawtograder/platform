-- Two repairs the review found in the claim and teardown paths.
--
-- 1. A guild move left discussion_topics.discord_channel_id pointing into the old server.
--
--    clear_discord_tracking_for_class() drops discord_roles, discord_channels and discord_messages,
--    but discussion_topics.discord_channel_id is a fourth pointer into the same guild and it survived.
--    enqueue_discord_discussion_thread_message() reads that column directly and enqueues a
--    send_message for it, and the worker's deliverability preflight leads on the class still having a
--    server configured -- which it does, the new one. So after a move, new threads and queued updates
--    kept posting course discussion content into the guild the class had left, which the partial
--    uniqueness index has already freed for another course to claim.
--
--    The preflight cannot fix this on its own: it deliberately does NOT require the channel to be in
--    discord_channels, because discussion channels never are -- an instructor types the id into the
--    topic. That is the right call for delivery, and it is exactly why the stale pointer has to be
--    cleared at the source instead.
--
-- 2. An open circuit breaker outlived the configuration that caused it. See the comment in
--    claim_discord_guild() below.

CREATE OR REPLACE FUNCTION public.clear_discord_tracking_for_class(p_class_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.discord_roles WHERE class_id = p_class_id;
  -- Channels matter more than roles: the message enqueuers select channel ids by class and type, so
  -- a stale row keeps posting course activity into a guild the class has left.
  DELETE FROM public.discord_channels WHERE class_id = p_class_id;
  -- Tracked messages name message ids inside those channels; an update would edit content in the old
  -- guild rather than posting fresh in the new one.
  DELETE FROM public.discord_messages WHERE class_id = p_class_id;
  -- The fourth pointer, and the one that was missed. Nulled rather than deleted, because the topic
  -- itself is course content that outlives any Discord server -- only its channel link is stale.
  UPDATE public.discussion_topics
  SET discord_channel_id = NULL
  WHERE class_id = p_class_id AND discord_channel_id IS NOT NULL;
END;
$$;

COMMENT ON FUNCTION public.clear_discord_tracking_for_class(bigint) IS
  'Drops every pointer a class holds into its Discord server: the discord_roles / discord_channels / discord_messages rows and discussion_topics.discord_channel_id. Shared by the server-change trigger and the archive trigger so the two cannot drift. Does not touch discord_channel_group_id, which is a column on classes and must be assigned by a BEFORE trigger.';

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
$function$
