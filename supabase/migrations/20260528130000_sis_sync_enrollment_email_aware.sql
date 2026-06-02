-- LTI roster sync: make sis_sync_enrollment email-aware.
--
-- LTI 1.3 NRPS provides members by email + a per-platform `sub`, not an
-- institutional SIS integer id. The roster sync (lib/lti/roster.ts) maps NRPS
-- members into this RPC using a deterministic surrogate sis_user_id derived from
-- the sub, and now also carries the member's email.
--
-- This migration extends public.sis_sync_enrollment to accept an optional
-- `email` per roster row and:
--   * link an existing Pawtograder account matched by email (e.g. a user who
--     already signed in via an LTI launch) by stamping the surrogate
--     sis_user_id onto it — so it is adopted by the existing sis_user_id-keyed
--     logic instead of creating a duplicate invitation;
--   * store the email on invitations it creates, so invitees can be matched.
--
-- Fully backward compatible: when email is absent (the SIS proxy path), the
-- email-link step is a no-op and create_invitation receives NULL email exactly
-- as before. The stamping never overwrites an existing sis_user_id and is
-- guarded against the unique users.sis_user_id constraint.

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
    sis_user_id integer NOT NULL, name text, email text, role public.app_role NOT NULL,
    class_section_crn integer, lab_section_crn integer
  ) ON COMMIT DROP;

  INSERT INTO tmp_sis_roster (sis_user_id, name, email, role, class_section_crn, lab_section_crn)
  SELECT (r.sis_user_id)::integer, NULLIF(btrim(r.name), ''), NULLIF(btrim(lower(r.email)), ''), (r.role)::public.app_role,
    NULLIF((r.class_section_crn)::text, '')::integer, NULLIF((r.lab_section_crn)::text, '')::integer
  FROM jsonb_to_recordset(COALESCE(p_roster_data, '[]'::jsonb)) AS r(
    sis_user_id integer, name text, email text, role text, class_section_crn integer, lab_section_crn integer
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
    sis_user_id integer PRIMARY KEY, name text, email text, role public.app_role NOT NULL,
    class_section_id bigint, lab_section_id bigint
  ) ON COMMIT DROP;

  INSERT INTO tmp_sis_roster_resolved (sis_user_id, name, email, role, class_section_id, lab_section_id)
  SELECT r.sis_user_id, r.name, r.email, r.role, cs.id, ls.id
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

  -- EMAIL LINK (LTI): for roster rows carrying an email, attach the surrogate
  -- sis_user_id to an existing account matched by email that has no sis_user_id
  -- yet. This lets the sis_user_id-keyed logic below adopt users who already
  -- exist (e.g. signed in via an LTI launch) instead of creating duplicates.
  -- No-op for SIS syncs (email is NULL there). users.email is NOT unique, so a
  -- given email may match several accounts; we stamp exactly ONE (the lowest
  -- user_id) to avoid setting the same surrogate sis_user_id on multiple rows
  -- (which would trip UNIQUE(users.sis_user_id) and abort the whole sync).
  -- Never overwrites an existing sis_user_id; skips surrogates already in use.
  UPDATE public.users u
  SET sis_user_id = r.sis_user_id
  FROM tmp_sis_roster_resolved r
  WHERE r.email IS NOT NULL
    AND u.sis_user_id IS NULL
    AND lower(u.email) = r.email
    AND u.user_id = (
      SELECT u2.user_id FROM public.users u2
      WHERE u2.sis_user_id IS NULL AND lower(u2.email) = r.email
      ORDER BY u2.user_id
      LIMIT 1
    )
    AND NOT EXISTS (SELECT 1 FROM public.users u3 WHERE u3.sis_user_id = r.sis_user_id);

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
      SELECT r.sis_user_id, r.name, r.email, r.role, r.class_section_id, r.lab_section_id
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
          p_class_id, rec.role, rec.sis_user_id, rec.email, rec.name,
          v_admin_user_id, rec.class_section_id, rec.lab_section_id, true
        );
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


REVOKE ALL ON FUNCTION public.sis_sync_enrollment(bigint, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sis_sync_enrollment(bigint, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sis_sync_enrollment(bigint, jsonb, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.sis_sync_enrollment(bigint, jsonb, jsonb) TO authenticated;
