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
  p_role text, -- 'student', 'grader', or 'instructor'
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
    AND dr.role_type = p_role;

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

-- 6. Trigger function to create roles when Discord server is connected to a class
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
      
      -- Log for debugging (can be removed in production)
      RAISE NOTICE 'Enqueued Discord role creation for class_id=%, guild_id=%', NEW.id, NEW.discord_server_id;
    ELSE
      RAISE NOTICE 'Discord roles already exist for class_id=%, skipping creation', NEW.id;
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

-- 7. Create trigger on classes table
DROP TRIGGER IF EXISTS trg_discord_create_roles_on_server_connect ON public.classes;
CREATE TRIGGER trg_discord_create_roles_on_server_connect
  AFTER UPDATE OF discord_server_id ON public.classes
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_discord_create_roles_on_server_connect();

-- 8. Grant execute permissions
REVOKE EXECUTE ON FUNCTION public.enqueue_discord_role_creation(bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_role_creation(bigint, text, text) TO postgres;

REVOKE EXECUTE ON FUNCTION public.enqueue_discord_role_sync(uuid, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_role_sync(uuid, bigint, text, text) TO postgres;

REVOKE EXECUTE ON FUNCTION public.enqueue_discord_roles_creation(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_roles_creation(bigint, text) TO postgres;

-- 9. Comments
COMMENT ON FUNCTION public.enqueue_discord_role_creation IS 'Enqueues creation of a Discord role for a class';
COMMENT ON FUNCTION public.enqueue_discord_role_sync IS 'Enqueues adding or removing a Discord role for a user based on their Pawtograder role';
COMMENT ON FUNCTION public.enqueue_discord_roles_creation IS 'Enqueues creation of all three Discord roles (Student, Grader, Instructor) for a class';
COMMENT ON FUNCTION public.trigger_discord_role_sync IS 'Trigger function that syncs Discord roles when user_roles change';
COMMENT ON FUNCTION public.trigger_discord_create_roles_on_server_connect IS 'Trigger function that creates Discord roles when a Discord server is connected to a class';
