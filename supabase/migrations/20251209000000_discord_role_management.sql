-- Discord Role Management Migration
-- Auto-create roles, sync roles, and handle server invites

-- 1. Function to enqueue Discord role creation
CREATE OR REPLACE FUNCTION public.enqueue_discord_role_creation(
  p_class_id bigint,
  p_role_type text, -- 'student', 'grader', or 'instructor'
  p_guild_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_guild_id text;
  v_class_slug text;
  v_term integer;
  v_role_name text;
  v_term_text text;
  v_year integer;
  v_term_code integer;
BEGIN
  -- Get Discord server info, class slug, and term from class
  SELECT c.discord_server_id, c.slug, c.term
  INTO v_guild_id, v_class_slug, v_term
  FROM public.classes c
  WHERE c.id = p_class_id;

  -- Use provided guild_id or fall back to class's discord_server_id
  v_guild_id := COALESCE(p_guild_id, v_guild_id);

  -- Skip if no Discord server configured
  IF v_guild_id IS NULL THEN
    RETURN;
  END IF;

  -- Parse term to get semester/year text
  IF v_term IS NOT NULL THEN
    v_year := FLOOR(v_term / 100);
    v_term_code := v_term % 100;
    
    -- Handle Fall term (Banner uses next year for Fall)
    IF v_term_code = 10 THEN
      v_year := v_year - 1;
    END IF;
    
    -- Map term codes to semester names
    CASE v_term_code
      WHEN 10 THEN v_term_text := format('Fall %s', v_year);
      WHEN 30 THEN v_term_text := format('Spring %s', v_year);
      WHEN 40 THEN v_term_text := format('Summer 1 %s', v_year);
      WHEN 50 THEN v_term_text := format('Summer Full %s', v_year);
      WHEN 60 THEN v_term_text := format('Summer 2 %s', v_year);
      ELSE v_term_text := format('Term %s %s', v_term_code, v_year);
    END CASE;
  ELSE
    v_term_text := NULL;
  END IF;

  -- Determine role name: {semester/year} {class_slug} - {Role Type} ({class_id})
  -- Format: "Fall 2024 CS2500 - Student (123)" or "CS2500 - Student (123)" if no term
  v_role_name := format('%s - %s (%s)',
    (CASE WHEN v_term_text IS NOT NULL THEN v_term_text || ' ' ELSE '' END || COALESCE(INITCAP(v_class_slug), 'Class')),
    CASE p_role_type
      WHEN 'student' THEN 'Student'
      WHEN 'grader' THEN 'Grader'
      WHEN 'instructor' THEN 'Instructor'
      ELSE INITCAP(p_role_type)
    END,
    p_class_id::text
  );

  -- Enqueue role creation
  PERFORM pgmq_public.send(
    queue_name := 'discord_async_calls',
    message := jsonb_build_object(
      'method', 'create_role',
      'args', jsonb_build_object(
        'guild_id', v_guild_id,
        'name', v_role_name,
        'mentionable', true -- Allow @mentions for these roles
      ),
      'class_id', p_class_id,
      'role_type', p_role_type
    )
  );
END;
$$;

-- 2. Function to enqueue Discord role sync for a user
CREATE OR REPLACE FUNCTION public.enqueue_discord_role_sync(
  p_user_id uuid,
  p_class_id bigint,
  p_role public.app_role, -- 'student', 'grader', or 'instructor'
  p_action text DEFAULT 'add' -- 'add' or 'remove'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_guild_id text;
  v_discord_user_id text;
  v_discord_role_id text;
  v_class_slug text;
BEGIN
  -- Get Discord server info from class
  SELECT c.discord_server_id, c.slug
  INTO v_guild_id, v_class_slug
  FROM public.classes c
  WHERE c.id = p_class_id;

  -- Skip if no Discord server configured
  IF v_guild_id IS NULL THEN
    RETURN;
  END IF;

  -- Get user's Discord ID
  SELECT u.discord_id INTO v_discord_user_id
  FROM public.users u
  WHERE u.user_id = p_user_id;

  -- Skip if user doesn't have Discord linked
  IF v_discord_user_id IS NULL THEN
    RETURN;
  END IF;

  -- Note: We don't check if user is in server here - the async worker will handle that
  -- and create an invite if needed. This allows the role sync to be queued even if
  -- the user isn't in the server yet.

  -- Get Discord role ID for this class and role type
  SELECT dr.discord_role_id INTO v_discord_role_id
  FROM public.discord_roles dr
  WHERE dr.class_id = p_class_id
    AND dr.role_type = p_role::text;

  -- Skip if role doesn't exist yet (will be created when server is connected)
  IF v_discord_role_id IS NULL THEN
    RETURN;
  END IF;

  -- Enqueue role add/remove operation
  IF p_action = 'add' THEN
    PERFORM pgmq_public.send(
      queue_name := 'discord_async_calls',
      message := jsonb_build_object(
        'method', 'add_member_role',
        'args', jsonb_build_object(
          'guild_id', v_guild_id,
          'user_id', v_discord_user_id,
          'role_id', v_discord_role_id
        ),
        'class_id', p_class_id
      )
    );
  ELSIF p_action = 'remove' THEN
    PERFORM pgmq_public.send(
      queue_name := 'discord_async_calls',
      message := jsonb_build_object(
        'method', 'remove_member_role',
        'args', jsonb_build_object(
          'guild_id', v_guild_id,
          'user_id', v_discord_user_id,
          'role_id', v_discord_role_id
        ),
        'class_id', p_class_id
      )
    );
  END IF;
END;
$$;

-- 3. Function to create all roles for a class when Discord server is connected
CREATE OR REPLACE FUNCTION public.enqueue_discord_roles_creation(
  p_class_id bigint,
  p_guild_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Create all three role types
  PERFORM public.enqueue_discord_role_creation(p_class_id, 'student', p_guild_id);
  PERFORM public.enqueue_discord_role_creation(p_class_id, 'grader', p_guild_id);
  PERFORM public.enqueue_discord_role_creation(p_class_id, 'instructor', p_guild_id);
END;
$$;

-- 4. Trigger function for role sync on user_roles changes
CREATE OR REPLACE FUNCTION public.trigger_discord_role_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- On INSERT: add role
  IF TG_OP = 'INSERT' THEN
    PERFORM public.enqueue_discord_role_sync(NEW.user_id, NEW.class_id, NEW.role, 'add');
    RETURN NEW;
  END IF;

  -- On UPDATE: if role changed, remove old role and add new role
  IF TG_OP = 'UPDATE' THEN
    IF OLD.role IS DISTINCT FROM NEW.role THEN
      PERFORM public.enqueue_discord_role_sync(OLD.user_id, OLD.class_id, OLD.role, 'remove');
      PERFORM public.enqueue_discord_role_sync(NEW.user_id, NEW.class_id, NEW.role, 'add');
    END IF;
    RETURN NEW;
  END IF;

  -- On DELETE: remove role
  IF TG_OP = 'DELETE' THEN
    PERFORM public.enqueue_discord_role_sync(OLD.user_id, OLD.class_id, OLD.role, 'remove');
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

-- 5. Create trigger on user_roles table
DROP TRIGGER IF EXISTS trg_discord_role_sync ON public.user_roles;
CREATE TRIGGER trg_discord_role_sync
  AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_discord_role_sync();

-- 6. Function to enqueue invite creation for users who have Discord linked but aren't in server
-- This fixes the race condition where users already have Discord linked when server is connected
-- We enqueue role syncs which will create invites when processed (the async worker checks membership first)
CREATE OR REPLACE FUNCTION public.enqueue_discord_invites_for_existing_users(
  p_class_id bigint,
  p_guild_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_role RECORD;
  v_discord_role_id text;
BEGIN
  -- For each user who:
  -- 1. Has a role in this class
  -- 2. Has Discord linked
  -- 3. Doesn't already have an active invite
  -- 4. Is active (not disabled)
  FOR v_user_role IN
    SELECT DISTINCT ur.user_id, ur.role, u.discord_id
    FROM public.user_roles ur
    INNER JOIN public.users u ON u.user_id = ur.user_id
    LEFT JOIN public.discord_invites di ON di.user_id = ur.user_id 
      AND di.class_id = ur.class_id 
      AND di.guild_id = p_guild_id
      AND di.used = false
      AND di.expires_at > now()
    WHERE ur.class_id = p_class_id
      AND ur.disabled = false
      AND u.discord_id IS NOT NULL
      AND di.id IS NULL -- No active invite exists
  LOOP
    -- Try to get the Discord role ID for this user's role
    SELECT dr.discord_role_id INTO v_discord_role_id
    FROM public.discord_roles dr
    WHERE dr.class_id = p_class_id
      AND dr.role_type = v_user_role.role::text
    LIMIT 1;
    
    -- If role exists, enqueue role sync (which will create invite if user not in server)
    IF v_discord_role_id IS NOT NULL THEN
      PERFORM public.enqueue_discord_role_sync(
        v_user_role.user_id,
        p_class_id,
        v_user_role.role,
        'add'
      );
    END IF;
    -- If role doesn't exist yet, we'll skip for now
    -- The sync_existing_users_after_roles_created function will handle invites
    -- when roles are created. This ensures we don't enqueue operations with invalid role_ids.
  END LOOP;
END;
$$;

-- 7. Trigger function to create roles when Discord server is connected to a class
CREATE OR REPLACE FUNCTION public.trigger_discord_create_roles_on_server_connect()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_roles_exist boolean;
BEGIN
  -- When discord_server_id is set (and wasn't set before), create roles
  IF NEW.discord_server_id IS NOT NULL 
     AND (OLD.discord_server_id IS NULL OR OLD.discord_server_id IS DISTINCT FROM NEW.discord_server_id) THEN
    
    -- Check if roles already exist for this class
    SELECT EXISTS (
      SELECT 1 FROM public.discord_roles 
      WHERE class_id = NEW.id
    ) INTO v_roles_exist;
    
    IF NOT v_roles_exist THEN
      -- Enqueue role creation
      PERFORM public.enqueue_discord_roles_creation(NEW.id, NEW.discord_server_id);
      
      -- Also enqueue invite creation for users who already have Discord linked
      -- This fixes the race condition where users have Discord but aren't in server yet
      PERFORM public.enqueue_discord_invites_for_existing_users(NEW.id, NEW.discord_server_id);
    END IF;
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the update
    RAISE WARNING 'Error in trigger_discord_create_roles_on_server_connect for class_id=%: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

-- 7. Function to sync all existing users for a class after roles are created
-- This fixes the race condition where users are already in the Discord server
-- but roles haven't been created yet
CREATE OR REPLACE FUNCTION public.sync_existing_users_after_roles_created(
  p_class_id bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_role RECORD;
BEGIN
  -- Enqueue role sync for all users who:
  -- 1. Have a role in this class (user_roles)
  -- 2. Have Discord linked (users.discord_id is not null)
  -- 3. Are active (not disabled)
  FOR v_user_role IN
    SELECT ur.user_id, ur.class_id, ur.role
    FROM public.user_roles ur
    INNER JOIN public.users u ON u.user_id = ur.user_id
    WHERE ur.class_id = p_class_id
      AND ur.disabled = false
      AND u.discord_id IS NOT NULL
  LOOP
    -- Enqueue role sync for each user
    -- The async worker will check if user is in server and assign role or create invite
    PERFORM public.enqueue_discord_role_sync(
      v_user_role.user_id,
      v_user_role.class_id,
      v_user_role.role,
      'add'
    );
  END LOOP;
END;
$$;

-- 8. Trigger function to sync existing users when all roles are created
CREATE OR REPLACE FUNCTION public.trigger_sync_existing_users_on_role_creation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role_count integer;
BEGIN
  -- Check if all three role types exist for this class
  SELECT COUNT(DISTINCT role_type) INTO v_role_count
  FROM public.discord_roles
  WHERE class_id = NEW.class_id
    AND role_type IN ('student', 'grader', 'instructor');
  
  -- If all three roles exist, sync existing users
  -- This fixes the race condition where users are already in the Discord server
  -- but roles were just created. The sync will enqueue role assignments for all
  -- existing users who have Discord linked.
  IF v_role_count = 3 THEN
    PERFORM public.sync_existing_users_after_roles_created(NEW.class_id);
  END IF;
  
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Log error but don't fail the insert
    RAISE WARNING 'Error in trigger_sync_existing_users_on_role_creation for class_id=%: %', NEW.class_id, SQLERRM;
    RETURN NEW;
END;
$$;

-- 9. Create trigger on discord_roles table
DROP TRIGGER IF EXISTS trg_sync_existing_users_on_role_creation ON public.discord_roles;
CREATE TRIGGER trg_sync_existing_users_on_role_creation
  AFTER INSERT ON public.discord_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_sync_existing_users_on_role_creation();

-- 10. Create trigger on classes table
DROP TRIGGER IF EXISTS trg_discord_create_roles_on_server_connect ON public.classes;
CREATE TRIGGER trg_discord_create_roles_on_server_connect
  AFTER UPDATE OF discord_server_id ON public.classes
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_discord_create_roles_on_server_connect();

-- 11. Grant execute permissions
REVOKE EXECUTE ON FUNCTION public.enqueue_discord_role_creation(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_role_creation(bigint, text, text) TO postgres;

REVOKE EXECUTE ON FUNCTION public.enqueue_discord_role_sync(uuid, bigint, public.app_role, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_role_sync(uuid, bigint, public.app_role, text) TO postgres;

REVOKE EXECUTE ON FUNCTION public.enqueue_discord_roles_creation(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_roles_creation(bigint, text) TO postgres;

REVOKE EXECUTE ON FUNCTION public.sync_existing_users_after_roles_created(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sync_existing_users_after_roles_created(bigint) TO postgres;

REVOKE EXECUTE ON FUNCTION public.enqueue_discord_invites_for_existing_users(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_invites_for_existing_users(bigint, text) TO postgres;

-- 12. Create discord_invites table to store invite links for users not in server
CREATE TABLE IF NOT EXISTS public.discord_invites (
  id bigint PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  user_id uuid NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  class_id bigint NOT NULL REFERENCES public.classes(id) ON DELETE CASCADE,
  guild_id text NOT NULL,
  invite_code text NOT NULL,
  invite_url text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean DEFAULT false NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE(user_id, class_id, guild_id) -- One active invite per user per class per server
);

-- 13. Create indexes for discord_invites
CREATE INDEX IF NOT EXISTS idx_discord_invites_user_id ON public.discord_invites(user_id);
CREATE INDEX IF NOT EXISTS idx_discord_invites_class_id ON public.discord_invites(class_id);
CREATE INDEX IF NOT EXISTS idx_discord_invites_active ON public.discord_invites(user_id, class_id, used, expires_at) WHERE used = false;

-- 14. Enable RLS on discord_invites
ALTER TABLE public.discord_invites ENABLE ROW LEVEL SECURITY;

-- 15. RLS Policies for discord_invites
-- Users can view their own invites
DROP POLICY IF EXISTS discord_invites_user_select ON public.discord_invites;
CREATE POLICY discord_invites_user_select
  ON public.discord_invites
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Staff can view invites for their classes
DROP POLICY IF EXISTS discord_invites_staff_select ON public.discord_invites;
CREATE POLICY discord_invites_staff_select
  ON public.discord_invites
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.class_id = discord_invites.class_id
        AND ur.user_id = auth.uid()
        AND ur.role IN ('instructor', 'grader')
    )
  );

-- Service role can do everything
DROP POLICY IF EXISTS discord_invites_service_role_all ON public.discord_invites;
CREATE POLICY discord_invites_service_role_all
  ON public.discord_invites
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 16. Grant execute permission for check_discord_role_sync_after_link
REVOKE EXECUTE ON FUNCTION public.check_discord_role_sync_after_link(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_discord_role_sync_after_link(uuid) TO postgres;

-- 17. Function to mark invite as used when user joins server
CREATE OR REPLACE FUNCTION public.mark_discord_invite_used(
  p_user_id uuid,
  p_guild_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.discord_invites
  SET used = true
  WHERE user_id = p_user_id
    AND guild_id = p_guild_id
    AND used = false;
END;
$$;

-- 18. Function already exists in earlier migration, but ensure it's updated to work properly
-- (The function is created in 20251208193226_discord_integration.sql, but we ensure it works here)
CREATE OR REPLACE FUNCTION public.check_discord_role_sync_after_link(
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_role RECORD;
BEGIN
  -- Get all active roles for this user in classes with Discord servers
  FOR v_user_role IN
    SELECT ur.user_id, ur.class_id, ur.role
    FROM public.user_roles ur
    INNER JOIN public.classes c ON c.id = ur.class_id
    WHERE ur.user_id = p_user_id
      AND ur.disabled = false
      AND c.discord_server_id IS NOT NULL
  LOOP
    -- Enqueue role sync for each role
    -- This will check if user is in server and create invite if needed
    PERFORM public.enqueue_discord_role_sync(
      v_user_role.user_id,
      v_user_role.class_id,
      v_user_role.role,
      'add'
    );
  END LOOP;
END;
$$;

-- 19. Comments
COMMENT ON TABLE public.discord_invites IS 'Stores Discord server invite links for users who need to join a class Discord server';
COMMENT ON FUNCTION public.enqueue_discord_role_creation IS 'Enqueues creation of a Discord role for a class';
COMMENT ON FUNCTION public.enqueue_discord_role_sync IS 'Enqueues adding or removing a Discord role for a user based on their Pawtograder role';
COMMENT ON FUNCTION public.enqueue_discord_roles_creation IS 'Enqueues creation of all three Discord roles (Student, Grader, Instructor) for a class';
COMMENT ON FUNCTION public.trigger_discord_role_sync IS 'Trigger function that syncs Discord roles when user_roles change';
COMMENT ON FUNCTION public.trigger_discord_create_roles_on_server_connect IS 'Trigger function that creates Discord roles when a Discord server is connected to a class';
COMMENT ON FUNCTION public.sync_existing_users_after_roles_created IS 'Syncs Discord roles for all existing users in a class after roles are created. Fixes race condition where users are already in the server but roles havent been created yet.';
COMMENT ON FUNCTION public.trigger_sync_existing_users_on_role_creation IS 'Trigger function that syncs existing users when all three Discord roles are created for a class';
COMMENT ON FUNCTION public.enqueue_discord_invites_for_existing_users IS 'Enqueues invite creation for users who have Discord linked but arent in the server yet. Fixes race condition where users have Discord linked when server is connected but arent in the server.';
COMMENT ON FUNCTION public.mark_discord_invite_used IS 'Marks Discord invites as used when a user joins a server';
COMMENT ON FUNCTION public.check_discord_role_sync_after_link IS 'Checks and syncs Discord roles for a user after linking Discord account, creating invites if needed';

-- NOTE: Discord Webhook Setup
-- To enable automatic role assignment when users join Discord servers:
-- 1. Create a webhook in Discord Developer Portal → Your App → Webhooks
-- 2. Set webhook URL to: https://your-domain.com/api/discord/webhook
-- 3. Copy webhook's public key (signing secret) and set as DISCORD_WEBHOOK_PUBLIC_KEY environment variable
--    (hex-encoded, with or without 0x prefix)
-- 4. Enable "Guild Member Add" event in webhook settings
-- 5. The webhook endpoint uses ed25519 signature verification for security
-- 6. The webhook endpoint will automatically:
--    - Verify request signature
--    - Mark pending invites as used
--    - Enqueue role sync operations to assign Pawtograder roles
