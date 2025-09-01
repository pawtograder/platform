-- Fix race condition: auto-accept invitations when user already has SIS ID
-- This handles cases where invitation is created after user gets SIS ID but before we check

-- Create trigger function to auto-accept invitations if user already exists with matching SIS ID
CREATE OR REPLACE FUNCTION public.auto_accept_invitation_if_user_exists()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_existing_role_id bigint;
BEGIN
  -- Only process pending invitations with SIS user ID
  IF NEW.status = 'pending' AND NEW.sis_user_id IS NOT NULL THEN
    
    -- Check if user with this SIS ID already exists
    SELECT u.user_id INTO v_user_id
    FROM users u 
    WHERE u.sis_user_id = NEW.sis_user_id;
    
    IF v_user_id IS NOT NULL THEN
      -- Check if user already has a role in this class
      SELECT ur.id INTO v_existing_role_id
      FROM user_roles ur
      WHERE ur.user_id = v_user_id 
      AND ur.class_id = NEW.class_id
      AND ur.role = NEW.role
      AND ur.disabled = false;
      
      IF v_existing_role_id IS NOT NULL THEN
        -- User already has the role, auto-accept the invitation
        NEW.status := 'accepted';
        NEW.accepted_at := NOW();
        NEW.updated_at := NOW();
        
        -- Log this action for debugging
        RAISE NOTICE 'Auto-accepted invitation % for user % (SIS ID: %) - user already has role % in class %', 
          NEW.id, v_user_id, NEW.sis_user_id, NEW.role, NEW.class_id;
      ELSE
        -- User exists but doesn't have the role yet - create role using invitation's pre-created profiles
        INSERT INTO user_roles (
          user_id,
          class_id,
          role,
          public_profile_id,
          private_profile_id,
          class_section_id,
          lab_section_id,
          disabled,
          invitation_date,
          invitation_id
        ) VALUES (
          v_user_id,
          NEW.class_id,
          NEW.role,
          NEW.public_profile_id,  -- Use invitation's pre-created public profile
          NEW.private_profile_id, -- Use invitation's pre-created private profile
          NEW.class_section_id,
          NEW.lab_section_id,
          false,
          NOW(),
          NEW.id
        );
        
        -- Auto-accept the invitation since we just created the role
        NEW.status := 'accepted';
        NEW.accepted_at := NOW();
        NEW.updated_at := NOW();
        
        -- Log this action for debugging
        RAISE NOTICE 'Created role and auto-accepted invitation % for user % (SIS ID: %) - created role % in class %', 
          NEW.id, v_user_id, NEW.sis_user_id, NEW.role, NEW.class_id;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create the trigger (only if it doesn't exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'trigger_auto_accept_invitation_if_user_exists'
  ) THEN
    CREATE TRIGGER trigger_auto_accept_invitation_if_user_exists
      BEFORE INSERT ON public.invitations
      FOR EACH ROW
      EXECUTE FUNCTION public.auto_accept_invitation_if_user_exists();
  END IF;
END $$;

-- Backfill: Find and fix existing dangling invitations
-- These are invitations where user exists but doesn't have the role yet (race condition)
WITH users_needing_roles AS (
  SELECT DISTINCT
    i.id as invitation_id,
    i.sis_user_id,
    i.class_id,
    i.role,
    i.class_section_id,
    i.lab_section_id,
    i.public_profile_id,  -- Use invitation's pre-created profiles
    i.private_profile_id, -- Use invitation's pre-created profiles
    u.user_id
  FROM invitations i
  JOIN users u ON u.sis_user_id = i.sis_user_id
  LEFT JOIN user_roles ur ON ur.user_id = u.user_id 
    AND ur.class_id = i.class_id 
    AND ur.role = i.role 
    AND ur.disabled = false
  WHERE 
    i.status = 'pending'
    AND i.sis_user_id IS NOT NULL
    AND ur.id IS NULL  -- User exists but doesn't have the role
),
create_missing_roles AS (
  INSERT INTO user_roles (
    user_id,
    class_id,
    role,
    public_profile_id,
    private_profile_id,
    class_section_id,
    lab_section_id,
    disabled,
    invitation_date,
    invitation_id
  )
  SELECT 
    user_id,
    class_id,
    role,
    public_profile_id,  -- Use existing profiles from invitation
    private_profile_id, -- Use existing profiles from invitation
    class_section_id,
    lab_section_id,
    false,
    NOW(),
    invitation_id
  FROM users_needing_roles
  RETURNING user_id, class_id, role
),
update_invitations AS (
  UPDATE invitations 
  SET 
    status = 'accepted',
    accepted_at = NOW(),
    updated_at = NOW()
  FROM users_needing_roles unr
  WHERE invitations.id = unr.invitation_id
  RETURNING 
    invitations.id, 
    invitations.class_id, 
    invitations.role, 
    invitations.sis_user_id
)
SELECT 
  (SELECT COUNT(*) FROM create_missing_roles) as roles_created,
  (SELECT COUNT(*) FROM update_invitations) as invitations_accepted,
  COUNT(*) FILTER (WHERE role = 'student') as students_backfilled,
  COUNT(*) FILTER (WHERE role = 'instructor') as instructors_backfilled,
  COUNT(*) FILTER (WHERE role = 'grader') as graders_backfilled,
  array_agg(DISTINCT class_id) as affected_classes
FROM update_invitations;
