-- Discord Serverless Role Sync Migration
-- Adds RPC for manual role sync and cron job for periodic batch sync
--
-- NOTE: This migration updates the Discord integration to work without Gateway events.
-- Gateway events like GUILD_MEMBER_ADD are NOT available via HTTP webhooks.
-- Role synchronization is handled via:
-- 1. User-triggered sync (RPC function below)
-- 2. /sync-roles slash command in Discord
-- 3. Periodic batch sync cron job (enqueues batch_role_sync to discord async worker)

-- 1. Create RPC function for manual role sync
-- This is called from the UI "Sync Discord Roles" button
CREATE OR REPLACE FUNCTION public.trigger_discord_role_sync_for_user(
  p_class_id bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_discord_id text;
  v_sync_count integer := 0;
  v_user_role RECORD;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Not authenticated', 'synced_classes', 0);
  END IF;

  -- Check if user has Discord linked
  SELECT discord_id INTO v_discord_id
  FROM public.users
  WHERE user_id = v_user_id;

  IF v_discord_id IS NULL THEN
    RETURN jsonb_build_object('error', 'Discord account not linked', 'synced_classes', 0);
  END IF;

  -- Enqueue role sync for all matching classes
  FOR v_user_role IN
    SELECT ur.user_id, ur.class_id, ur.role, c.discord_server_id
    FROM public.user_roles ur
    INNER JOIN public.classes c ON c.id = ur.class_id
    WHERE ur.user_id = v_user_id
      AND ur.disabled = false
      AND c.discord_server_id IS NOT NULL
      AND (p_class_id IS NULL OR ur.class_id = p_class_id)
  LOOP
    -- Enqueue role sync for each role
    BEGIN
      PERFORM public.enqueue_discord_role_sync(
        v_user_role.user_id,
        v_user_role.class_id,
        v_user_role.role,
        'add'
      );
      v_sync_count := v_sync_count + 1;
    EXCEPTION
      WHEN OTHERS THEN
        -- Log but continue
        RAISE WARNING 'Error enqueueing role sync for class %: %', v_user_role.class_id, SQLERRM;
    END;
  END LOOP;

  -- Also mark any pending invites as used for the user
  -- (in case they've already joined the server)
  UPDATE public.discord_invites
  SET used = true
  WHERE user_id = v_user_id
    AND used = false
    AND (p_class_id IS NULL OR class_id = p_class_id);

  RETURN jsonb_build_object('synced_classes', v_sync_count);
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION public.trigger_discord_role_sync_for_user(bigint) TO authenticated;

COMMENT ON FUNCTION public.trigger_discord_role_sync_for_user IS 
'Triggers Discord role synchronization for the current user. 
Can optionally be limited to a specific class_id. 
Returns the number of classes synced.';

-- 2. Function to enqueue batch role sync (processed by discord-async-worker)
CREATE OR REPLACE FUNCTION public.enqueue_discord_batch_role_sync()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Enqueue batch_role_sync message to the discord async worker
  PERFORM pgmq_public.send(
    queue_name := 'discord_async_calls',
    message := jsonb_build_object(
      'method', 'batch_role_sync',
      'args', '{}'::jsonb
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_discord_batch_role_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_batch_role_sync() TO service_role;

COMMENT ON FUNCTION public.enqueue_discord_batch_role_sync IS 
'Enqueues a batch_role_sync job to the discord async worker queue.
The worker will sync Discord roles for all users who have Discord linked.';

-- 3. Function to enqueue slash command registration (processed by discord-async-worker)
CREATE OR REPLACE FUNCTION public.enqueue_discord_register_commands()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Enqueue register_commands message to the discord async worker
  PERFORM pgmq_public.send(
    queue_name := 'discord_async_calls',
    message := jsonb_build_object(
      'method', 'register_commands',
      'args', '{}'::jsonb
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_discord_register_commands() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_register_commands() TO service_role;

COMMENT ON FUNCTION public.enqueue_discord_register_commands IS 
'Enqueues slash command registration to the discord async worker queue.
Safe to run multiple times - Discord command registration is idempotent.';

-- 4. Schedule hourly batch sync cron job
-- First, unschedule if it exists
SELECT cron.unschedule('discord-batch-role-sync-hourly')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discord-batch-role-sync-hourly');

-- Then schedule
SELECT cron.schedule(
  'discord-batch-role-sync-hourly',
  '0 * * * *', -- Every hour at minute 0
  $$SELECT public.enqueue_discord_batch_role_sync();$$
);

-- 5. Schedule daily slash command registration
-- This ensures commands stay registered and any updates are applied
SELECT cron.unschedule('discord-register-commands-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'discord-register-commands-daily');

SELECT cron.schedule(
  'discord-register-commands-daily',
  '0 4 * * *', -- Every day at 4:00 AM UTC (low-traffic time)
  $$SELECT public.enqueue_discord_register_commands();$$
);

-- 6. Update documentation
-- Note: The webhook endpoint no longer handles GUILD_MEMBER_ADD events
-- Role sync is now handled via:
-- - /sync-roles slash command (users invoke after joining Discord)
-- - UI "Sync Discord Roles" button (calls trigger_discord_role_sync_for_user)
-- - Hourly batch sync cron job (enqueues batch_role_sync to discord async worker)

COMMENT ON TABLE public.discord_invites IS 
'Stores Discord server invite links for users who need to join a class Discord server.
After users join, they should use /sync-roles command or the UI sync button to get their roles,
or wait for the hourly batch sync to run.';

-- 7. Immediately register slash commands on migration apply
-- This ensures commands are available right after deployment
SELECT public.enqueue_discord_register_commands();
