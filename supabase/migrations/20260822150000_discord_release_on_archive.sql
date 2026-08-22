-- Archiving a class must also unlink its Discord server.
--
-- 20260822130000 made the guild uniqueness index conditional on `archived = false`, so archiving a
-- class releases its Discord server for another course to claim. That half is intentional: a finished
-- course should not hold a server hostage. What it left behind is the other half -- the archived row
-- kept its `discord_server_id`, its `discord_roles` and its `discord_channels`, all still pointing at
-- a guild that now belongs to somebody else.
--
-- That is a cross-course leak, not just untidiness. `app/api/discord/interactions/route.ts` resolves a
-- slash command by `WHERE discord_server_id = <guild>` with no archived filter, so a `/sync-roles` in
-- the new owner's server matched the archived class as well and would have assigned the archived
-- class's roles inside it. Auditing every mutation path for an `archived` check is the fragile version
-- of this fix: the durable one is to make "released" and "no longer linked" the same event, so no
-- path can act on a stale link because no stale link exists.
--
-- The teardown itself is the existing one. Nulling discord_server_id fires
-- clear_discord_roles_on_server_change, which drops the tracked roles, channels and messages and
-- nulls discord_channel_group_id, exactly as a disconnect or a move does. The AFTER trigger that
-- enqueues fresh roles guards on the new value being non-null, so nothing is rebuilt.
--
-- Roles and channels already created inside Discord are left in place, matching disconnect and move:
-- Pawtograder forgets them, a server administrator can delete them. Nobody is removed from the guild.

CREATE OR REPLACE FUNCTION public.release_discord_server_on_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Only the false -> true transition. An UPDATE that leaves `archived` true must not re-run the
  -- teardown, and un-archiving is not this trigger's business: the class comes back with no server,
  -- which is the honest state after its guild was made claimable.
  IF COALESCE(OLD.archived, false) = false
     AND COALESCE(NEW.archived, false) = true
     AND NEW.discord_server_id IS NOT NULL THEN
    RAISE LOG 'Releasing Discord server % from archived class %', NEW.discord_server_id, NEW.id;
    NEW.discord_server_id := NULL;
    NEW.discord_server_claimed_by := NULL;
    NEW.discord_server_claimed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.release_discord_server_on_archive() IS
  'Clears classes.discord_server_id when a class is archived, because the guild uniqueness index stops covering archived rows at that moment. Keeps "the guild is claimable again" and "this class is no longer linked to it" as one event, so no code path can act on a link to a server another course now owns.';

-- BEFORE UPDATE, so the write lands in the same row version rather than as a second UPDATE, and so
-- clear_discord_roles_on_server_change (also BEFORE, on discord_server_id) sees the change.
DROP TRIGGER IF EXISTS trg_release_discord_server_on_archive ON public.classes;
CREATE TRIGGER trg_release_discord_server_on_archive
  BEFORE UPDATE OF archived ON public.classes
  FOR EACH ROW
  EXECUTE FUNCTION public.release_discord_server_on_archive();

-- Any class already in this state. There are no production classes using the feature, so this is
-- expected to be a no-op, but a deployment that archived a Discord-connected class before this
-- migration would otherwise keep the stale link forever.
UPDATE public.classes
SET discord_server_id = NULL,
    discord_server_claimed_by = NULL,
    discord_server_claimed_at = NULL
WHERE COALESCE(archived, false) = true
  AND discord_server_id IS NOT NULL;
