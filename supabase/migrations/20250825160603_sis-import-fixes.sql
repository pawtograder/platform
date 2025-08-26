DROP FUNCTION admin_get_sis_sync_status();

-- Ensure partial unique indexes exist for ON CONFLICT targets
CREATE UNIQUE INDEX IF NOT EXISTS sis_sync_status_unique_course_section_partial
  ON public.sis_sync_status (course_id, course_section_id)
  WHERE course_section_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS sis_sync_status_unique_lab_section_partial
  ON public.sis_sync_status (course_id, lab_section_id)
  WHERE lab_section_id IS NOT NULL;

-- Fix admin_get_sis_sync_status function return type mismatch
-- The function declares term as text but classes.term is integer
CREATE OR REPLACE FUNCTION "public"."admin_get_sis_sync_status"() RETURNS TABLE("class_id" bigint, "class_name" "text", "term" integer, "sis_sections_count" bigint, "last_sync_time" timestamp with time zone, "last_sync_status" "text", "last_sync_message" "text", "sync_enabled" boolean, "total_invitations" bigint, "pending_invitations" bigint, "expired_invitations" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    RETURN QUERY
    SELECT 
        c.id as class_id,
        c.name as class_name,
        c.term,
        sync_summary.sis_sections_count,
        sync_summary.last_sync_time,
        sync_summary.last_sync_status,
        sync_summary.last_sync_message,
        COALESCE(sync_summary.sync_enabled, false) as sync_enabled,
        COALESCE(invite_stats.total_invitations, 0) as total_invitations,
        COALESCE(invite_stats.pending_invitations, 0) as pending_invitations,
        COALESCE(invite_stats.expired_invitations, 0) as expired_invitations
    FROM public.classes c
    LEFT JOIN (
        SELECT 
            invitations.class_id,
            COUNT(*) as total_invitations,
            COUNT(*) FILTER (WHERE invitations.status = 'pending') as pending_invitations,
            COUNT(*) FILTER (WHERE invitations.status = 'expired') as expired_invitations
        FROM public.invitations
        GROUP BY invitations.class_id
    ) invite_stats ON c.id = invite_stats.class_id
    LEFT JOIN (
        SELECT 
            sss.course_id,
            COUNT(*) as sis_sections_count,
            MAX(sss.last_sync_time) as last_sync_time,
            -- Get the most recent sync status (from the row with latest last_sync_time)
            (SELECT sss2.last_sync_status FROM public.sis_sync_status sss2 
             WHERE sss2.course_id = sss.course_id 
             ORDER BY sss2.last_sync_time DESC NULLS LAST 
             LIMIT 1) as last_sync_status,
            -- Get the most recent sync message
            (SELECT sss2.last_sync_message FROM public.sis_sync_status sss2 
             WHERE sss2.course_id = sss.course_id 
             ORDER BY sss2.last_sync_time DESC NULLS LAST 
             LIMIT 1) as last_sync_message,
            -- Class is sync enabled if ANY section has sync enabled AND class is not archived
            (BOOL_OR(sss.sync_enabled) AND NOT COALESCE(c_inner.archived, false)) as sync_enabled
        FROM public.sis_sync_status sss
        INNER JOIN public.classes c_inner ON c_inner.id = sss.course_id
        GROUP BY sss.course_id, c_inner.archived
    ) sync_summary ON c.id = sync_summary.course_id
    WHERE sync_summary.course_id IS NOT NULL  -- Only show classes that have SIS sync status records
    ORDER BY c.term DESC, c.name;
END;
$$;

-- Replace the existing admin-only SELECT policy with one that allows both admins and instructors
DROP POLICY IF EXISTS "Admin users can view all sync status" ON "public"."sis_sync_status";

CREATE POLICY "Admins and instructors can view sync status" ON "public"."sis_sync_status" 
FOR SELECT TO "authenticated" 
USING (
    "public"."authorize_for_admin"() OR 
    "public"."authorizeforclassinstructor"("course_id")
);

REVOKE ALL ON FUNCTION "public"."update_sis_sync_status"("p_course_id" bigint, "p_course_section_id" bigint, "p_lab_section_id" bigint, "p_sync_status" "text", "p_sync_message" "text") FROM "anon";
REVOKE ALL ON FUNCTION "public"."update_sis_sync_status"("p_course_id" bigint, "p_course_section_id" bigint, "p_lab_section_id" bigint, "p_sync_status" "text", "p_sync_message" "text") FROM "authenticated";
REVOKE ALL ON FUNCTION "public"."update_sis_sync_status"(bigint, bigint, bigint, "text", "text") FROM PUBLIC;

REVOKE ALL ON FUNCTION "public"."trigger_sis_sync"("p_class_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."trigger_sis_sync"("p_class_id" bigint) FROM "authenticated";

REVOKE ALL ON FUNCTION "public"."trigger_sis_sync"("p_class_id" bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.update_sis_sync_status(bigint, bigint, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.trigger_sis_sync(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_sis_sync_status(bigint, bigint, bigint, text, text) TO "postgres";
GRANT EXECUTE ON FUNCTION public.trigger_sis_sync(bigint) TO "postgres";


-- Fix update_sis_sync_status function bug for lab sections
-- The original function had flawed logic that prevented proper updates for lab sections
CREATE OR REPLACE FUNCTION "public"."update_sis_sync_status"("p_course_id" bigint, "p_course_section_id" bigint DEFAULT NULL::bigint, "p_lab_section_id" bigint DEFAULT NULL::bigint, "p_sync_status" "text" DEFAULT NULL::"text", "p_sync_message" "text" DEFAULT NULL::"text") RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
DECLARE
    v_status_id bigint;
BEGIN
    
    -- Validate that exactly one section ID is provided
    IF (p_course_section_id IS NULL AND p_lab_section_id IS NULL) OR 
       (p_course_section_id IS NOT NULL AND p_lab_section_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Exactly one of course_section_id or lab_section_id must be provided';
    END IF;

    -- Handle class sections
    IF p_course_section_id IS NOT NULL THEN
        INSERT INTO public.sis_sync_status (
            course_id,
            course_section_id,
            lab_section_id,
            last_sync_status,
            last_sync_time,
            last_sync_message,
            sync_enabled
        )
        VALUES (
            p_course_id,
            p_course_section_id,
            NULL, -- lab_section_id should be NULL for class sections
            p_sync_status,
            now(),
            p_sync_message,
            true
        )
        ON CONFLICT (course_id, course_section_id) WHERE course_section_id IS NOT NULL
        DO UPDATE SET
            last_sync_status = EXCLUDED.last_sync_status,
            last_sync_time = EXCLUDED.last_sync_time,
            last_sync_message = EXCLUDED.last_sync_message
        RETURNING id INTO v_status_id;
    END IF;

    -- Handle lab sections
    IF p_lab_section_id IS NOT NULL THEN
        INSERT INTO public.sis_sync_status (
            course_id,
            course_section_id,
            lab_section_id,
            last_sync_status,
            last_sync_time,
            last_sync_message,
            sync_enabled
        )
        VALUES (
            p_course_id,
            NULL, -- course_section_id should be NULL for lab sections
            p_lab_section_id,
            p_sync_status,
            now(),
            p_sync_message,
            true
        )
        ON CONFLICT (course_id, lab_section_id) WHERE lab_section_id IS NOT NULL
        DO UPDATE SET
            last_sync_status = EXCLUDED.last_sync_status,
            last_sync_time = EXCLUDED.last_sync_time,
            last_sync_message = EXCLUDED.last_sync_message
        RETURNING id INTO v_status_id;
    END IF;

    RETURN v_status_id;
END;
$$;

-- Create RPC function to create user role for existing user
-- This is used when importing SIS users who already exist in the system but aren't enrolled in the class
CREATE OR REPLACE FUNCTION "public"."create_user_role_for_existing_user"(
    "p_user_id" "uuid",
    "p_class_id" bigint,
    "p_role" "public"."app_role",
    "p_name" text,
    "p_sis_id" integer DEFAULT NULL
) RETURNS bigint
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
DECLARE
    v_user_role_id bigint;
    v_private_profile_id uuid;
    v_public_profile_id uuid;
    v_user_name text;
    v_user_email text;
    v_avatar_url text;
    v_public_name text;
    v_adjective text;
    v_noun text;
    v_number integer;
    v_secure_seed text;
BEGIN
    -- Check authorization - must be instructor of the class or admin
    IF NOT (authorize_for_admin() OR authorizeforclassinstructor(p_class_id)) THEN
        RAISE EXCEPTION 'Access denied: Instructor or admin role required';
    END IF;

    -- Check if user exists
    SELECT name, email INTO v_user_name, v_user_email
    FROM public.users 
    WHERE user_id = p_user_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User with ID % not found', p_user_id;
    END IF;
    
    -- Use provided name from CSV, fallback to user's name in database
    v_user_name := COALESCE(p_name, v_user_name, 'Unknown User');
    
    -- Check if user is already enrolled in this class
    IF EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = p_user_id AND class_id = p_class_id
    ) THEN
        RAISE EXCEPTION 'User is already enrolled in this class';
    END IF;
    
    -- Generate secure, non-PII seed for avatar URLs
    BEGIN
        -- Try to use pgcrypto for secure hash
        v_secure_seed := encode(digest(p_user_id::text || 'pawtograder_avatar_salt_2024', 'sha256'), 'hex');
    EXCEPTION
        WHEN undefined_function THEN
            -- Fallback if pgcrypto is not available
            v_secure_seed := md5(p_user_id::text || 'pawtograder_avatar_salt_2024');
    END;
    
    -- Determine avatar URL for private profile
    v_avatar_url := COALESCE(
        (SELECT avatar_url FROM public.users WHERE user_id = p_user_id),
        'https://api.dicebear.com/9.x/initials/svg?seed=' || v_secure_seed
    );
    
    -- Always create new private profile for each class enrollment
    INSERT INTO public.profiles (
        name, 
        avatar_url, 
        class_id, 
        is_private_profile
    )
    VALUES (
        v_user_name,
        v_avatar_url,
        p_class_id,
        true
    )
    RETURNING id INTO v_private_profile_id;
    
    -- Always create new public profile for each class enrollment
    -- Generate random name for public profile
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
    
    -- Create new public profile
    INSERT INTO public.profiles (
        name, 
        avatar_url, 
        class_id, 
        is_private_profile
    )
    VALUES (
        v_public_name,
        'https://api.dicebear.com/9.x/identicon/svg?seed=' || v_secure_seed,
        p_class_id,
        false
    )
    RETURNING id INTO v_public_profile_id;
    
    -- Create user role
    INSERT INTO public.user_roles (
        user_id,
        class_id,
        role,
        canvas_id,
        private_profile_id,
        public_profile_id,
        disabled
    )
    VALUES (
        p_user_id,
        p_class_id,
        p_role,
        p_sis_id,
        v_private_profile_id,
        v_public_profile_id,
        false
    )
    RETURNING id INTO v_user_role_id;
    
    RETURN v_user_role_id;
END;
$$;

-- Add updated_by column to invitations table
ALTER TABLE "public"."invitations" 
ADD COLUMN "updated_by" "uuid" REFERENCES "auth"."users"("id");

-- Update sync_lab_section_meetings function to delete existing meetings first
CREATE OR REPLACE FUNCTION "public"."sync_lab_section_meetings"("lab_section_id_param" bigint) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
DECLARE
    lab_section_record RECORD;
    class_record RECORD;
    target_day_num INTEGER;
    iter_date DATE;
    meeting_count INTEGER := 0;
BEGIN
    -- Get lab section details
    SELECT * INTO lab_section_record 
    FROM public.lab_sections 
    WHERE id = lab_section_id_param;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lab section with id % not found', lab_section_id_param;
    END IF;
    
    -- Get class dates
    SELECT * INTO class_record 
    FROM public.classes 
    WHERE id = lab_section_record.class_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Class with id % not found', lab_section_record.class_id;
    END IF;
    
    -- Skip if class doesn't have start/end dates set
    IF class_record.start_date IS NULL OR class_record.end_date IS NULL THEN
        RAISE EXCEPTION 'Class with id % does not have start/end dates set. So, it can not yet have lab sections.', lab_section_record.class_id;
    END IF;
    
    -- DELETE ALL EXISTING MEETINGS FOR THIS LAB SECTION
    DELETE FROM public.lab_section_meetings 
    WHERE lab_section_id = lab_section_id_param;
    
    -- Convert day_of_week enum to PostgreSQL day number (0=Sunday, 1=Monday, etc.)
    target_day_num := CASE lab_section_record.day_of_week
        WHEN 'sunday' THEN 0
        WHEN 'monday' THEN 1
        WHEN 'tuesday' THEN 2
        WHEN 'wednesday' THEN 3
        WHEN 'thursday' THEN 4
        WHEN 'friday' THEN 5
        WHEN 'saturday' THEN 6
    END;
    
    -- Find the first occurrence of the target day on or after start_date
    iter_date := class_record.start_date;
    WHILE EXTRACT(DOW FROM iter_date) != target_day_num LOOP
        iter_date := iter_date + INTERVAL '1 day';
    END LOOP;
    
    -- Create meetings for each occurrence of the target day
    WHILE iter_date <= class_record.end_date LOOP
        INSERT INTO public.lab_section_meetings (
            lab_section_id,
            meeting_date,
            class_id,
            cancelled
        ) VALUES (
            lab_section_id_param,
            iter_date,
            lab_section_record.class_id,
            false
        );
        
        meeting_count := meeting_count + 1;
        iter_date := iter_date + INTERVAL '7 days';
    END LOOP;
    
    RAISE NOTICE 'Recreated % lab section meetings for lab section %', meeting_count, lab_section_id_param;
END;
$$;

-- Create trigger function to handle lab section schedule changes
CREATE OR REPLACE FUNCTION "public"."handle_lab_section_schedule_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
BEGIN
    -- Only sync meetings if day_of_week changed
    IF (OLD.day_of_week IS DISTINCT FROM NEW.day_of_week) THEN
        
        -- Sync meetings after schedule change
        PERFORM public.sync_lab_section_meetings(NEW.id);
    END IF;
    
    RETURN NEW;
END;
$$;

-- Add UPDATE trigger for lab_sections to sync meetings when schedule changes
CREATE OR REPLACE TRIGGER "sync_lab_section_meetings_on_schedule_update" 
    AFTER UPDATE ON "public"."lab_sections" 
    FOR EACH ROW 
    EXECUTE FUNCTION "public"."handle_lab_section_schedule_update"();

-- Revoke all permissions from sync_lab_section_meetings function
REVOKE ALL ON FUNCTION "public"."sync_lab_section_meetings"("lab_section_id_param" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."sync_lab_section_meetings"("lab_section_id_param" bigint) FROM "authenticated";
REVOKE ALL ON FUNCTION "public"."sync_lab_section_meetings"("lab_section_id_param" bigint) FROM PUBLIC;

-- Grant execute permission only to postgres and service_role
GRANT EXECUTE ON FUNCTION "public"."sync_lab_section_meetings"("lab_section_id_param" bigint) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."sync_lab_section_meetings"("lab_section_id_param" bigint) TO "service_role";
