-- Fix create_invitation function to restore proper behavior from 20250826115031_sis-import-public-profile-name.sql
-- while adding the sis_managed parameter from 20250829174649_instructors-override-imports.sql

DROP FUNCTION IF EXISTS public.create_invitation(
  p_class_id bigint,
  p_role public.app_role,
  p_sis_user_id integer,
  p_email text,
  p_name text,
  p_invited_by uuid,
  p_class_section_id bigint,
  p_lab_section_id bigint,
  p_sis_managed boolean
);

CREATE OR REPLACE FUNCTION public.create_invitation(
  p_class_id bigint,
  p_role public.app_role,
  p_sis_user_id integer,
  p_email text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_invited_by uuid DEFAULT auth.uid(),
  p_class_section_id bigint DEFAULT NULL,
  p_lab_section_id bigint DEFAULT NULL,
  p_sis_managed boolean DEFAULT true
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_public_profile_id uuid;
    v_private_profile_id uuid;
    v_invitation_id bigint;
    v_display_name text;
    v_adjective text;
    v_noun text;
    v_number integer;
    v_public_name text;
    v_expires_at timestamp with time zone;
BEGIN
    -- Validate that the calling user is an instructor for this class or admin
    -- This function checks instructor role OR admin role globally, and respects disabled status
    IF NOT (public.authorizeforclassinstructor(p_class_id) OR public.authorize_for_admin()) THEN
        RAISE EXCEPTION 'Only instructors or admins can create invitations for this class';
    END IF;

    -- Check if invitation already exists
    IF EXISTS (
        SELECT 1 FROM public.invitations
        WHERE class_id = p_class_id AND sis_user_id = p_sis_user_id AND status = 'pending'
    ) THEN
        RAISE EXCEPTION 'Invitation already exists for this user in this class';
    END IF;

    -- Set display name for private profile (use provided name or email prefix)
    v_display_name := COALESCE(p_name, split_part(p_email, '@', 1), p_sis_user_id::text);

    -- Generate random name for public profile with collision resistance under (class_id, name) uniqueness
    -- Try up to 20 attempts with adjective-noun-number; on repeated collisions, append short-uuid-style suffix
    DECLARE
        v_attempts integer := 0;
        v_exists boolean := true;
    BEGIN
        WHILE v_attempts < 20 LOOP
            SELECT word INTO v_adjective
            FROM public.name_generation_words
            WHERE is_adjective = true
            ORDER BY random()
            LIMIT 1;

            SELECT word INTO v_noun
            FROM public.name_generation_words
            WHERE is_noun = true
            ORDER BY random()
            LIMIT 1;

            v_number := floor(random() * 1000)::integer;
            v_public_name := COALESCE(v_adjective, 'random') || '-' || COALESCE(v_noun, 'user') || '-' || v_number;

            SELECT EXISTS (
                SELECT 1 FROM public.profiles
                WHERE class_id = p_class_id AND name = v_public_name
            ) INTO v_exists;

            IF NOT v_exists THEN
                EXIT;
            END IF;

            v_attempts := v_attempts + 1;
        END LOOP;

        IF v_exists THEN
            -- Still colliding after retries: append short md5-based suffix to reduce collision probability drastically
            v_public_name := v_public_name || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);
        END IF;
    END;

    -- Create public profile with collision-resistant random name
    INSERT INTO public.profiles (
        name,
        class_id,
        is_private_profile
    ) VALUES (
        v_public_name,
        p_class_id,
        false
    ) RETURNING id INTO v_public_profile_id;

    -- Create private profile with actual name
    INSERT INTO public.profiles (
        name,
        class_id,
        is_private_profile
    ) VALUES (
        v_display_name,
        p_class_id,
        true
    ) RETURNING id INTO v_private_profile_id;

    -- Set expiration date (30 days from now)
    v_expires_at := NOW() + INTERVAL '30 days';

    -- Create invitation with sis_managed parameter
    INSERT INTO public.invitations (
        class_id,
        role,
        sis_user_id,
        email,
        name,
        public_profile_id,
        private_profile_id,
        invited_by,
        class_section_id,
        lab_section_id,
        sis_managed,
        status,
        expires_at,
        created_at,
        updated_at
    ) VALUES (
        p_class_id,
        p_role,
        p_sis_user_id,
        p_email,
        p_name,
        v_public_profile_id,
        v_private_profile_id,
        p_invited_by,
        p_class_section_id,
        p_lab_section_id,
        p_sis_managed,
        'pending',
        v_expires_at,
        NOW(),
        NOW()
    ) RETURNING id INTO v_invitation_id;

    RETURN v_invitation_id;
END;
$$;

-- Update the function comment to reflect both fixes
COMMENT ON FUNCTION public.create_invitation(
  p_class_id bigint,
  p_role public.app_role,
  p_sis_user_id integer,
  p_email text,
  p_name text,
  p_invited_by uuid,
  p_class_section_id bigint,
  p_lab_section_id bigint,
  p_sis_managed boolean
) IS 'Creates a course invitation with pre-created profiles for a user identified by sis_user_id. Public profiles get random names while private profiles use the actual user name. Supports sis_managed flag to control whether invitations can be expired by SIS sync.';
