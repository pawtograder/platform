-- Bulk CSV Import Enrollment RPC
-- Efficiently processes CSV enrollment imports in a single transaction
-- Supports both email-based and SIS ID-based imports

CREATE OR REPLACE FUNCTION public.bulk_csv_import_enrollment(
  p_class_id bigint,
  p_import_mode text,           -- 'email' or 'sis_id'
  p_enrollment_data jsonb,      -- Array of enrollment records
  p_notify boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_enrolled_directly integer := 0;
  v_invitations_created integer := 0;
  v_reactivated integer := 0;
  v_errors jsonb := '[]'::jsonb;
  v_current_user_id uuid;
  v_course_name text;
  v_inviter_name text;
  rec record;
  v_user_id uuid;
  v_user_role_id bigint;
  v_existing_role_id bigint;
  v_invitation_id bigint;
  v_error_msg text;
BEGIN
  -- Authorization: must be instructor for the class
  IF NOT (public.authorizeforclassinstructor(p_class_id) OR public.authorize_for_admin()) THEN
    RAISE EXCEPTION 'Access denied: instructor or admin required for class %', p_class_id;
  END IF;

  -- Validate import mode
  IF p_import_mode NOT IN ('email', 'sis_id') THEN
    RAISE EXCEPTION 'Invalid import mode: %. Must be "email" or "sis_id"', p_import_mode;
  END IF;

  -- Get current user for notifications and invited_by
  v_current_user_id := auth.uid();
  
  -- Get course name for notifications
  SELECT name INTO v_course_name FROM public.classes WHERE id = p_class_id;
  
  -- Get inviter name for notifications
  SELECT p.name INTO v_inviter_name
  FROM public.user_roles ur
  JOIN public.profiles p ON p.id = ur.private_profile_id
  WHERE ur.user_id = v_current_user_id AND ur.class_id = p_class_id
  LIMIT 1;

  -- Create temp table for input data
  CREATE TEMP TABLE tmp_import_data (
    email text,
    name text,
    role public.app_role,
    sis_id integer,
    sis_sync_opt_out boolean DEFAULT false
  ) ON COMMIT DROP;

  -- Parse and insert input data
  INSERT INTO tmp_import_data (email, name, role, sis_id, sis_sync_opt_out)
  SELECT
    NULLIF(btrim(r.email), ''),
    COALESCE(NULLIF(btrim(r.name), ''), 'Unknown User'),
    COALESCE((r.role)::public.app_role, 'student'),
    NULLIF((r.sis_id)::text, '')::integer,
    COALESCE((r.sis_sync_opt_out)::boolean, false)
  FROM jsonb_to_recordset(p_enrollment_data) AS r(
    email text,
    name text,
    role text,
    sis_id integer,
    sis_sync_opt_out boolean
  );

  -- Process based on import mode
  IF p_import_mode = 'sis_id' THEN
    -- ===============================
    -- SIS ID MODE PROCESSING
    -- ===============================
    
    -- 1. Handle users who are already enrolled in this class
    -- Set sis_sync_opt_out = true and reactivate if disabled
    FOR rec IN
      SELECT 
        d.sis_id,
        d.name AS import_name,
        d.role AS import_role,
        d.sis_sync_opt_out AS import_opt_out,
        u.user_id,
        ur.id AS user_role_id,
        ur.disabled
      FROM tmp_import_data d
      JOIN public.users u ON u.sis_user_id = d.sis_id
      JOIN public.user_roles ur ON ur.user_id = u.user_id AND ur.class_id = p_class_id
      WHERE d.sis_id IS NOT NULL
    LOOP
      -- Update existing enrollment: set sis_sync_opt_out = true (manually managed)
      -- and reactivate if disabled
      UPDATE public.user_roles
      SET 
        sis_sync_opt_out = true,
        disabled = false
      WHERE id = rec.user_role_id;
      
      v_reactivated := v_reactivated + 1;
    END LOOP;

    -- 2. Handle users who exist in system but NOT enrolled in this class
    FOR rec IN
      SELECT 
        d.sis_id,
        d.name AS import_name,
        d.role AS import_role,
        d.sis_sync_opt_out AS import_opt_out,
        u.user_id
      FROM tmp_import_data d
      JOIN public.users u ON u.sis_user_id = d.sis_id
      LEFT JOIN public.user_roles ur ON ur.user_id = u.user_id AND ur.class_id = p_class_id
      WHERE d.sis_id IS NOT NULL
        AND ur.id IS NULL  -- Not enrolled
    LOOP
      BEGIN
        -- Create enrollment using existing function
        v_user_role_id := public.create_user_role_for_existing_user(
          rec.user_id,
          p_class_id,
          rec.import_role,
          rec.import_name,
          rec.sis_id
        );
        
        -- Set sis_sync_opt_out = true since manually imported
        UPDATE public.user_roles
        SET sis_sync_opt_out = true
        WHERE id = v_user_role_id;
        
        v_enrolled_directly := v_enrolled_directly + 1;
        
        -- Create notification if requested
        IF p_notify AND v_course_name IS NOT NULL THEN
          INSERT INTO public.notifications (
            user_id,
            class_id,
            subject,
            body,
            style
          ) VALUES (
            rec.user_id,
            p_class_id,
            'You have been added to ' || v_course_name,
            jsonb_build_object(
              'type', 'course_enrollment',
              'action', 'create',
              'course_name', v_course_name,
              'course_id', p_class_id,
              'inviter_name', COALESCE(v_inviter_name, 'Course Administrator')
            ),
            'info'
          );
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_error_msg = MESSAGE_TEXT;
        v_errors := v_errors || jsonb_build_object(
          'identifier', rec.sis_id,
          'error', v_error_msg
        );
      END;
    END LOOP;

    -- 3. Create invitations for users not in the system
    -- (no matching sis_user_id in users table)
    FOR rec IN
      SELECT 
        d.sis_id,
        d.name AS import_name,
        d.role AS import_role
      FROM tmp_import_data d
      LEFT JOIN public.users u ON u.sis_user_id = d.sis_id
      LEFT JOIN public.invitations inv ON inv.class_id = p_class_id 
        AND inv.sis_user_id = d.sis_id 
        AND inv.status = 'pending'
      WHERE d.sis_id IS NOT NULL
        AND u.user_id IS NULL  -- User doesn't exist
        AND inv.id IS NULL     -- No pending invitation
    LOOP
      BEGIN
        -- Create invitation using existing function (sis_managed = false for manual import)
        v_invitation_id := public.create_invitation(
          p_class_id,
          rec.import_role,
          rec.sis_id,
          NULL,  -- email
          rec.import_name,
          v_current_user_id,
          NULL,  -- class_section_id
          NULL,  -- lab_section_id
          false  -- sis_managed = false (manually created)
        );
        
        v_invitations_created := v_invitations_created + 1;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_error_msg = MESSAGE_TEXT;
        v_errors := v_errors || jsonb_build_object(
          'identifier', rec.sis_id,
          'error', v_error_msg
        );
      END;
    END LOOP;

  ELSE
    -- ===============================
    -- EMAIL MODE PROCESSING
    -- ===============================
    
    -- 1. Handle users who already exist and are enrolled
    FOR rec IN
      SELECT 
        d.email,
        d.name AS import_name,
        d.role AS import_role,
        d.sis_sync_opt_out AS import_opt_out,
        u.user_id,
        ur.id AS user_role_id,
        ur.disabled
      FROM tmp_import_data d
      JOIN public.users u ON lower(u.email) = lower(d.email)
      JOIN public.user_roles ur ON ur.user_id = u.user_id AND ur.class_id = p_class_id
      WHERE d.email IS NOT NULL
    LOOP
      -- Update existing enrollment: set sis_sync_opt_out = true and reactivate
      UPDATE public.user_roles
      SET 
        sis_sync_opt_out = true,
        disabled = false
      WHERE id = rec.user_role_id;
      
      v_reactivated := v_reactivated + 1;
    END LOOP;

    -- 2. Handle users who exist but NOT enrolled
    FOR rec IN
      SELECT 
        d.email,
        d.name AS import_name,
        d.role AS import_role,
        d.sis_sync_opt_out AS import_opt_out,
        u.user_id
      FROM tmp_import_data d
      JOIN public.users u ON lower(u.email) = lower(d.email)
      LEFT JOIN public.user_roles ur ON ur.user_id = u.user_id AND ur.class_id = p_class_id
      WHERE d.email IS NOT NULL
        AND ur.id IS NULL  -- Not enrolled
    LOOP
      BEGIN
        -- Create enrollment using existing function
        v_user_role_id := public.create_user_role_for_existing_user(
          rec.user_id,
          p_class_id,
          rec.import_role,
          rec.import_name,
          NULL  -- no sis_id for email mode
        );
        
        -- Set sis_sync_opt_out = true since manually imported
        UPDATE public.user_roles
        SET sis_sync_opt_out = true
        WHERE id = v_user_role_id;
        
        v_enrolled_directly := v_enrolled_directly + 1;
        
        -- Create notification if requested
        IF p_notify AND v_course_name IS NOT NULL THEN
          INSERT INTO public.notifications (
            user_id,
            class_id,
            subject,
            body,
            style
          ) VALUES (
            rec.user_id,
            p_class_id,
            'You have been added to ' || v_course_name,
            jsonb_build_object(
              'type', 'course_enrollment',
              'action', 'create',
              'course_name', v_course_name,
              'course_id', p_class_id,
              'inviter_name', COALESCE(v_inviter_name, 'Course Administrator')
            ),
            'info'
          );
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_error_msg = MESSAGE_TEXT;
        v_errors := v_errors || jsonb_build_object(
          'identifier', rec.email,
          'error', v_error_msg
        );
      END;
    END LOOP;

    -- 3. Handle new users (email not in system)
    -- Only allow @northeastern.edu and @pawtograder.net domains
    FOR rec IN
      SELECT 
        d.email,
        d.name AS import_name,
        d.role AS import_role
      FROM tmp_import_data d
      LEFT JOIN public.users u ON lower(u.email) = lower(d.email)
      WHERE d.email IS NOT NULL
        AND u.user_id IS NULL  -- User doesn't exist
    LOOP
      BEGIN
        -- Check if email domain is allowed for direct creation
        IF NOT (
          lower(rec.email) LIKE '%@northeastern.edu' OR 
          lower(rec.email) LIKE '%@pawtograder.net'
        ) THEN
          v_errors := v_errors || jsonb_build_object(
            'identifier', rec.email,
            'error', 'Email domain not supported for direct import. Use SIS ID import instead.'
          );
          CONTINUE;
        END IF;
        
        -- Create auth user
        v_user_id := gen_random_uuid();
        
        INSERT INTO auth.users (
          instance_id,
          id,
          aud,
          role,
          email,
          encrypted_password,
          email_confirmed_at,
          raw_app_meta_data,
          raw_user_meta_data,
          created_at,
          updated_at,
          confirmation_token,
          recovery_token
        ) VALUES (
          '00000000-0000-0000-0000-000000000000',
          v_user_id,
          'authenticated',
          'authenticated',
          rec.email,
          '',  -- No password, user will authenticate via SSO
          now(),
          '{"provider":"email","providers":["email"]}',
          jsonb_build_object('name', rec.import_name),
          now(),
          now(),
          '',
          ''
        );
        
        -- The users table entry is created by a trigger on auth.users
        -- Wait a moment for the trigger to fire, then update the name
        UPDATE public.users
        SET name = rec.import_name
        WHERE user_id = v_user_id;
        
        -- Create enrollment
        v_user_role_id := public.create_user_role_for_existing_user(
          v_user_id,
          p_class_id,
          rec.import_role,
          rec.import_name,
          NULL
        );
        
        -- Set sis_sync_opt_out = true since manually imported
        UPDATE public.user_roles
        SET sis_sync_opt_out = true
        WHERE id = v_user_role_id;
        
        v_enrolled_directly := v_enrolled_directly + 1;
        
        -- Create notification if requested
        IF p_notify AND v_course_name IS NOT NULL THEN
          INSERT INTO public.notifications (
            user_id,
            class_id,
            subject,
            body,
            style
          ) VALUES (
            v_user_id,
            p_class_id,
            'You have been added to ' || v_course_name,
            jsonb_build_object(
              'type', 'course_enrollment',
              'action', 'create',
              'course_name', v_course_name,
              'course_id', p_class_id,
              'inviter_name', COALESCE(v_inviter_name, 'Course Administrator')
            ),
            'info'
          );
        END IF;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_error_msg = MESSAGE_TEXT;
        v_errors := v_errors || jsonb_build_object(
          'identifier', rec.email,
          'error', v_error_msg
        );
      END;
    END LOOP;
  END IF;

  -- Return summary
  RETURN jsonb_build_object(
    'enrolled_directly', v_enrolled_directly,
    'invitations_created', v_invitations_created,
    'reactivated', v_reactivated,
    'errors', v_errors
  );
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.bulk_csv_import_enrollment(bigint, text, jsonb, boolean) TO authenticated;

-- Add comment
COMMENT ON FUNCTION public.bulk_csv_import_enrollment IS 
'Bulk imports enrollments from CSV data. Supports email mode (direct enrollment) and SIS ID mode (enrollment or invitation). 
All manually imported enrollments are marked with sis_sync_opt_out = true. 
Existing enrollments are reactivated (disabled = false) and marked as manually managed.';
