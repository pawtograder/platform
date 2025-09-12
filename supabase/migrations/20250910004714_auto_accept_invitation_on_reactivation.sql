-- Automatically accept/reactivate invitations when they change from expired -> pending
-- This complements the existing triggers that run on INSERT and on section updates



-- Recreate the function to work with AFTER INSERT (where invitation ID exists)
CREATE OR REPLACE FUNCTION "public"."auto_accept_invitation_if_user_exists"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
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
      AND ur.role = NEW.role;
      
      IF v_existing_role_id IS NOT NULL THEN
        -- User already has the role, update section assignments and auto-accept the invitation
        UPDATE user_roles 
        SET class_section_id = NEW.class_section_id,
            lab_section_id = NEW.lab_section_id,
            invitation_id = NEW.id,  -- Link to the new invitation
            disabled = false
        WHERE id = v_existing_role_id;
        
        UPDATE invitations 
        SET status = 'accepted', 
            accepted_at = NOW(), 
            updated_at = NOW()
        WHERE id = NEW.id;
        
        -- Log this action for debugging
        RAISE NOTICE 'Updated sections and auto-accepted invitation % for user % (SIS ID: %) - updated existing role % in class % with sections (class: %, lab: %)', 
          NEW.id, v_user_id, NEW.sis_user_id, NEW.role, NEW.class_id, NEW.class_section_id, NEW.lab_section_id;
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
          null,
          NEW.id  -- Now NEW.id exists because this is AFTER INSERT
        );
        
        -- Auto-accept the invitation since we just created the role
        UPDATE invitations 
        SET status = 'accepted', 
            accepted_at = NOW(), 
            updated_at = NOW()
        WHERE id = NEW.id;
        
        -- Log this action for debugging
        RAISE NOTICE 'Created role and auto-accepted invitation % for user % (SIS ID: %) - created role % in class %', 
          NEW.id, v_user_id, NEW.sis_user_id, NEW.role, NEW.class_id;
      END IF;
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create a trigger that fires when an invitation status transitions from 'expired' to 'pending'
CREATE OR REPLACE TRIGGER trigger_auto_accept_invitation_on_reactivation
AFTER UPDATE ON public.invitations
FOR EACH ROW
WHEN (OLD.status = 'expired' AND NEW.status = 'pending')
EXECUTE FUNCTION public.auto_accept_invitation_if_user_exists();


