-- Make channel tracking conditional on the class still being on the guild the channel was created in.
--
-- 20260822170000 added a preflight to the `create_channel` handler, so a queued envelope for a guild
-- the class has left is dropped before any Discord call. That closes the queued-envelope window --
-- seconds to minutes -- but not the window across the call itself: if a move, disconnect or archive
-- commits while `createChannel()` is in flight, the teardown deletes the class's tracking rows and the
-- handler then inserts the freshly created channel unconditionally.
--
-- The resulting row is not a transient inconsistency, it is durable and wrong. The message enqueuers
-- select channel ids by class and type, so a resurrected row keeps sending course activity into the
-- server the class left -- possibly one another course has since claimed. Worse, for a resource-scoped
-- channel it can win the uniqueness race and stop the NEW guild's channel from being tracked at all,
-- so the class ends up permanently pointed at the wrong server for that resource.
--
-- This is the channel counterpart of store_discord_role_if_current (20251213194246), and it exists for
-- the same reason: the check and the write have to happen in one transaction that a concurrent server
-- change cannot interleave with.

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
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN QUERY SELECT v_inserted, false;
END;
$$;

COMMENT ON FUNCTION public.store_discord_channel_if_current(bigint, public.discord_channel_type, text, text, bigint) IS
  'Records a created Discord channel only if the class is still on the guild it was created in. The channel counterpart of store_discord_role_if_current: closes the window across the createChannel() call, where a concurrent move, disconnect or archive would otherwise have its teardown undone by an unconditional insert.';

REVOKE ALL ON FUNCTION public.store_discord_channel_if_current(bigint, public.discord_channel_type, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_discord_channel_if_current(bigint, public.discord_channel_type, text, text, bigint)
  TO service_role;
