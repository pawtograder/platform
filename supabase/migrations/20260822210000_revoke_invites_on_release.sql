-- Revoke a class's outstanding Discord invites when it lets go of a guild.
--
-- clear_discord_tracking_for_class() drops every pointer the class holds INTO the guild -- roles,
-- channels, messages, and since 20260822200000 the discussion-topic channel id. It left the fifth
-- one alone: discord_invites. Those rows are not pointers, they are live capabilities. Invites are
-- minted with `max_age = 604800` and `max_uses = 5` (see createGuildInvite in
-- supabase/functions/_shared/DiscordWrapper.ts), and the partial uniqueness index from 20260822130000
-- is conditioned on `archived = false`, so a released guild is claimable by another course the
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
--   * The repair loop in 20260822160000 calls this function OUTSIDE any trigger, for classes already
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
-- to after a previous stint there. That case self-heals -- the AFTER trigger on server connect runs
-- enqueue_discord_invites_for_existing_users, which mints fresh invites for exactly the users whose
-- rows were just removed -- and the alternative, threading the incoming guild id through, would mean
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
END;
$$;

COMMENT ON FUNCTION public.clear_discord_tracking_for_class(bigint) IS
  'Drops every pointer a class holds into its Discord server -- the discord_roles / discord_channels / discord_messages rows and discussion_topics.discord_channel_id -- and revokes its outstanding invites, by enqueueing a delete_invite for each and then deleting the discord_invites rows. Shared by the server-change trigger, the archive trigger and the repair loops so they cannot drift. Does not touch discord_channel_group_id, which is a column on classes and must be assigned by a BEFORE trigger.';

REVOKE ALL ON FUNCTION public.clear_discord_tracking_for_class(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_discord_tracking_for_class(bigint) TO service_role;

-- Repair what every teardown before this migration left behind: invites into a guild their class no
-- longer uses. Same shape as the repair loop in 20260822160000, and the same reason for having one --
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
