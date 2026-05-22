-- Redefine the invitation/enrollment functions to their final form for #322 and #390:
--   * No invitation expires_at / time-based expiry anywhere.
--   * status 'expired' is renamed to 'dropped' (drop-from-roster) throughout.
--   * Every code path that materialises an enrollment reuses the existing
--     (user, class) profile pair instead of minting a new one, so a student can
--     never end up with two profiles (two gradebook rows) in one class. This is
--     backed by idx_user_roles_one_active_per_class.

-- =============================================================================
-- create_invitation: no expires_at; reuse an already-enrolled user's profiles.
-- =============================================================================
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
BEGIN
    IF NOT (public.authorizeforclassinstructor(p_class_id) OR public.authorize_for_admin()) THEN
        RAISE EXCEPTION 'Only instructors or admins can create invitations for this class';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.invitations
        WHERE class_id = p_class_id AND sis_user_id = p_sis_user_id AND status = 'pending'
    ) THEN
        RAISE EXCEPTION 'Invitation already exists for this user in this class';
    END IF;

    v_display_name := COALESCE(p_name, split_part(p_email, '@', 1), p_sis_user_id::text);

    -- If this SIS user is already enrolled in the class, reuse that enrollment's
    -- profile pair so the invitation does not create a duplicate profile (#390).
    SELECT ur.public_profile_id, ur.private_profile_id
      INTO v_public_profile_id, v_private_profile_id
    FROM public.user_roles ur
    JOIN public.users u ON u.user_id = ur.user_id
    WHERE u.sis_user_id = p_sis_user_id
      AND ur.class_id = p_class_id
    LIMIT 1;

    IF v_private_profile_id IS NULL THEN
        -- Generate a collision-resistant random name for the public profile.
        DECLARE
            v_attempts integer := 0;
            v_exists boolean := true;
        BEGIN
            WHILE v_attempts < 20 LOOP
                SELECT word INTO v_adjective FROM public.name_generation_words
                WHERE is_adjective = true ORDER BY random() LIMIT 1;
                SELECT word INTO v_noun FROM public.name_generation_words
                WHERE is_noun = true ORDER BY random() LIMIT 1;
                v_number := floor(random() * 1000)::integer;
                v_public_name := COALESCE(v_adjective, 'random') || '-' || COALESCE(v_noun, 'user') || '-' || v_number;
                SELECT EXISTS (
                    SELECT 1 FROM public.profiles WHERE class_id = p_class_id AND name = v_public_name
                ) INTO v_exists;
                IF NOT v_exists THEN EXIT; END IF;
                v_attempts := v_attempts + 1;
            END LOOP;
            IF v_exists THEN
                v_public_name := v_public_name || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 6);
            END IF;
        END;

        INSERT INTO public.profiles (name, class_id, is_private_profile)
        VALUES (v_public_name, p_class_id, false)
        RETURNING id INTO v_public_profile_id;

        INSERT INTO public.profiles (name, class_id, is_private_profile)
        VALUES (v_display_name, p_class_id, true)
        RETURNING id INTO v_private_profile_id;
    END IF;

    INSERT INTO public.invitations (
        class_id, role, sis_user_id, email, name,
        public_profile_id, private_profile_id, invited_by,
        class_section_id, lab_section_id, sis_managed, status,
        created_at, updated_at
    ) VALUES (
        p_class_id, p_role, p_sis_user_id, p_email, p_name,
        v_public_profile_id, v_private_profile_id, p_invited_by,
        p_class_section_id, p_lab_section_id, p_sis_managed, 'pending',
        NOW(), NOW()
    ) RETURNING id INTO v_invitation_id;

    RETURN v_invitation_id;
END;
$$;

-- =============================================================================
-- create_user_role_for_existing_user: reuse the existing (user, class)
-- enrollment + profiles if present (reactivating it) instead of creating a
-- second profile pair.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.create_user_role_for_existing_user(
    p_user_id uuid,
    p_class_id bigint,
    p_role public.app_role,
    p_name text,
    p_sis_id integer DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_user_role_id bigint;
    v_existing_role_id bigint;
    v_private_profile_id uuid;
    v_public_profile_id uuid;
    v_user_name text;
    v_avatar_url text;
    v_public_name text;
    v_adjective text;
    v_noun text;
    v_number integer;
    v_secure_seed text;
BEGIN
    IF NOT (authorize_for_admin() OR authorizeforclassinstructor(p_class_id)) THEN
        RAISE EXCEPTION 'Access denied: Instructor or admin role required';
    END IF;

    SELECT name INTO v_user_name FROM public.users WHERE user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User with ID % not found', p_user_id;
    END IF;
    v_user_name := COALESCE(p_name, v_user_name, 'Unknown User');

    -- Reuse an existing enrollment for this (user, class) rather than creating a
    -- duplicate profile pair (#390). Reactivate it if it was disabled.
    SELECT id INTO v_existing_role_id
    FROM public.user_roles
    WHERE user_id = p_user_id AND class_id = p_class_id
    LIMIT 1;

    IF v_existing_role_id IS NOT NULL THEN
        UPDATE public.user_roles SET disabled = false WHERE id = v_existing_role_id;
        RETURN v_existing_role_id;
    END IF;

    BEGIN
        v_secure_seed := encode(digest(p_user_id::text || 'pawtograder_avatar_salt_2024', 'sha256'), 'hex');
    EXCEPTION WHEN undefined_function THEN
        v_secure_seed := md5(p_user_id::text || 'pawtograder_avatar_salt_2024');
    END;

    v_avatar_url := COALESCE(
        (SELECT avatar_url FROM public.users WHERE user_id = p_user_id),
        'https://api.dicebear.com/9.x/initials/svg?seed=' || v_secure_seed
    );

    INSERT INTO public.profiles (name, avatar_url, class_id, is_private_profile)
    VALUES (v_user_name, v_avatar_url, p_class_id, true)
    RETURNING id INTO v_private_profile_id;

    SELECT word INTO v_adjective FROM public.name_generation_words
    WHERE is_adjective = true ORDER BY random() LIMIT 1;
    SELECT word INTO v_noun FROM public.name_generation_words
    WHERE is_noun = true ORDER BY random() LIMIT 1;
    v_number := floor(random() * 1000)::integer;
    v_public_name := COALESCE(v_adjective, 'random') || '-' || COALESCE(v_noun, 'user') || '-' || v_number;

    INSERT INTO public.profiles (name, avatar_url, class_id, is_private_profile)
    VALUES (
        v_public_name,
        'https://api.dicebear.com/9.x/identicon/svg?seed=' || v_secure_seed,
        p_class_id,
        false
    )
    RETURNING id INTO v_public_profile_id;

    INSERT INTO public.user_roles (
        user_id, class_id, role, canvas_id,
        private_profile_id, public_profile_id, disabled
    )
    VALUES (
        p_user_id, p_class_id, p_role, p_sis_id,
        v_private_profile_id, v_public_profile_id, false
    )
    RETURNING id INTO v_user_role_id;

    RETURN v_user_role_id;
END;
$$;

-- =============================================================================
-- handle_user_sis_id_update: drop the expires_at gates (no time-based expiry).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_user_sis_id_update()
RETURNS TRIGGER AS $$
BEGIN
    SET LOCAL search_path = pg_catalog, public;

    IF OLD.sis_user_id IS NULL AND NEW.sis_user_id IS NOT NULL THEN
        INSERT INTO public.user_roles (
            user_id, class_id, role,
            public_profile_id, private_profile_id, invitation_id,
            class_section_id, lab_section_id, disabled, canvas_id
        )
        SELECT
            NEW.user_id, i.class_id, i.role,
            i.public_profile_id, i.private_profile_id, i.id,
            i.class_section_id, i.lab_section_id, false, NEW.sis_user_id::numeric
        FROM public.invitations i
        WHERE i.sis_user_id = NEW.sis_user_id
          AND i.status = 'pending'
          AND NOT EXISTS (
              SELECT 1 FROM public.user_roles ur
              WHERE ur.user_id = NEW.user_id AND ur.class_id = i.class_id
          );

        UPDATE public.user_roles
        SET
            role = CASE
                WHEN i.role = 'instructor' THEN 'instructor'
                WHEN i.role = 'grader' AND user_roles.role != 'instructor' THEN 'grader'
                ELSE user_roles.role
            END,
            invitation_id = i.id,
            class_section_id = i.class_section_id,
            lab_section_id = i.lab_section_id,
            disabled = false,
            canvas_id = NEW.sis_user_id::numeric
        FROM public.invitations i
        WHERE user_roles.user_id = NEW.user_id
          AND user_roles.class_id = i.class_id
          AND i.sis_user_id = NEW.sis_user_id
          AND i.status = 'pending'
          AND (i.role = 'instructor' OR (i.role = 'grader' AND user_roles.role = 'student'));

        UPDATE public.invitations
        SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
        WHERE sis_user_id = NEW.sis_user_id
          AND status = 'pending';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- auto_accept_invitation_if_user_exists: when the user already has ANY
-- enrollment in the class, upgrade/refresh that one row instead of inserting a
-- second (which would create a duplicate profile and now also violate
-- idx_user_roles_one_active_per_class).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.auto_accept_invitation_if_user_exists()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
  v_existing_role_id bigint;
  v_existing_role public.app_role;
  v_new_role public.app_role;
BEGIN
  IF NEW.status = 'pending' AND NEW.sis_user_id IS NOT NULL THEN
    SELECT u.user_id INTO v_user_id
    FROM public.users u
    WHERE u.sis_user_id = NEW.sis_user_id;

    IF v_user_id IS NOT NULL THEN
      -- Match on (user, class) only -- never create a second enrollment for the
      -- same user in the same class regardless of role.
      SELECT ur.id, ur.role INTO v_existing_role_id, v_existing_role
      FROM public.user_roles ur
      WHERE ur.user_id = v_user_id
        AND ur.class_id = NEW.class_id
      ORDER BY COALESCE(ur.disabled, false) ASC, ur.id ASC
      LIMIT 1;

      IF v_existing_role_id IS NOT NULL THEN
        -- Upgrade role (never downgrade), refresh sections, reactivate, link.
        v_new_role := CASE
          WHEN v_existing_role = 'instructor' OR NEW.role = 'instructor' THEN 'instructor'
          WHEN v_existing_role = 'grader' OR NEW.role = 'grader' THEN 'grader'
          ELSE 'student'
        END;

        UPDATE public.user_roles
        SET class_section_id = NEW.class_section_id,
            lab_section_id = NEW.lab_section_id,
            invitation_id = NEW.id,
            role = v_new_role,
            disabled = false
        WHERE id = v_existing_role_id;
      ELSE
        INSERT INTO public.user_roles (
          user_id, class_id, role,
          public_profile_id, private_profile_id,
          class_section_id, lab_section_id,
          disabled, invitation_date, invitation_id
        ) VALUES (
          v_user_id, NEW.class_id, NEW.role,
          NEW.public_profile_id, NEW.private_profile_id,
          NEW.class_section_id, NEW.lab_section_id,
          false, null, NEW.id
        );
      END IF;

      UPDATE public.invitations
      SET status = 'accepted', accepted_at = NOW(), updated_at = NOW()
      WHERE id = NEW.id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Reactivation trigger now fires on 'dropped' -> 'pending' (was 'expired').
DROP TRIGGER IF EXISTS trigger_auto_accept_invitation_on_reactivation ON public.invitations;
CREATE TRIGGER trigger_auto_accept_invitation_on_reactivation
AFTER UPDATE ON public.invitations
FOR EACH ROW
WHEN (OLD.status = 'dropped' AND NEW.status = 'pending')
EXECUTE FUNCTION public.auto_accept_invitation_if_user_exists();

-- =============================================================================
-- admin_get_sis_sync_status: rename expired_invitations -> dropped_invitations.
-- Renaming a RETURNS TABLE output column requires dropping the function first.
-- =============================================================================
DROP FUNCTION IF EXISTS public.admin_get_sis_sync_status();
CREATE OR REPLACE FUNCTION public.admin_get_sis_sync_status()
RETURNS TABLE("class_id" bigint, "class_name" text, "term" integer, "sis_sections_count" bigint, "last_sync_time" timestamp with time zone, "last_sync_status" text, "last_sync_message" text, "sync_enabled" boolean, "total_invitations" bigint, "pending_invitations" bigint, "dropped_invitations" bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
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
        COALESCE(invite_stats.dropped_invitations, 0) as dropped_invitations
    FROM public.classes c
    LEFT JOIN (
        SELECT
            invitations.class_id,
            COUNT(*) as total_invitations,
            COUNT(*) FILTER (WHERE invitations.status = 'pending') as pending_invitations,
            COUNT(*) FILTER (WHERE invitations.status = 'dropped') as dropped_invitations
        FROM public.invitations
        GROUP BY invitations.class_id
    ) invite_stats ON c.id = invite_stats.class_id
    LEFT JOIN (
        SELECT
            sss.course_id,
            COUNT(*) as sis_sections_count,
            MAX(sss.last_sync_time) as last_sync_time,
            (SELECT sss2.last_sync_status FROM public.sis_sync_status sss2
             WHERE sss2.course_id = sss.course_id
             ORDER BY sss2.last_sync_time DESC NULLS LAST LIMIT 1) as last_sync_status,
            (SELECT sss2.last_sync_message FROM public.sis_sync_status sss2
             WHERE sss2.course_id = sss.course_id
             ORDER BY sss2.last_sync_time DESC NULLS LAST LIMIT 1) as last_sync_message,
            (BOOL_OR(sss.sync_enabled) AND NOT COALESCE(c_inner.archived, false)) as sync_enabled
        FROM public.sis_sync_status sss
        INNER JOIN public.classes c_inner ON c_inner.id = sss.course_id
        GROUP BY sss.course_id, c_inner.archived
    ) sync_summary ON c.id = sync_summary.course_id
    WHERE sync_summary.course_id IS NOT NULL
    ORDER BY c.term DESC, c.name;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_get_sis_sync_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_sis_sync_status() TO service_role;

-- =============================================================================
-- sis_sync_enrollment: rename expire_missing -> drop_missing and the 'expired'
-- status / invitations_expired count -> 'dropped' / invitations_dropped.
-- (Functionally identical to the prior version otherwise.)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.sis_sync_enrollment(p_class_id bigint, p_roster_data jsonb, p_sync_options jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_result jsonb;
  v_drop_missing boolean := COALESCE((p_sync_options ->> 'drop_missing')::boolean, true);
  v_admin_user_id uuid;
  v_section_updates jsonb := COALESCE(p_sync_options -> 'section_updates', '[]'::jsonb);
  v_invitations_dropped integer := 0;
  v_enrollments_disabled integer := 0;
  v_enrollments_reenabled integer := 0;
  v_rows integer := 0;
BEGIN
  IF NOT (public.authorizeforclassinstructor(p_class_id) OR public.authorize_for_admin()) THEN
    RAISE EXCEPTION 'Access denied: instructor or admin required';
  END IF;

  SELECT ur.user_id INTO v_admin_user_id
  FROM public.user_roles ur
  WHERE ur.role = 'admin' AND COALESCE(ur.disabled, false) = false
  ORDER BY ur.id ASC LIMIT 1;

  IF v_admin_user_id IS NULL THEN
    SELECT u.user_id INTO v_admin_user_id
    FROM public.users u WHERE u.email = 'system@example.com' LIMIT 1;
    IF v_admin_user_id IS NULL THEN
      INSERT INTO public.users (user_id, email, name)
      VALUES (md5(random()::text || clock_timestamp()::text)::uuid, 'system@example.com', 'System')
      RETURNING user_id INTO v_admin_user_id;
    END IF;
  END IF;

  CREATE TEMP TABLE tmp_sis_roster (
    sis_user_id integer NOT NULL, name text, role public.app_role NOT NULL,
    class_section_crn integer, lab_section_crn integer
  ) ON COMMIT DROP;

  INSERT INTO tmp_sis_roster (sis_user_id, name, role, class_section_crn, lab_section_crn)
  SELECT (r.sis_user_id)::integer, NULLIF(btrim(r.name), ''), (r.role)::public.app_role,
    NULLIF((r.class_section_crn)::text, '')::integer, NULLIF((r.lab_section_crn)::text, '')::integer
  FROM jsonb_to_recordset(COALESCE(p_roster_data, '[]'::jsonb)) AS r(
    sis_user_id integer, name text, role text, class_section_crn integer, lab_section_crn integer
  );

  CREATE TEMP TABLE tmp_enabled_class_sections (id bigint PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_enabled_lab_sections (id bigint PRIMARY KEY) ON COMMIT DROP;

  INSERT INTO tmp_enabled_class_sections (id)
  SELECT cs.id FROM public.class_sections cs
  WHERE cs.class_id = p_class_id AND cs.sis_crn IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.sis_sync_status sss
      WHERE sss.course_id = p_class_id AND sss.course_section_id = cs.id AND sss.sync_enabled = false
    );

  INSERT INTO tmp_enabled_lab_sections (id)
  SELECT ls.id FROM public.lab_sections ls
  WHERE ls.class_id = p_class_id AND ls.sis_crn IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.sis_sync_status sss
      WHERE sss.course_id = p_class_id AND sss.lab_section_id = ls.id AND sss.sync_enabled = false
    );

  CREATE TEMP TABLE tmp_sis_roster_resolved (
    sis_user_id integer PRIMARY KEY, name text, role public.app_role NOT NULL,
    class_section_id bigint, lab_section_id bigint
  ) ON COMMIT DROP;

  INSERT INTO tmp_sis_roster_resolved (sis_user_id, name, role, class_section_id, lab_section_id)
  SELECT r.sis_user_id, r.name, r.role, cs.id, ls.id
  FROM tmp_sis_roster r
  LEFT JOIN public.class_sections cs ON cs.class_id = p_class_id AND cs.sis_crn = r.class_section_crn
  LEFT JOIN public.lab_sections ls ON ls.class_id = p_class_id AND ls.sis_crn = r.lab_section_crn;

  IF jsonb_typeof(v_section_updates) = 'array' AND jsonb_array_length(v_section_updates) > 0 THEN
    CREATE TEMP TABLE tmp_section_updates (
      section_type text NOT NULL, sis_crn integer NOT NULL, meeting_location text, meeting_times text,
      campus text, day_of_week public.day_of_week, start_time time, end_time time
    ) ON COMMIT DROP;

    INSERT INTO tmp_section_updates(section_type, sis_crn, meeting_location, meeting_times, campus, day_of_week, start_time, end_time)
    SELECT u.section_type, (u.sis_crn)::integer, u.meeting_location, u.meeting_times, u.campus,
      NULLIF(u.day_of_week, '')::public.day_of_week, NULLIF(u.start_time, '')::time, NULLIF(u.end_time, '')::time
    FROM jsonb_to_recordset(v_section_updates) AS u(
      section_type text, sis_crn integer, meeting_location text, meeting_times text,
      campus text, day_of_week text, start_time text, end_time text
    );

    UPDATE public.class_sections cs
    SET meeting_location = COALESCE(u.meeting_location, cs.meeting_location),
        meeting_times = COALESCE(u.meeting_times, cs.meeting_times),
        campus = COALESCE(u.campus, cs.campus)
    FROM tmp_section_updates u
    WHERE u.section_type = 'class' AND cs.class_id = p_class_id AND cs.sis_crn = u.sis_crn
      AND cs.id IN (SELECT id FROM tmp_enabled_class_sections)
      AND (
        cs.meeting_location IS DISTINCT FROM COALESCE(u.meeting_location, cs.meeting_location)
        OR cs.meeting_times IS DISTINCT FROM COALESCE(u.meeting_times, cs.meeting_times)
        OR cs.campus IS DISTINCT FROM COALESCE(u.campus, cs.campus)
      );

    UPDATE public.lab_sections ls
    SET meeting_location = COALESCE(u.meeting_location, ls.meeting_location),
        meeting_times = COALESCE(u.meeting_times, ls.meeting_times),
        campus = COALESCE(u.campus, ls.campus),
        day_of_week = COALESCE(u.day_of_week, ls.day_of_week),
        start_time = COALESCE(u.start_time, ls.start_time),
        end_time = COALESCE(u.end_time, ls.end_time)
    FROM tmp_section_updates u
    WHERE u.section_type = 'lab' AND ls.class_id = p_class_id AND ls.sis_crn = u.sis_crn
      AND ls.id IN (SELECT id FROM tmp_enabled_lab_sections)
      AND (
        ls.meeting_location IS DISTINCT FROM COALESCE(u.meeting_location, ls.meeting_location)
        OR ls.meeting_times IS DISTINCT FROM COALESCE(u.meeting_times, ls.meeting_times)
        OR ls.campus IS DISTINCT FROM COALESCE(u.campus, ls.campus)
        OR ls.day_of_week IS DISTINCT FROM COALESCE(u.day_of_week, ls.day_of_week)
        OR ls.start_time IS DISTINCT FROM COALESCE(u.start_time, ls.start_time)
        OR ls.end_time IS DISTINCT FROM COALESCE(u.end_time, ls.end_time)
      );
  END IF;

  CREATE TEMP TABLE tmp_change_counts (
    invitations_created integer NOT NULL DEFAULT 0,
    invitations_updated integer NOT NULL DEFAULT 0,
    invitations_dropped integer NOT NULL DEFAULT 0,
    invitations_reactivated integer NOT NULL DEFAULT 0,
    enrollments_created integer NOT NULL DEFAULT 0,
    enrollments_updated integer NOT NULL DEFAULT 0,
    enrollments_disabled integer NOT NULL DEFAULT 0,
    enrollments_reenabled integer NOT NULL DEFAULT 0,
    enrollments_adopted integer NOT NULL DEFAULT 0
  ) ON COMMIT DROP;
  INSERT INTO tmp_change_counts DEFAULT VALUES;

  DECLARE
    rec RECORD;
    v_user_role_id bigint;
    v_new_role public.app_role;
    v_current_prec integer;
    v_incoming_prec integer;
    v_is_manual boolean;
    v_existing_inv public.invitations%ROWTYPE;
    v_inv_id bigint;
  BEGIN
    -- 2) Enroll existing users (no current user_role) directly and set sections
    FOR rec IN
      SELECT r.sis_user_id, r.name, r.role, r.class_section_id, r.lab_section_id, u.user_id AS existing_user_id
      FROM tmp_sis_roster_resolved r
      JOIN public.users u ON u.sis_user_id = r.sis_user_id
      LEFT JOIN public.user_roles ur ON ur.class_id = p_class_id AND ur.user_id = u.user_id
      WHERE ur.id IS NULL
    LOOP
      v_user_role_id := public.create_user_role_for_existing_user(
        rec.existing_user_id, p_class_id, rec.role, rec.name, rec.sis_user_id
      );

      UPDATE public.user_roles
      SET class_section_id = rec.class_section_id, lab_section_id = rec.lab_section_id,
          disabled = false, sis_sync_opt_out = false
      WHERE id = v_user_role_id;

      UPDATE tmp_change_counts SET enrollments_created = enrollments_created + 1 WHERE true;

      UPDATE public.invitations
      SET status = 'accepted', accepted_at = COALESCE(accepted_at, now()), updated_at = now()
      WHERE class_id = p_class_id AND sis_user_id = rec.sis_user_id
        AND status IN ('pending', 'dropped');
    END LOOP;

    -- 3) Update existing enrollments for users present in roster
    FOR rec IN
      SELECT r.sis_user_id, r.name, r.role AS incoming_role,
        r.class_section_id AS incoming_class_section_id, r.lab_section_id AS incoming_lab_section_id,
        u.user_id, u.sis_user_id AS users_sis_user_id, ur.id AS user_role_id,
        ur.role AS current_role, ur.disabled, ur.canvas_id,
        COALESCE(ur.sis_sync_opt_out, false) AS sis_sync_opt_out
      FROM tmp_sis_roster_resolved r
      JOIN public.users u ON u.sis_user_id = r.sis_user_id
      JOIN public.user_roles ur ON ur.class_id = p_class_id AND ur.user_id = u.user_id
    LOOP
      IF rec.sis_sync_opt_out THEN CONTINUE; END IF;

      v_is_manual := rec.canvas_id IS NULL;
      v_current_prec := CASE rec.current_role WHEN 'instructor' THEN 3 WHEN 'grader' THEN 2 ELSE 1 END;
      v_incoming_prec := CASE rec.incoming_role WHEN 'instructor' THEN 3 WHEN 'grader' THEN 2 ELSE 1 END;
      v_new_role := CASE WHEN v_incoming_prec > v_current_prec THEN rec.incoming_role ELSE rec.current_role END;

      IF v_is_manual THEN
        UPDATE public.user_roles
        SET canvas_id = rec.sis_user_id::numeric, role = v_new_role,
            class_section_id = rec.incoming_class_section_id, lab_section_id = rec.incoming_lab_section_id,
            disabled = false
        WHERE id = rec.user_role_id;
        UPDATE tmp_change_counts SET enrollments_adopted = enrollments_adopted + 1 WHERE true;
      ELSE
        UPDATE public.user_roles
        SET role = v_new_role, class_section_id = rec.incoming_class_section_id,
            lab_section_id = rec.incoming_lab_section_id, disabled = false
        WHERE id = rec.user_role_id
          AND (
            role IS DISTINCT FROM v_new_role OR
            class_section_id IS DISTINCT FROM rec.incoming_class_section_id OR
            lab_section_id IS DISTINCT FROM rec.incoming_lab_section_id OR
            disabled = true
          );
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows > 0 THEN
          UPDATE tmp_change_counts SET enrollments_updated = enrollments_updated + 1 WHERE true;
        END IF;
      END IF;

      IF rec.disabled = true THEN
        v_enrollments_reenabled := v_enrollments_reenabled + 1;
      END IF;

      UPDATE public.invitations i
      SET sis_managed = true, role = v_new_role,
          class_section_id = rec.incoming_class_section_id, lab_section_id = rec.incoming_lab_section_id,
          status = CASE WHEN i.status = 'dropped' THEN 'pending' ELSE i.status END,
          updated_at = now()
      WHERE i.class_id = p_class_id AND i.sis_user_id = rec.sis_user_id
        AND i.status IN ('pending', 'dropped')
        AND (i.sis_managed = false OR i.status = 'dropped');

      UPDATE public.invitations i
      SET status = 'accepted', accepted_at = COALESCE(i.accepted_at, now()), updated_at = now()
      WHERE i.class_id = p_class_id AND i.sis_user_id = rec.sis_user_id
        AND i.status = 'pending' AND i.sis_managed = true;
    END LOOP;

    -- 4) Create/Update invitations for users without accounts
    FOR rec IN
      SELECT r.sis_user_id, r.name, r.role, r.class_section_id, r.lab_section_id
      FROM tmp_sis_roster_resolved r
      LEFT JOIN public.users u ON u.sis_user_id = r.sis_user_id
      WHERE u.user_id IS NULL
    LOOP
      SELECT * INTO v_existing_inv
      FROM public.invitations i
      WHERE i.class_id = p_class_id AND i.sis_user_id = rec.sis_user_id
      LIMIT 1;

      IF FOUND THEN
        UPDATE public.invitations i
        SET sis_managed = true, role = rec.role, name = COALESCE(rec.name, i.name),
            class_section_id = rec.class_section_id, lab_section_id = rec.lab_section_id,
            status = CASE WHEN i.status = 'dropped' THEN 'pending' ELSE i.status END,
            updated_at = now()
        WHERE i.id = v_existing_inv.id AND i.status IN ('pending', 'dropped');

        IF v_existing_inv.status = 'dropped' THEN
          UPDATE tmp_change_counts SET invitations_reactivated = invitations_reactivated + 1 WHERE true;
        ELSE
          UPDATE tmp_change_counts SET invitations_updated = invitations_updated + 1 WHERE true;
        END IF;
      ELSE
        v_inv_id := public.create_invitation(
          p_class_id, rec.role, rec.sis_user_id, NULL, rec.name,
          v_admin_user_id, rec.class_section_id, rec.lab_section_id, true
        );
        PERFORM v_inv_id;
        UPDATE tmp_change_counts SET invitations_created = invitations_created + 1 WHERE true;
      END IF;
    END LOOP;
  END;

  -- 5) Handle missing users (drop from SIS): drop invitations + disable enrollments (SIS-managed only)
  IF v_drop_missing THEN
    WITH present AS (SELECT sis_user_id FROM tmp_sis_roster_resolved)
    UPDATE public.invitations i
    SET status = 'dropped', updated_at = now()
    WHERE i.class_id = p_class_id AND i.sis_managed = true
      AND i.status IN ('pending', 'accepted')
      AND NOT EXISTS (SELECT 1 FROM present p WHERE p.sis_user_id = i.sis_user_id)
      AND (i.class_section_id IS NULL OR i.class_section_id IN (SELECT id FROM tmp_enabled_class_sections))
      AND (i.lab_section_id IS NULL OR i.lab_section_id IN (SELECT id FROM tmp_enabled_lab_sections));

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_invitations_dropped := v_rows;

    WITH present AS (SELECT sis_user_id FROM tmp_sis_roster_resolved),
    candidates AS (
      SELECT ur.id
      FROM public.user_roles ur
      JOIN public.users u ON u.user_id = ur.user_id
      LEFT JOIN public.invitations inv ON inv.id = ur.invitation_id
      WHERE ur.class_id = p_class_id
        AND COALESCE(ur.disabled, false) = false
        AND COALESCE(ur.sis_sync_opt_out, false) = false
        AND u.sis_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM present p WHERE p.sis_user_id = u.sis_user_id)
        AND (
          (inv.id IS NOT NULL AND inv.sis_managed = true) OR
          (ur.canvas_id IS NOT NULL AND ur.canvas_id = u.sis_user_id::numeric)
        )
        AND (ur.class_section_id IS NULL OR ur.class_section_id IN (SELECT id FROM tmp_enabled_class_sections))
        AND (ur.lab_section_id IS NULL OR ur.lab_section_id IN (SELECT id FROM tmp_enabled_lab_sections))
    )
    UPDATE public.user_roles ur SET disabled = true WHERE ur.id IN (SELECT id FROM candidates);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_enrollments_disabled := v_rows;
  END IF;

  SELECT jsonb_build_object(
    'success', true,
    'class_id', p_class_id,
    'drop_missing', v_drop_missing,
    'counts', jsonb_build_object(
      'invitations_created', (SELECT invitations_created FROM tmp_change_counts),
      'invitations_updated', (SELECT invitations_updated FROM tmp_change_counts),
      'invitations_dropped', v_invitations_dropped,
      'invitations_reactivated', (SELECT invitations_reactivated FROM tmp_change_counts),
      'enrollments_created', (SELECT enrollments_created FROM tmp_change_counts),
      'enrollments_updated', (SELECT enrollments_updated FROM tmp_change_counts),
      'enrollments_disabled', v_enrollments_disabled,
      'enrollments_reenabled', v_enrollments_reenabled,
      'enrollments_adopted', (SELECT enrollments_adopted FROM tmp_change_counts)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.sis_sync_enrollment(bigint, jsonb, jsonb) IS
  'Atomically applies an SIS roster sync for a class. drop_missing drops invitations and disables enrollments for students no longer on the roster. Reuses existing profiles (one enrollment per user per class).';
