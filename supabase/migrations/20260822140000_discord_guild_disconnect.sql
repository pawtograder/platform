-- Disconnecting a class from its Discord server.
--
-- 20260822130000 removed discord_server_id from the instructor-writable allow-list so that
-- claim_discord_guild() became its only writer. That closed the hijack hole, but it also removed the
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
