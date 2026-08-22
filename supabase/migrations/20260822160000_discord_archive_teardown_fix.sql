-- Make the archive path actually tear down, instead of assuming a trigger fired.
--
-- 20260822150000 cleared `discord_server_id` when a class is archived, on the assumption that
-- assigning to NEW.discord_server_id inside a BEFORE trigger would in turn fire
-- clear_discord_roles_on_server_change (declared `BEFORE UPDATE OF discord_server_id`). It does not.
-- PostgreSQL decides which `UPDATE OF <column>` triggers to schedule from the column list of the
-- UPDATE *statement*, not from which columns a trigger later modifies. `admin_delete_class` archives
-- with `UPDATE classes SET archived = ...`, which names only `archived`, so the teardown never ran.
--
-- Measured before this migration, on a statement naming only `archived`:
--
--   BEFORE archive -> roles=2, channels=1, server=1166600000000000001
--   AFTER  archive -> roles=2, channels=1, server=NULL
--
-- So the guild was released for another course to claim while the archived class kept live
-- `discord_roles`, `discord_channels` and `discord_messages` pointing into it -- which is the leak
-- 20260822150000 set out to close, just moved one step along: enqueuers select channels by class and
-- type, so a later notification for the archived class would post into a server another course now
-- owns.
--
-- The teardown is therefore performed inline here rather than delegated to a trigger whose firing
-- depends on the caller's column list. The shared body is extracted so the two paths cannot drift.

-- The teardown itself, callable from anywhere. Deliberately takes the class id rather than a row, so
-- neither caller has to fabricate a NEW record.
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
END;
$$;

COMMENT ON FUNCTION public.clear_discord_tracking_for_class(bigint) IS
  'Drops the discord_roles / discord_channels / discord_messages rows a class tracks. Shared by the server-change trigger and the archive trigger so the two cannot drift. Does not touch discord_channel_group_id, which is a column on classes and must be assigned by a BEFORE trigger.';

REVOKE ALL ON FUNCTION public.clear_discord_tracking_for_class(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_discord_tracking_for_class(bigint) TO service_role;

-- Unchanged behaviour, now expressed through the shared function.
CREATE OR REPLACE FUNCTION public.clear_discord_roles_on_server_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.clear_discord_tracking_for_class(NEW.id);
  -- The category the channels were created under is likewise an id in the old guild. BEFORE trigger,
  -- so assigning to NEW is what persists.
  NEW.discord_channel_group_id := NULL;
  RETURN NEW;
END;
$$;

-- The archive path now does its own teardown.
CREATE OR REPLACE FUNCTION public.release_discord_server_on_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF COALESCE(OLD.archived, false) = false
     AND COALESCE(NEW.archived, false) = true
     AND NEW.discord_server_id IS NOT NULL THEN
    RAISE LOG 'Releasing Discord server % from archived class %', NEW.discord_server_id, NEW.id;

    -- Called directly, NOT left to clear_discord_roles_on_server_change. That trigger is
    -- `BEFORE UPDATE OF discord_server_id`, and an archive statement names only `archived`, so
    -- PostgreSQL never schedules it however this trigger mutates NEW.
    PERFORM public.clear_discord_tracking_for_class(NEW.id);

    NEW.discord_server_id := NULL;
    NEW.discord_channel_group_id := NULL;
    NEW.discord_server_claimed_by := NULL;
    NEW.discord_server_claimed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Repair anything the previous migration released without tearing down.
DO $$
DECLARE
  v_class_id bigint;
BEGIN
  FOR v_class_id IN
    SELECT c.id
    FROM public.classes c
    WHERE COALESCE(c.archived, false) = true
      AND (
        EXISTS (SELECT 1 FROM public.discord_roles r WHERE r.class_id = c.id)
        OR EXISTS (SELECT 1 FROM public.discord_channels ch WHERE ch.class_id = c.id)
        OR EXISTS (SELECT 1 FROM public.discord_messages m WHERE m.class_id = c.id)
      )
  LOOP
    RAISE LOG 'Clearing orphaned Discord tracking for archived class %', v_class_id;
    PERFORM public.clear_discord_tracking_for_class(v_class_id);
  END LOOP;
END $$;

UPDATE public.classes
SET discord_channel_group_id = NULL
WHERE COALESCE(archived, false) = true
  AND discord_server_id IS NULL
  AND discord_channel_group_id IS NOT NULL;
