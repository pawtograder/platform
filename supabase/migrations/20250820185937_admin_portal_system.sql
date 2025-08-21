-- Admin Portal System
-- Provides admin-only functions for class management, sections, and course settings

-- 1. Authorization helper function for admin users
CREATE OR REPLACE FUNCTION authorize_for_admin(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean AS $$
BEGIN
    -- Allow service role (for edge functions)
    IF auth.role() = 'service_role' THEN
        RETURN true;
    END IF;
    
    -- Check if user has admin role in any class
    RETURN EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p_user_id 
          AND ur.role = 'admin'
    );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- 2. Create a new class (admin only)
CREATE OR REPLACE FUNCTION admin_create_class(
    p_name text,
    p_term integer,
    p_description text DEFAULT NULL,
    p_github_org_name text DEFAULT NULL,
    p_github_template_prefix text DEFAULT NULL,
    p_created_by uuid DEFAULT auth.uid(),
    p_course_title text DEFAULT NULL,
    p_start_date date DEFAULT NULL,
    p_end_date date DEFAULT NULL
)
RETURNS bigint AS $$
DECLARE
    v_class_id bigint;
    v_public_profile_id uuid;
    v_private_profile_id uuid;
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_created_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Validate required fields
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Class name is required';
    END IF;
    
    IF p_term IS NULL THEN
        RAISE EXCEPTION 'Term is required';
    END IF;

    -- Insert new class
    INSERT INTO public.classes (
        name,
        term,
        description,
        github_org,
        slug,
        course_title,
        start_date,
        end_date,
        created_at
    ) VALUES (
        trim(p_name),
        p_term,
        p_description,
        p_github_org_name,
        p_github_template_prefix,
        p_course_title,
        p_start_date,
        p_end_date,
        now()
    ) RETURNING id INTO v_class_id;

    -- Create admin user role for the creator
    -- Create public profile
    INSERT INTO public.profiles (
        name,
        class_id,
        is_private_profile
    ) VALUES (
        (SELECT name FROM public.users WHERE user_id = p_created_by),
        v_class_id,
        false
    ) RETURNING id INTO v_public_profile_id;

    -- Create private profile
    INSERT INTO public.profiles (
        name,
        class_id,
        is_private_profile
    ) VALUES (
        (SELECT name FROM public.users WHERE user_id = p_created_by),
        v_class_id,
        true
    ) RETURNING id INTO v_private_profile_id;

    -- Create admin user role
    INSERT INTO public.user_roles (
        user_id,
        class_id,
        role,
        public_profile_id,
        private_profile_id
    ) VALUES (
        p_created_by,
        v_class_id,
        'admin',
        v_public_profile_id,
        v_private_profile_id
    );

    RETURN v_class_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Update class settings (admin only)
CREATE OR REPLACE FUNCTION admin_update_class(
    p_class_id bigint,
    p_name text DEFAULT NULL,
    p_term integer DEFAULT NULL,
    p_description text DEFAULT NULL,
    p_github_org_name text DEFAULT NULL,
    p_github_template_prefix text DEFAULT NULL,
    p_updated_by uuid DEFAULT auth.uid(),
    p_course_title text DEFAULT NULL,
    p_start_date date DEFAULT NULL,
    p_end_date date DEFAULT NULL
)
RETURNS boolean AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_updated_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Check if class exists
    IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = p_class_id) THEN
        RAISE EXCEPTION 'Class not found';
    END IF;

    -- Update only provided fields
    UPDATE public.classes SET
        name = COALESCE(trim(p_name), name),
        term = COALESCE(p_term, term),
        description = COALESCE(p_description, description),
        github_org = COALESCE(p_github_org_name, github_org),
        slug = COALESCE(p_github_template_prefix, slug),
        course_title = COALESCE(p_course_title, course_title),
        start_date = COALESCE(p_start_date, start_date),
        end_date = COALESCE(p_end_date, end_date)
    WHERE id = p_class_id;

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Delete class (admin only) - soft delete by setting archived
CREATE OR REPLACE FUNCTION admin_delete_class(
    p_class_id bigint,
    p_deleted_by uuid DEFAULT auth.uid()
)
RETURNS boolean AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_deleted_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Check if class exists
    IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = p_class_id) THEN
        RAISE EXCEPTION 'Class not found';
    END IF;

    -- Soft delete by setting archived (assuming this field exists, otherwise we can add it)
    UPDATE public.classes SET
        archived = true
    WHERE id = p_class_id;

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Get all classes for admin view
CREATE OR REPLACE FUNCTION admin_get_classes()
RETURNS TABLE (
    id bigint,
    name text,
    term integer,
    description text,
    github_org_name text,
    github_template_prefix text,
    created_at timestamptz,
    student_count bigint,
    instructor_count bigint,
    archived boolean
) AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    RETURN QUERY
    SELECT 
        c.id,
        c.name,
        c.term,
        c.description,
        c.github_org as github_org_name,
        c.slug as github_template_prefix,
        c.created_at,
        COALESCE(student_counts.student_count, 0) as student_count,
        COALESCE(instructor_counts.instructor_count, 0) as instructor_count,
        COALESCE(c.archived, false) as archived
    FROM public.classes c
    LEFT JOIN (
        SELECT class_id, COUNT(*) as student_count
        FROM public.user_roles
        WHERE role = 'student'
        GROUP BY class_id
    ) student_counts ON c.id = student_counts.class_id
    LEFT JOIN (
        SELECT class_id, COUNT(*) as instructor_count
        FROM public.user_roles
        WHERE role = 'instructor'
        GROUP BY class_id
    ) instructor_counts ON c.id = instructor_counts.class_id
    ORDER BY c.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Create class section with SIS metadata
CREATE OR REPLACE FUNCTION admin_create_class_section(
    p_class_id bigint,
    p_name text,
    p_created_by uuid DEFAULT auth.uid(),
    p_meeting_location text DEFAULT NULL,
    p_meeting_times text DEFAULT NULL,
    p_campus text DEFAULT NULL,
    p_sis_crn integer DEFAULT NULL
)
RETURNS bigint AS $$
DECLARE
    v_section_id bigint;
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_created_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Validate inputs
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Section name is required';
    END IF;

    -- Check if class exists
    IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = p_class_id) THEN
        RAISE EXCEPTION 'Class not found';
    END IF;

    -- Create class section
    INSERT INTO public.class_sections (
        name, 
        class_id, 
        meeting_location, 
        meeting_times, 
        campus,
        sis_crn, 
        created_at
    )
    VALUES (
        trim(p_name), 
        p_class_id, 
        p_meeting_location, 
        p_meeting_times, 
        p_campus,
        p_sis_crn, 
        now()
    )
    RETURNING id INTO v_section_id;

    -- Create initial SIS sync status record if SIS CRN is provided
    IF p_sis_crn IS NOT NULL THEN
        INSERT INTO public.sis_sync_status (
            course_id,
            course_section_id,
            last_sync_status,
            last_sync_message,
            sync_enabled
        )
        VALUES (
            p_class_id,
            v_section_id,
            'created',
            'Section created with SIS CRN - ready for sync',
            true
        );
    END IF;

    RETURN v_section_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Create lab section with SIS metadata
CREATE OR REPLACE FUNCTION admin_create_lab_section(
    p_class_id bigint,
    p_name text,
    p_created_by uuid DEFAULT auth.uid(),
    p_meeting_location text DEFAULT NULL,
    p_meeting_times text DEFAULT NULL,
    p_campus text DEFAULT NULL,
    p_sis_crn integer DEFAULT NULL,
    p_day_of_week public.day_of_week DEFAULT NULL,
    p_start_time time DEFAULT NULL,
    p_end_time time DEFAULT NULL,
    p_description text DEFAULT NULL
)
RETURNS bigint AS $$
DECLARE
    v_section_id bigint;
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_created_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Validate inputs
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Section name is required';
    END IF;

    -- Check if class exists
    IF NOT EXISTS (SELECT 1 FROM public.classes WHERE id = p_class_id) THEN
        RAISE EXCEPTION 'Class not found';
    END IF;

    -- Create lab section
    INSERT INTO public.lab_sections (
        name, 
        class_id, 
        meeting_location, 
        meeting_times, 
        campus,
        sis_crn,
        day_of_week,
        start_time,
        end_time,
        description,
        created_at
    )
    VALUES (
        trim(p_name), 
        p_class_id, 
        p_meeting_location, 
        p_meeting_times, 
        p_campus,
        p_sis_crn,
        p_day_of_week,
        p_start_time,
        p_end_time,
        p_description,
        now()
    )
    RETURNING id INTO v_section_id;

    -- Create initial SIS sync status record if SIS CRN is provided
    IF p_sis_crn IS NOT NULL THEN
        INSERT INTO public.sis_sync_status (
            course_id,
            lab_section_id,
            last_sync_status,
            last_sync_message,
            sync_enabled
        )
        VALUES (
            p_class_id,
            v_section_id,
            'created',
            'Lab section created with SIS CRN - ready for sync',
            true
        );
    END IF;

    RETURN v_section_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. Update class section
CREATE OR REPLACE FUNCTION admin_update_class_section(
    p_section_id bigint,
    p_name text,
    p_updated_by uuid DEFAULT auth.uid()
)
RETURNS boolean AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_updated_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Validate inputs
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Section name is required';
    END IF;

    -- Update class section
    UPDATE public.class_sections SET
        name = trim(p_name),
        updated_at = now()
    WHERE id = p_section_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Update lab section
CREATE OR REPLACE FUNCTION admin_update_lab_section(
    p_section_id bigint,
    p_name text,
    p_updated_by uuid DEFAULT auth.uid()
)
RETURNS boolean AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_updated_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Validate inputs
    IF p_name IS NULL OR trim(p_name) = '' THEN
        RAISE EXCEPTION 'Section name is required';
    END IF;

    -- Update lab section
    UPDATE public.lab_sections SET
        name = trim(p_name),
        updated_at = now()
    WHERE id = p_section_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. Delete class section
CREATE OR REPLACE FUNCTION admin_delete_class_section(
    p_section_id bigint,
    p_deleted_by uuid DEFAULT auth.uid()
)
RETURNS boolean AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_deleted_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Delete class section (cascade should handle related records)
    DELETE FROM public.class_sections WHERE id = p_section_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 11. Delete lab section
CREATE OR REPLACE FUNCTION admin_delete_lab_section(
    p_section_id bigint,
    p_deleted_by uuid DEFAULT auth.uid()
)
RETURNS boolean AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_deleted_by) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Delete lab section (cascade should handle related records)
    DELETE FROM public.lab_sections WHERE id = p_section_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12. Get class sections and lab sections for a class with SIS metadata
CREATE OR REPLACE FUNCTION admin_get_class_sections(p_class_id bigint)
RETURNS TABLE (
    section_id bigint,
    section_name text,
    section_type text,
    meeting_location text,
    meeting_times text,
    campus text,
    sis_crn integer,
    created_at timestamptz,
    updated_at timestamptz,
    member_count bigint
) AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    RETURN QUERY
    -- Class sections
    SELECT 
        cs.id as section_id,
        cs.name as section_name,
        'class' as section_type,
        cs.meeting_location,
        cs.meeting_times,
        cs.campus,
        cs.sis_crn,
        cs.created_at,
        cs.updated_at,
        COALESCE(cs_counts.member_count, 0) as member_count
    FROM public.class_sections cs
    LEFT JOIN (
        SELECT class_section_id, COUNT(*) as member_count
        FROM public.user_roles
        WHERE class_section_id IS NOT NULL
        GROUP BY class_section_id
    ) cs_counts ON cs.id = cs_counts.class_section_id
    WHERE cs.class_id = p_class_id
    
    UNION ALL
    
    -- Lab sections
    SELECT 
        ls.id as section_id,
        ls.name as section_name,
        'lab' as section_type,
        ls.meeting_location,
        ls.meeting_times,
        ls.campus,
        ls.sis_crn,
        ls.created_at,
        ls.updated_at,
        COALESCE(ls_counts.member_count, 0) as member_count
    FROM public.lab_sections ls
    LEFT JOIN (
        SELECT lab_section_id, COUNT(*) as member_count
        FROM public.user_roles
        WHERE lab_section_id IS NOT NULL
        GROUP BY lab_section_id
    ) ls_counts ON ls.id = ls_counts.lab_section_id
    WHERE ls.class_id = p_class_id
    
    ORDER BY section_type, section_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 13. Add metadata columns for SIS import functionality

-- Add archived column to classes table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'classes' AND column_name = 'archived') THEN
        ALTER TABLE public.classes ADD COLUMN archived boolean DEFAULT false;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'classes' AND column_name = 'time_zone'
    ) THEN
        ALTER TABLE public.classes ALTER COLUMN time_zone SET DEFAULT 'America/New_York';
    END IF;
END $$;


-- Add description column to classes table if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'classes' AND column_name = 'description') THEN
        ALTER TABLE public.classes ADD COLUMN description text;
    END IF;
END $$;


-- Add SIS metadata columns to classes table
DO $$
BEGIN
    -- Add course_title column if it doesn't exist (separate from name which might be course code)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'classes' AND column_name = 'course_title') THEN
        ALTER TABLE public.classes ADD COLUMN course_title text;
    END IF;

    -- Rename semester to term if semester column exists
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'classes' AND column_name = 'semester') THEN
        ALTER TABLE public.classes RENAME COLUMN semester TO term;
    END IF;
    
    -- Remove year column if it exists (using Banner term codes instead)
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'classes' AND column_name = 'year') THEN
        ALTER TABLE public.classes DROP COLUMN year;
    END IF;
    
    -- Ensure term column is integer type (not smallint) to handle Banner codes like 202410
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'classes' AND column_name = 'term') THEN
        ALTER TABLE public.classes ALTER COLUMN term TYPE integer USING term::integer;
    ELSE
        ALTER TABLE public.classes ADD COLUMN term integer;
    END IF;
END $$;


-- Add SIS metadata columns to class_sections table
DO $$
BEGIN
    -- Add meeting_location column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'class_sections' AND column_name = 'meeting_location') THEN
        ALTER TABLE public.class_sections ADD COLUMN meeting_location text;
    END IF;
    
    -- Add meeting_times column if it doesn't exist (raw SIS format like "TF 9:50a-11:30a")
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'class_sections' AND column_name = 'meeting_times') THEN
        ALTER TABLE public.class_sections ADD COLUMN meeting_times text;
    END IF;
    
    -- Add campus column to class_sections (can vary by section)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'class_sections' AND column_name = 'campus') THEN
        ALTER TABLE public.class_sections ADD COLUMN campus text;
    END IF;
    
    -- Add sis_crn column to track original CRN from SIS
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'class_sections' AND column_name = 'sis_crn') THEN
        ALTER TABLE public.class_sections ADD COLUMN sis_crn integer;
    END IF;
END $$;

-- Add SIS metadata columns to lab_sections table
DO $$
BEGIN
    -- Add meeting_location column if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lab_sections' AND column_name = 'meeting_location') THEN
        ALTER TABLE public.lab_sections ADD COLUMN meeting_location text;
    END IF;
    
    -- Add meeting_times column if it doesn't exist (raw SIS format, in addition to structured day/time)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lab_sections' AND column_name = 'meeting_times') THEN
        ALTER TABLE public.lab_sections ADD COLUMN meeting_times text;
    END IF;
    
    -- Add campus column to lab_sections (can vary by section)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lab_sections' AND column_name = 'campus') THEN
        ALTER TABLE public.lab_sections ADD COLUMN campus text;
    END IF;
    
    -- Add sis_crn column to track original CRN from SIS
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lab_sections' AND column_name = 'sis_crn') THEN
        ALTER TABLE public.lab_sections ADD COLUMN sis_crn integer;
    END IF;
    
    -- Make lab_leader_id nullable for SIS imports (we might not know the leader initially)
    ALTER TABLE public.lab_sections ALTER COLUMN lab_leader_id DROP NOT NULL;
    
    -- Make day_of_week, start_time nullable for SIS imports (structured data optional)
    ALTER TABLE public.lab_sections ALTER COLUMN day_of_week DROP NOT NULL;
    ALTER TABLE public.lab_sections ALTER COLUMN start_time DROP NOT NULL;
END $$;

-- 14. Add disabled column to user_roles table for account suspension/deactivation
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'user_roles' AND column_name = 'disabled') THEN
        ALTER TABLE public.user_roles ADD COLUMN disabled boolean DEFAULT false NOT NULL;
    END IF;
END $$;

-- 15. Update all authorization functions to respect disabled status
-- Performance optimized: use EXISTS instead of COUNT(*) for faster execution

-- Update authorizeforclass function (checks for ANY role in class)
CREATE OR REPLACE FUNCTION "public"."authorizeforclass"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- First check if user is an admin anywhere - admins have global access
  if exists (
    select 1
    from public.user_roles as r
    where r.user_id = auth.uid() 
      and r.role = 'admin' 
      and r.disabled = false
  ) then
    return true;
  end if;

  -- Otherwise, check for specific role in this class
  return exists (
    select 1
    from public.user_roles as r
    where r.class_id = class__id 
      and r.user_id = auth.uid() 
      and r.disabled = false
  );
end;
$$;

-- Update authorizeforclassinstructor function (checks for instructor role specifically)
CREATE OR REPLACE FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
    RAISE NOTICE 'authorizeforclassinstructor called with class_id: %, user_id: %', class__id, auth.uid();
  -- First check if user is an admin anywhere - admins have global access
  if exists (
    select 1
    from public.user_roles as r
    where r.user_id = auth.uid() 
      and r.role = 'admin' 
      and r.disabled = false
  ) then
    return true;
  end if;

  -- Otherwise, check for instructor role in this specific class
  return exists (
    select 1
    from public.user_roles as r
    where r.class_id = class__id 
      and r.user_id = auth.uid() 
      and r.role = 'instructor'
      and r.disabled = false
  );
end;
$$;

-- Update authorizeforclassgrader function (checks for instructor OR grader role)
CREATE OR REPLACE FUNCTION "public"."authorizeforclassgrader"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- First check if user is an admin anywhere - admins have global access
  if exists (
    select 1
    from public.user_roles as r
    where r.user_id = auth.uid() 
      and r.role = 'admin' 
      and r.disabled = false
  ) then
    return true;
  end if;

  -- Otherwise, check for instructor or grader role in this specific class
  return exists (
    select 1
    from public.user_roles as r
    where r.class_id = class__id 
      and r.user_id = auth.uid() 
      and r.role in ('instructor', 'grader')
      and r.disabled = false
  );
end;
$$;

-- Update authorizeforprofile function (checks profile access)
CREATE OR REPLACE FUNCTION "public"."authorizeforprofile"("profile_id" uuid) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- First check if user is an admin anywhere - admins have global access
  if exists (
    select 1
    from public.user_roles as r
    where r.user_id = auth.uid() 
      and r.role = 'admin' 
      and r.disabled = false
  ) then
    return true;
  end if;

  -- Otherwise, check if user owns this specific profile and is not disabled
  return exists (
    select 1
    from public.user_roles as r
    where (r.public_profile_id = profile_id OR r.private_profile_id = profile_id) 
      and r.user_id = auth.uid()
      and r.disabled = false
  );
end;
$$;

-- Update authorize_for_submission function (checks submission ownership) 
CREATE OR REPLACE FUNCTION "public"."authorize_for_submission"("requested_submission_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- First check if user is an admin anywhere - admins have global access
  if exists (
    select 1
    from public.user_roles as r
    where r.user_id = auth.uid() 
      and r.role = 'admin' 
      and r.disabled = false
  ) then
    return true;
  end if;

  -- Check for direct ownership (user not disabled)
  if exists (
    select 1
    from public.submissions as s
    inner join public.user_roles as r on r.private_profile_id = s.profile_id
    where r.user_id = auth.uid() 
      and s.id = requested_submission_id
      and r.disabled = false
  ) then
    return true;
  end if;
  
  -- Check through assignment groups (user not disabled)
  return exists (
    select 1
    from public.submissions as s
    inner join public.assignment_groups_members mem on mem.assignment_group_id = s.assignment_group_id
    inner join public.user_roles as r on r.private_profile_id = mem.profile_id
    where r.user_id = auth.uid() 
      and s.id = requested_submission_id
      and r.disabled = false
  );
end;
$$;

-- Update other authorization functions that use user_roles
CREATE OR REPLACE FUNCTION "public"."authorizeforinstructorofstudent"("_user_id" uuid) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- First check if user is an admin anywhere - admins have global access
  if exists (
    select 1
    from public.user_roles as r
    where r.user_id = auth.uid() 
      and r.role = 'admin' 
      and r.disabled = false
  ) then
    return true;
  end if;

  -- Otherwise, check if current user is instructor of any class that the target user is enrolled in
  return exists (
    select 1
    from public.user_roles student_role
    inner join public.user_roles instructor_role on instructor_role.class_id = student_role.class_id
    where student_role.user_id = _user_id
      and instructor_role.user_id = auth.uid()
      and instructor_role.role = 'instructor'
      and instructor_role.disabled = false
  );
end;
$$;

CREATE OR REPLACE FUNCTION "public"."authorizeforinstructororgraderofstudent"("_user_id" uuid) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
  -- First check if user is an admin anywhere - admins have global access
  if exists (
    select 1
    from public.user_roles as r
    where r.user_id = auth.uid() 
      and r.role = 'admin' 
      and r.disabled = false
  ) then
    return true;
  end if;

  -- Otherwise, check if current user is instructor or grader of any class that the target user is enrolled in
  return exists (
    select 1
    from public.user_roles student_role
    inner join public.user_roles staff_role on staff_role.class_id = student_role.class_id
    where student_role.user_id = _user_id
      and staff_role.user_id = auth.uid()
      and staff_role.role in ('instructor', 'grader')
      and staff_role.disabled = false
  );
end;
$$;

-- Update authorize_for_admin function to check disabled status and allow service role
CREATE OR REPLACE FUNCTION authorize_for_admin(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean AS $$
BEGIN
    -- Allow service role (for edge functions)
    IF auth.role() = 'service_role' THEN
        RETURN true;
    END IF;
    
    -- Check if user has admin role in any class and is not disabled
    RETURN EXISTS (
        SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = p_user_id 
          AND ur.role = 'admin'
          AND ur.disabled = false
    );
END;
$$ LANGUAGE plpgsql SECURITY INVOKER;

-- Add function to enable/disable user roles (admin only)
CREATE OR REPLACE FUNCTION admin_set_user_role_disabled(
    p_user_role_id bigint,
    p_disabled boolean,
    p_admin_user_id uuid DEFAULT auth.uid()
)
RETURNS boolean AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_admin_user_id) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Update disabled status
    UPDATE public.user_roles SET
        disabled = p_disabled,
        updated_at = now()
    WHERE id = p_user_role_id;

    RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 16. Performance optimization: Create composite indexes that include disabled column
-- Analysis of query patterns and index optimization recommendations:

-- CRITICAL PERFORMANCE INDEXES (for authorization functions):
-- These cover the most frequent query patterns with optimal column ordering

-- 1. Primary authorization pattern: (user_id, class_id, disabled)
-- Covers: authorizeforclass, authorizeforclassinstructor, authorizeforclassgrader
-- This is the most frequent pattern - user checking access to a specific class
CREATE INDEX IF NOT EXISTS idx_user_roles_auth_primary ON public.user_roles (user_id, class_id, disabled);

-- 2. Role-specific authorization: (user_id, class_id, role, disabled) 
-- Covers: authorizeforclassinstructor, authorizeforclassgrader with role filtering
-- Extends primary pattern with role for more specific queries
CREATE INDEX IF NOT EXISTS idx_user_roles_auth_role ON public.user_roles (user_id, class_id, role, disabled);

-- 3. Profile-based authorization: (private_profile_id, user_id, disabled)
-- Covers: authorizeforprofile, submission access checks
-- Private profiles are used more frequently than public ones
CREATE INDEX IF NOT EXISTS idx_user_roles_auth_private_profile ON public.user_roles (private_profile_id, user_id, disabled);

-- OPTIMIZATION RECOMMENDATIONS:

-- 4. Partial index for active users (WHERE disabled = false)
-- This covers 99%+ of queries efficiently since most users are active
-- Significantly smaller than full index, faster to scan
CREATE INDEX IF NOT EXISTS idx_user_roles_active_primary ON public.user_roles (user_id, class_id) WHERE disabled = false;
CREATE INDEX IF NOT EXISTS idx_user_roles_active_role ON public.user_roles (user_id, class_id, role) WHERE disabled = false;

-- 5. Class-level queries for enrollment management
-- Supports queries like "get all students in class" efficiently
CREATE INDEX IF NOT EXISTS idx_user_roles_class_role_active ON public.user_roles (class_id, role) WHERE disabled = false;

-- 6. Admin management queries
-- Replace the old admin index with disabled-aware version
DROP INDEX IF EXISTS idx_user_roles_admin_role;
CREATE INDEX IF NOT EXISTS idx_user_roles_admin_active ON public.user_roles (user_id) WHERE role = 'admin' AND disabled = false;

-- 7. Disabled user management (for admin portal)
-- Supports queries to find/manage disabled users
CREATE INDEX IF NOT EXISTS idx_user_roles_disabled_mgmt ON public.user_roles (disabled, class_id) WHERE disabled = true;

-- EXISTING INDEX ANALYSIS & RECOMMENDATIONS:
-- Current indices that may now be partially redundant but kept for backward compatibility:
-- - idx_user_roles_user_id: Still useful for non-class-specific queries
-- - idx_user_roles_class_id: Still useful for class-wide operations  
-- - user_roles_class_id_role_idx: Partially overlapped by idx_user_roles_class_role_active but kept for disabled users
-- - idx_user_roles_role_class_profile: Useful for gradebook queries, not touched

-- FUTURE OPTIMIZATION OPPORTUNITIES:
-- Consider dropping these indices if performance testing shows they're unused:
-- - idx_user_roles_class_section_id (low usage, sections are relatively small)
-- - idx_user_roles_public_profile_id (public profiles used less frequently)
-- These can be re-added if specific queries need them.

-- Add indexes for SIS metadata columns for fast lookups
CREATE INDEX IF NOT EXISTS idx_class_sections_sis_crn ON public.class_sections (sis_crn) WHERE sis_crn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lab_sections_sis_crn ON public.lab_sections (sis_crn) WHERE sis_crn IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_class_sections_campus ON public.class_sections (campus) WHERE campus IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lab_sections_campus ON public.lab_sections (campus) WHERE campus IS NOT NULL;

-- Add index for archived classes
CREATE INDEX IF NOT EXISTS idx_classes_archived ON public.classes (archived) WHERE archived = true;

-- Add critical indexes for invitation processing performance
-- Index for users table on sis_user_id (used in invitation creation to check existing users)
CREATE INDEX IF NOT EXISTS idx_users_sis_user_id ON public.users (sis_user_id) WHERE sis_user_id IS NOT NULL;

-- Composite index for invitations table (used to check for existing pending invitations)
-- Order: class_id, sis_user_id, status - optimized for the most common query pattern
CREATE INDEX IF NOT EXISTS idx_invitations_class_sis_status ON public.invitations (class_id, sis_user_id, status);

-- Additional index for invitations by sis_user_id for user lookups across classes
CREATE INDEX IF NOT EXISTS idx_invitations_sis_user_id ON public.invitations (sis_user_id) WHERE sis_user_id IS NOT NULL;

-- 17. Update existing RLS policies and functions to respect disabled status and admin global access
-- Update invitation RLS policies
DROP POLICY IF EXISTS "Users can view invitations for classes they belong to" ON "public"."invitations";
DROP POLICY IF EXISTS "Instructors can manage invitations for their classes" ON "public"."invitations";

CREATE POLICY "Users can view invitations for classes they belong to" ON "public"."invitations"
  FOR SELECT USING (
    -- Admins can view all invitations
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'admin'
        AND ur.disabled = false
    )
    OR
    -- Non-admins need instructor/grader role in the specific class
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.class_id = invitations.class_id
        AND ur.role IN ('instructor', 'grader')
        AND ur.disabled = false
    )
  );

CREATE POLICY "Instructors can manage invitations for their classes" ON "public"."invitations"
  FOR ALL USING (
    -- Admins can manage all invitations
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role = 'admin'
        AND ur.disabled = false
    )
    OR
    -- Non-admins need instructor role in the specific class
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.class_id = invitations.class_id
        AND ur.role = 'instructor'
        AND ur.disabled = false
    )
  );



-- Update function ownership
ALTER FUNCTION "public"."authorizeforclass"("class__id" bigint) OWNER TO "postgres";
ALTER FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) OWNER TO "postgres";
ALTER FUNCTION "public"."authorizeforclassgrader"("class__id" bigint) OWNER TO "postgres";
ALTER FUNCTION "public"."authorizeforprofile"("profile_id" uuid) OWNER TO "postgres";
ALTER FUNCTION "public"."authorize_for_submission"("requested_submission_id" bigint) OWNER TO "postgres";
ALTER FUNCTION "public"."authorizeforinstructorofstudent"("_user_id" uuid) OWNER TO "postgres";
ALTER FUNCTION "public"."authorizeforinstructororgraderofstudent"("_user_id" uuid) OWNER TO "postgres";

-- 18. Update invitation trigger to respect disabled status when converting to enrollments
-- Note: New enrollments from invitations start as disabled=false (active) and use sis_user_id for canvas_sync_id
CREATE OR REPLACE FUNCTION handle_user_sis_id_update()
RETURNS TRIGGER AS $$
BEGIN
    -- Only proceed if sis_user_id was just set (was NULL, now has value)
    IF OLD.sis_user_id IS NULL AND NEW.sis_user_id IS NOT NULL THEN
        -- Find any pending invitations for this sis_user_id
        INSERT INTO public.user_roles (
            user_id,
            class_id,
            role,
            public_profile_id,
            private_profile_id,
            invitation_id,
            class_section_id,
            lab_section_id,
            disabled,  -- New enrollments start as active (disabled=false)
            canvas_id  -- Use sis_user_id as canvas_sync_id for tracking SIS origin
        )
        SELECT 
            NEW.user_id,
            i.class_id,
            i.role,
            i.public_profile_id,
            i.private_profile_id,
            i.id,
            i.class_section_id,
            i.lab_section_id,
            false,  -- Start as active user
            NEW.sis_user_id::numeric  -- Store SIS ID as canvas_id for sync tracking
        FROM public.invitations i
        WHERE i.sis_user_id = NEW.sis_user_id 
          AND i.status = 'pending'
          AND (i.expires_at IS NULL OR i.expires_at > NOW())
        ON CONFLICT (user_id, class_id) DO UPDATE SET
            role = CASE 
                WHEN EXCLUDED.role = 'instructor' THEN 'instructor'
                WHEN EXCLUDED.role = 'grader' AND user_roles.role != 'instructor' THEN 'grader'
                ELSE user_roles.role
            END,
            invitation_id = EXCLUDED.invitation_id,
            class_section_id = EXCLUDED.class_section_id,
            lab_section_id = EXCLUDED.lab_section_id,
            disabled = false,  -- Ensure reactivated if was disabled
            canvas_id = EXCLUDED.canvas_id;  -- Update sync tracking ID

        -- Mark invitations as accepted
        UPDATE public.invitations 
        SET status = 'accepted', 
            accepted_at = NOW(),
            updated_at = NOW()
        WHERE sis_user_id = NEW.sis_user_id 
          AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > NOW());
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 19. Add admin functions for managing disabled users
CREATE OR REPLACE FUNCTION admin_get_disabled_users(p_class_id bigint DEFAULT NULL)
RETURNS TABLE (
    user_role_id bigint,
    user_id uuid,
    class_id bigint,
    class_name text,
    user_name text,
    user_email text,
    role public.app_role,
    disabled_at timestamptz,
    profile_name text
) AS $$
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin() THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    RETURN QUERY
    SELECT 
        ur.id as user_role_id,
        ur.user_id,
        ur.class_id,
        c.name as class_name,
        u.name as user_name,
        u.email as user_email,
        ur.role,
        ur.updated_at as disabled_at,  -- When disabled was last changed
        p.name as profile_name
    FROM public.user_roles ur
    JOIN public.users u ON ur.user_id = u.user_id
    JOIN public.classes c ON ur.class_id = c.id
    LEFT JOIN public.profiles p ON ur.private_profile_id = p.id
    WHERE ur.disabled = true
      AND (p_class_id IS NULL OR ur.class_id = p_class_id)
    ORDER BY ur.updated_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 20. Add bulk disable/enable functions for admins
CREATE OR REPLACE FUNCTION admin_bulk_set_user_roles_disabled(
    p_user_role_ids bigint[],
    p_disabled boolean,
    p_admin_user_id uuid DEFAULT auth.uid()
)
RETURNS integer AS $$
DECLARE
    v_updated_count integer;
BEGIN
    -- Check admin authorization
    IF NOT authorize_for_admin(p_admin_user_id) THEN
        RAISE EXCEPTION 'Access denied: Admin role required';
    END IF;

    -- Update disabled status for all specified user roles
    UPDATE public.user_roles SET
        disabled = p_disabled,
        updated_at = now()
    WHERE id = ANY(p_user_role_ids);

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    RETURN v_updated_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Comments for documentation (added after all functions are created)
COMMENT ON FUNCTION authorize_for_admin IS 'Checks if the current user has admin role in any class and is not disabled';
COMMENT ON FUNCTION authorizeforclass IS 'Checks if user has access to class. Admins have global access, others need specific role in class and must not be disabled.';
COMMENT ON FUNCTION authorizeforclassinstructor IS 'Checks if user has instructor access to class. Admins have global access, others need instructor role in class and must not be disabled.';
COMMENT ON FUNCTION authorizeforclassgrader IS 'Checks if user has instructor/grader access to class. Admins have global access, others need instructor/grader role in class and must not be disabled.';
COMMENT ON FUNCTION authorizeforprofile IS 'Checks if user can access profile. Admins have global access, others need to own the profile and must not be disabled.';
COMMENT ON FUNCTION authorize_for_submission IS 'Checks if user can access submission. Admins have global access, others need ownership/group membership and must not be disabled.';
COMMENT ON FUNCTION admin_create_class IS 'Creates a new class with admin-only access';
COMMENT ON FUNCTION admin_update_class IS 'Updates class settings with admin-only access';
COMMENT ON FUNCTION admin_delete_class IS 'Soft deletes a class by setting archived flag';
COMMENT ON FUNCTION admin_get_classes IS 'Gets all classes with enrollment statistics for admin view';
COMMENT ON FUNCTION admin_create_class_section IS 'Creates a class section with admin-only access';
COMMENT ON FUNCTION admin_create_lab_section IS 'Creates a lab section with admin-only access';
COMMENT ON FUNCTION admin_get_class_sections IS 'Gets all sections for a class with member counts';
COMMENT ON FUNCTION admin_set_user_role_disabled IS 'Allows admins to enable/disable user roles';
COMMENT ON FUNCTION admin_get_disabled_users IS 'Lists all disabled users for admin management';
COMMENT ON FUNCTION admin_bulk_set_user_roles_disabled IS 'Bulk enable/disable user roles for admin efficiency';
COMMENT ON COLUMN public.user_roles.disabled IS 'When true, user role is suspended and cannot access class resources. Admins with active admin roles bypass this restriction.';
