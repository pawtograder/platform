-- Fix broadcast spam by preventing unnecessary UPDATEs at the source
-- 
-- Problem 1: calendar_events sync was updating ALL events on every sync due to:
--   - Using != instead of IS DISTINCT FROM (NULL handling bug)
--   - Missing queue_name/organizer_name in comparison
--   - This caused ~660k+ unnecessary writes and broadcasts per day
--
-- Problem 2: SIS sync (sis_sync_enrollment) was updating ALL lab_sections and 
--   class_sections on every hourly sync even when nothing changed, because the
--   UPDATE statements lacked a "something actually changed" filter.
--   With N students per class, each unnecessary UPDATE creates N+1 broadcasts.

-- Fix the sync_calendar_events RPC to use proper NULL-safe comparisons
CREATE OR REPLACE FUNCTION public.sync_calendar_events(
  p_class_id bigint,
  p_calendar_type text,
  p_parsed_events jsonb,
  p_has_discord_server boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_now timestamptz := NOW();
  v_event jsonb;
  v_existing_event RECORD;
  v_uid text;
  v_parsed_uids text[] := '{}';
  v_existing_uids text[] := '{}';
  v_to_add jsonb[] := '{}';
  v_to_update jsonb[] := '{}';
  v_to_delete bigint[] := '{}';
  v_added_count int := 0;
  v_updated_count int := 0;
  v_deleted_count int := 0;
  v_skipped_count int := 0;
  v_error_count int := 0;
  v_errors text[] := '{}';
  v_result jsonb;
  v_start_time timestamptz;
  v_end_time timestamptz;
  v_start_changed boolean;
  v_end_changed boolean;
  v_has_real_change boolean;
  v_new_title text;
  v_new_description text;
  v_new_location text;
  v_new_queue_name text;
  v_new_organizer_name text;
  v_row_count integer;
BEGIN
  -- Extract all UIDs from parsed events
  FOR v_event IN SELECT * FROM jsonb_array_elements(p_parsed_events)
  LOOP
    v_uid := v_event->>'uid';
    IF v_uid IS NOT NULL THEN
      v_parsed_uids := array_append(v_parsed_uids, v_uid);
    END IF;
  END LOOP;

  -- Get existing events by UID (regardless of date) to catch all duplicates
  -- Also get recent events (last 30 days) for deletion checks
  FOR v_existing_event IN
    SELECT ce.*
    FROM public.calendar_events ce
    WHERE ce.class_id = p_class_id
      AND ce.calendar_type = p_calendar_type
      AND (
        ce.uid = ANY(v_parsed_uids)  -- Match by UID regardless of date
        OR ce.end_time >= (v_now - INTERVAL '30 days')  -- Recent events for deletion
      )
  LOOP
    v_existing_uids := array_append(v_existing_uids, v_existing_event.uid);
  END LOOP;

  -- Compare parsed events with existing events
  FOR v_event IN SELECT * FROM jsonb_array_elements(p_parsed_events)
  LOOP
    v_uid := v_event->>'uid';
    IF v_uid IS NULL THEN
      CONTINUE;
    END IF;

    -- Check if this event already exists
    SELECT ce.* INTO v_existing_event
    FROM public.calendar_events ce
    WHERE ce.class_id = p_class_id
      AND ce.calendar_type = p_calendar_type
      AND ce.uid = v_uid
    LIMIT 1;

    IF v_existing_event.id IS NULL THEN
      -- New event - add to insert list
      v_to_add := array_append(v_to_add, v_event);
    ELSE
      -- Existing event - check if ANY meaningful field actually changed
      -- Use IS DISTINCT FROM for proper NULL handling
      v_start_time := (v_event->>'start_time')::timestamptz;
      v_end_time := (v_event->>'end_time')::timestamptz;
      v_new_title := v_event->>'title';
      v_new_description := NULLIF(v_event->>'description', '');
      v_new_location := NULLIF(v_event->>'location', '');
      v_new_queue_name := NULLIF(v_event->>'queue_name', '');
      v_new_organizer_name := NULLIF(v_event->>'organizer_name', '');
      
      v_start_changed := v_existing_event.start_time IS DISTINCT FROM v_start_time;
      v_end_changed := v_existing_event.end_time IS DISTINCT FROM v_end_time;
      
      -- Check ALL meaningful fields using IS DISTINCT FROM
      v_has_real_change := (
        v_existing_event.title IS DISTINCT FROM v_new_title
        OR v_existing_event.description IS DISTINCT FROM v_new_description
        OR v_start_changed
        OR v_end_changed
        OR v_existing_event.location IS DISTINCT FROM v_new_location
        OR v_existing_event.queue_name IS DISTINCT FROM v_new_queue_name
        OR v_existing_event.organizer_name IS DISTINCT FROM v_new_organizer_name
      );
      
      IF v_has_real_change THEN
        -- Event actually changed - add to update list
        v_to_update := array_append(v_to_update, jsonb_build_object(
          'id', v_existing_event.id,
          'event', v_event,
          'start_changed', v_start_changed,
          'end_changed', v_end_changed,
          'existing_start_announced_at', v_existing_event.start_announced_at,
          'existing_end_announced_at', v_existing_event.end_announced_at
        ));
      ELSE
        -- No real change - skip this event
        v_skipped_count := v_skipped_count + 1;
      END IF;
    END IF;
  END LOOP;

  -- Find events to delete (exist in DB but not in parsed events)
  FOR v_existing_event IN
    SELECT ce.*
    FROM public.calendar_events ce
    WHERE ce.class_id = p_class_id
      AND ce.calendar_type = p_calendar_type
      AND ce.end_time >= (v_now - INTERVAL '30 days')  -- Only check recent events
      AND ce.uid != ALL(v_parsed_uids)  -- Not in parsed events
  LOOP
    v_to_delete := array_append(v_to_delete, v_existing_event.id);
  END LOOP;

  -- Process additions
  FOR v_event IN SELECT * FROM unnest(v_to_add)
  LOOP
    BEGIN
      v_start_time := (v_event->>'start_time')::timestamptz;
      v_end_time := (v_event->>'end_time')::timestamptz;
      
      INSERT INTO public.calendar_events (
        class_id,
        calendar_type,
        uid,
        title,
        description,
        start_time,
        end_time,
        location,
        queue_name,
        organizer_name,
        raw_ics_data,
        change_announced_at,
        start_announced_at,
        end_announced_at
      ) VALUES (
        p_class_id,
        p_calendar_type,
        v_event->>'uid',
        v_event->>'title',
        NULLIF(v_event->>'description', ''),
        v_start_time,
        v_end_time,
        NULLIF(v_event->>'location', ''),
        NULLIF(v_event->>'queue_name', ''),
        NULLIF(v_event->>'organizer_name', ''),
        COALESCE(v_event->'raw_ics_data', '{}'::jsonb),
        -- For past events, use actual event times (not NOW) to avoid update churn
        CASE WHEN v_end_time <= v_now THEN v_end_time ELSE NULL END,
        CASE WHEN v_start_time <= v_now THEN v_start_time ELSE NULL END,
        CASE WHEN v_end_time <= v_now THEN v_end_time ELSE NULL END
      )
      ON CONFLICT (class_id, calendar_type, uid) DO NOTHING;  -- Handle race conditions
      
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_added_count := v_added_count + v_row_count;
    EXCEPTION WHEN OTHERS THEN
      v_error_count := v_error_count + 1;
      v_errors := array_append(v_errors, format('Failed to insert event %s: %s', v_event->>'uid', SQLERRM));
    END;
  END LOOP;

  -- Process updates (only events with real changes)
  FOR v_event IN SELECT * FROM unnest(v_to_update)
  LOOP
    BEGIN
      v_start_time := (v_event->'event'->>'start_time')::timestamptz;
      v_end_time := (v_event->'event'->>'end_time')::timestamptz;
      v_start_changed := (v_event->>'start_changed')::boolean;
      v_end_changed := (v_event->>'end_changed')::boolean;
      
      UPDATE public.calendar_events
      SET
        title = v_event->'event'->>'title',
        description = NULLIF(v_event->'event'->>'description', ''),
        start_time = v_start_time,
        end_time = v_end_time,
        location = NULLIF(v_event->'event'->>'location', ''),
        queue_name = NULLIF(v_event->'event'->>'queue_name', ''),
        organizer_name = NULLIF(v_event->'event'->>'organizer_name', ''),
        raw_ics_data = COALESCE(v_event->'event'->'raw_ics_data', '{}'::jsonb),
        -- Use actual event times (not NOW) to avoid update churn
        change_announced_at = CASE 
          WHEN v_end_time <= v_now THEN v_end_time 
          ELSE NULL 
        END,
        start_announced_at = CASE
          WHEN v_start_changed AND v_start_time > v_now THEN NULL
          ELSE COALESCE((v_event->>'existing_start_announced_at')::timestamptz, 
                        CASE WHEN v_start_time <= v_now THEN v_start_time ELSE NULL END)
        END,
        end_announced_at = CASE
          WHEN v_end_changed AND v_end_time > v_now THEN NULL
          ELSE COALESCE((v_event->>'existing_end_announced_at')::timestamptz,
                        CASE WHEN v_end_time <= v_now THEN v_end_time ELSE NULL END)
        END
      WHERE id = (v_event->>'id')::bigint;
      
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      v_updated_count := v_updated_count + v_row_count;
    EXCEPTION WHEN OTHERS THEN
      v_error_count := v_error_count + 1;
      v_errors := array_append(v_errors, format('Failed to update event %s: %s', v_event->'event'->>'uid', SQLERRM));
    END;
  END LOOP;

  -- Process deletions
  IF array_length(v_to_delete, 1) > 0 THEN
    BEGIN
      DELETE FROM public.calendar_events
      WHERE id = ANY(v_to_delete);
      
      GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    EXCEPTION WHEN OTHERS THEN
      v_error_count := v_error_count + 1;
      v_errors := array_append(v_errors, format('Failed to delete events: %s', SQLERRM));
    END;
  END IF;

  -- Return result (including skipped count for monitoring)
  v_result := jsonb_build_object(
    'success', v_error_count = 0,
    'added', v_added_count,
    'updated', v_updated_count,
    'deleted', v_deleted_count,
    'skipped', v_skipped_count,
    'errors', v_errors,
    'error_count', v_error_count
  );

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.sync_calendar_events(bigint, text, jsonb, boolean) IS 
'Syncs calendar events from parsed ICS data. Uses IS DISTINCT FROM for proper NULL handling to prevent unnecessary updates when no meaningful fields changed.';


-- =============================================================================
-- Fix SIS sync spam: sis_sync_enrollment was updating ALL lab_sections and 
-- class_sections on every hourly sync even when nothing changed.
-- 
-- The UPDATE statements used COALESCE which always writes the row even if the
-- new value equals the old value. Now we add a filter to only update rows
-- where at least one field actually changed.
-- =============================================================================

CREATE OR REPLACE FUNCTION "public"."sis_sync_enrollment"("p_class_id" bigint, "p_roster_data" "jsonb", "p_sync_options" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
DECLARE
  v_result jsonb;
  v_expire_missing boolean := COALESCE((p_sync_options ->> 'expire_missing')::boolean, true);
  v_admin_user_id uuid;
  v_section_updates jsonb := COALESCE(p_sync_options -> 'section_updates', '[]'::jsonb);
  v_invitations_expired integer := 0;
  v_enrollments_disabled integer := 0;
  v_enrollments_reenabled integer := 0;
  v_rows integer := 0;
BEGIN
  -- Authorization: instructor of class OR admin OR service role (authorize_for_admin allows service role).
  IF NOT (public.authorizeforclassinstructor(p_class_id) OR public.authorize_for_admin()) THEN
    RAISE EXCEPTION 'Access denied: instructor or admin required';
  END IF;

  -- Pick an inviter/admin for invitations (used by create_invitation).
  SELECT ur.user_id
    INTO v_admin_user_id
  FROM public.user_roles ur
  WHERE ur.role = 'admin'
    AND COALESCE(ur.disabled, false) = false
  ORDER BY ur.id ASC
  LIMIT 1;

  IF v_admin_user_id IS NULL THEN
    -- No admin exists in user_roles: use (or create) a system user to attribute SIS invitations.
    -- This avoids hard-failing SIS sync in new/empty environments.
    SELECT u.user_id
      INTO v_admin_user_id
    FROM public.users u
    WHERE u.email = 'system@example.com'
    LIMIT 1;

    IF v_admin_user_id IS NULL THEN
      INSERT INTO public.users (user_id, email, name)
      VALUES (
        md5(random()::text || clock_timestamp()::text)::uuid,
        'system@example.com',
        'System'
      )
      RETURNING user_id INTO v_admin_user_id;
    END IF;
  END IF;

  -- Temp table for incoming roster
  CREATE TEMP TABLE tmp_sis_roster (
    sis_user_id integer NOT NULL,
    name text,
    role public.app_role NOT NULL,
    class_section_crn integer,
    lab_section_crn integer
  ) ON COMMIT DROP;

  INSERT INTO tmp_sis_roster (sis_user_id, name, role, class_section_crn, lab_section_crn)
  SELECT
    (r.sis_user_id)::integer,
    NULLIF(btrim(r.name), ''),
    (r.role)::public.app_role,
    NULLIF((r.class_section_crn)::text, '')::integer,
    NULLIF((r.lab_section_crn)::text, '')::integer
  FROM jsonb_to_recordset(COALESCE(p_roster_data, '[]'::jsonb)) AS r(
    sis_user_id integer,
    name text,
    role text,
    class_section_crn integer,
    lab_section_crn integer
  );

  -- Resolve enabled SIS-managed section IDs for this class:
  -- - Default enabled if there is no sis_sync_status row
  -- - Disabled only if there is an explicit sis_sync_status row with sync_enabled=false
  CREATE TEMP TABLE tmp_enabled_class_sections (id bigint PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE tmp_enabled_lab_sections (id bigint PRIMARY KEY) ON COMMIT DROP;

  INSERT INTO tmp_enabled_class_sections (id)
  SELECT cs.id
  FROM public.class_sections cs
  WHERE cs.class_id = p_class_id
    AND cs.sis_crn IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.sis_sync_status sss
      WHERE sss.course_id = p_class_id
        AND sss.course_section_id = cs.id
        AND sss.sync_enabled = false
    );

  INSERT INTO tmp_enabled_lab_sections (id)
  SELECT ls.id
  FROM public.lab_sections ls
  WHERE ls.class_id = p_class_id
    AND ls.sis_crn IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.sis_sync_status sss
      WHERE sss.course_id = p_class_id
        AND sss.lab_section_id = ls.id
        AND sss.sync_enabled = false
    );

  -- Resolve CRNs to section IDs for roster entries
  CREATE TEMP TABLE tmp_sis_roster_resolved (
    sis_user_id integer PRIMARY KEY,
    name text,
    role public.app_role NOT NULL,
    class_section_id bigint,
    lab_section_id bigint
  ) ON COMMIT DROP;

  INSERT INTO tmp_sis_roster_resolved (sis_user_id, name, role, class_section_id, lab_section_id)
  SELECT
    r.sis_user_id,
    r.name,
    r.role,
    cs.id,
    ls.id
  FROM tmp_sis_roster r
  LEFT JOIN public.class_sections cs
    ON cs.class_id = p_class_id
   AND cs.sis_crn = r.class_section_crn
  LEFT JOIN public.lab_sections ls
    ON ls.class_id = p_class_id
   AND ls.sis_crn = r.lab_section_crn;

  -- Section metadata updates (bulk) if provided
  -- We only update sections that are SIS-managed for this class and not explicitly disabled.
  IF jsonb_typeof(v_section_updates) = 'array' AND jsonb_array_length(v_section_updates) > 0 THEN
    CREATE TEMP TABLE tmp_section_updates (
      section_type text NOT NULL,
      sis_crn integer NOT NULL,
      meeting_location text,
      meeting_times text,
      campus text,
      day_of_week public.day_of_week,
      start_time time,
      end_time time
    ) ON COMMIT DROP;

    INSERT INTO tmp_section_updates(section_type, sis_crn, meeting_location, meeting_times, campus, day_of_week, start_time, end_time)
    SELECT
      u.section_type,
      (u.sis_crn)::integer,
      u.meeting_location,
      u.meeting_times,
      u.campus,
      NULLIF(u.day_of_week, '')::public.day_of_week,
      NULLIF(u.start_time, '')::time,
      NULLIF(u.end_time, '')::time
    FROM jsonb_to_recordset(v_section_updates) AS u(
      section_type text,
      sis_crn integer,
      meeting_location text,
      meeting_times text,
      campus text,
      day_of_week text,
      start_time text,
      end_time text
    );

    -- class_sections updates - ONLY if something actually changed
    UPDATE public.class_sections cs
    SET
      meeting_location = COALESCE(u.meeting_location, cs.meeting_location),
      meeting_times = COALESCE(u.meeting_times, cs.meeting_times),
      campus = COALESCE(u.campus, cs.campus)
    FROM tmp_section_updates u
    WHERE u.section_type = 'class'
      AND cs.class_id = p_class_id
      AND cs.sis_crn = u.sis_crn
      AND cs.id IN (SELECT id FROM tmp_enabled_class_sections)
      -- Only update if at least one field actually changed
      AND (
        cs.meeting_location IS DISTINCT FROM COALESCE(u.meeting_location, cs.meeting_location)
        OR cs.meeting_times IS DISTINCT FROM COALESCE(u.meeting_times, cs.meeting_times)
        OR cs.campus IS DISTINCT FROM COALESCE(u.campus, cs.campus)
      );

    -- lab_sections updates - ONLY if something actually changed
    UPDATE public.lab_sections ls
    SET
      meeting_location = COALESCE(u.meeting_location, ls.meeting_location),
      meeting_times = COALESCE(u.meeting_times, ls.meeting_times),
      campus = COALESCE(u.campus, ls.campus),
      day_of_week = COALESCE(u.day_of_week, ls.day_of_week),
      start_time = COALESCE(u.start_time, ls.start_time),
      end_time = COALESCE(u.end_time, ls.end_time)
    FROM tmp_section_updates u
    WHERE u.section_type = 'lab'
      AND ls.class_id = p_class_id
      AND ls.sis_crn = u.sis_crn
      AND ls.id IN (SELECT id FROM tmp_enabled_lab_sections)
      -- Only update if at least one field actually changed
      AND (
        ls.meeting_location IS DISTINCT FROM COALESCE(u.meeting_location, ls.meeting_location)
        OR ls.meeting_times IS DISTINCT FROM COALESCE(u.meeting_times, ls.meeting_times)
        OR ls.campus IS DISTINCT FROM COALESCE(u.campus, ls.campus)
        OR ls.day_of_week IS DISTINCT FROM COALESCE(u.day_of_week, ls.day_of_week)
        OR ls.start_time IS DISTINCT FROM COALESCE(u.start_time, ls.start_time)
        OR ls.end_time IS DISTINCT FROM COALESCE(u.end_time, ls.end_time)
      );
  END IF;

  -- Track changes
  CREATE TEMP TABLE tmp_change_counts (
    invitations_created integer NOT NULL DEFAULT 0,
    invitations_updated integer NOT NULL DEFAULT 0,
    invitations_expired integer NOT NULL DEFAULT 0,
    invitations_reactivated integer NOT NULL DEFAULT 0,
    enrollments_created integer NOT NULL DEFAULT 0,
    enrollments_updated integer NOT NULL DEFAULT 0,
    enrollments_disabled integer NOT NULL DEFAULT 0,
    enrollments_reenabled integer NOT NULL DEFAULT 0,
    enrollments_adopted integer NOT NULL DEFAULT 0
  ) ON COMMIT DROP;
  INSERT INTO tmp_change_counts DEFAULT VALUES;

  -- instructor > grader > student
  -- We do not downgrade roles (only upgrade).
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
      SELECT
        r.sis_user_id,
        r.name,
        r.role,
        r.class_section_id,
        r.lab_section_id,
        u.user_id AS existing_user_id
      FROM tmp_sis_roster_resolved r
      JOIN public.users u
        ON u.sis_user_id = r.sis_user_id
      LEFT JOIN public.user_roles ur
        ON ur.class_id = p_class_id
       AND ur.user_id = u.user_id
      WHERE ur.id IS NULL
    LOOP
      v_user_role_id := public.create_user_role_for_existing_user(
        rec.existing_user_id,
        p_class_id,
        rec.role,
        rec.name,
        rec.sis_user_id
      );

      UPDATE public.user_roles
      SET
        class_section_id = rec.class_section_id,
        lab_section_id = rec.lab_section_id,
        disabled = false,
        sis_sync_opt_out = false
      WHERE id = v_user_role_id;

      UPDATE tmp_change_counts
      SET enrollments_created = enrollments_created + 1
      WHERE true;

      -- Best-effort: mark any invitation accepted (it may have been created earlier)
      UPDATE public.invitations
      SET
        status = 'accepted',
        accepted_at = COALESCE(accepted_at, now()),
        updated_at = now()
      WHERE class_id = p_class_id
        AND sis_user_id = rec.sis_user_id
        AND status IN ('pending', 'expired');
    END LOOP;

    -- 3) Update existing enrollments for users present in roster
    FOR rec IN
      SELECT
        r.sis_user_id,
        r.name,
        r.role AS incoming_role,
        r.class_section_id AS incoming_class_section_id,
        r.lab_section_id AS incoming_lab_section_id,
        u.user_id,
        u.sis_user_id AS users_sis_user_id,
        ur.id AS user_role_id,
        ur.role AS current_role,
        ur.disabled,
        ur.canvas_id,
        COALESCE(ur.sis_sync_opt_out, false) AS sis_sync_opt_out
      FROM tmp_sis_roster_resolved r
      JOIN public.users u
        ON u.sis_user_id = r.sis_user_id
      JOIN public.user_roles ur
        ON ur.class_id = p_class_id
       AND ur.user_id = u.user_id
    LOOP
      IF rec.sis_sync_opt_out THEN
        CONTINUE;
      END IF;

      v_is_manual := rec.canvas_id IS NULL;

      v_current_prec := CASE rec.current_role WHEN 'instructor' THEN 3 WHEN 'grader' THEN 2 ELSE 1 END;
      v_incoming_prec := CASE rec.incoming_role WHEN 'instructor' THEN 3 WHEN 'grader' THEN 2 ELSE 1 END;
      v_new_role := CASE WHEN v_incoming_prec > v_current_prec THEN rec.incoming_role ELSE rec.current_role END;

      IF v_is_manual THEN
        UPDATE public.user_roles
        SET
          canvas_id = rec.sis_user_id::numeric,
          role = v_new_role,
          class_section_id = rec.incoming_class_section_id,
          lab_section_id = rec.incoming_lab_section_id,
          disabled = false
        WHERE id = rec.user_role_id;

        UPDATE tmp_change_counts
        SET enrollments_adopted = enrollments_adopted + 1
        WHERE true;
      ELSE
        UPDATE public.user_roles
        SET
          role = v_new_role,
          class_section_id = rec.incoming_class_section_id,
          lab_section_id = rec.incoming_lab_section_id,
          disabled = false
        WHERE id = rec.user_role_id
          AND (
            role IS DISTINCT FROM v_new_role OR
            class_section_id IS DISTINCT FROM rec.incoming_class_section_id OR
            lab_section_id IS DISTINCT FROM rec.incoming_lab_section_id OR
            disabled = true
          );

        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows > 0 THEN
          UPDATE tmp_change_counts
          SET enrollments_updated = enrollments_updated + 1
          WHERE true;
        END IF;
      END IF;

      -- Count re-enables separately (best-effort)
      IF rec.disabled = true THEN
        v_enrollments_reenabled := v_enrollments_reenabled + 1;
      END IF;

      -- Best-effort: adopt/reactivate invitations for this SIS user (does not affect opted-out enrollments).
      UPDATE public.invitations i
      SET
        sis_managed = true,
        role = v_new_role,
        class_section_id = rec.incoming_class_section_id,
        lab_section_id = rec.incoming_lab_section_id,
        status = CASE WHEN i.status = 'expired' THEN 'pending' ELSE i.status END,
        updated_at = now()
      WHERE i.class_id = p_class_id
        AND i.sis_user_id = rec.sis_user_id
        AND i.status IN ('pending', 'expired')
        AND (i.sis_managed = false OR i.status = 'expired');

      UPDATE public.invitations i
      SET
        status = 'accepted',
        accepted_at = COALESCE(i.accepted_at, now()),
        updated_at = now()
      WHERE i.class_id = p_class_id
        AND i.sis_user_id = rec.sis_user_id
        AND i.status = 'pending'
        AND i.sis_managed = true;
    END LOOP;

    -- 4) Create/Update invitations for users without accounts
    FOR rec IN
      SELECT
        r.sis_user_id,
        r.name,
        r.role,
        r.class_section_id,
        r.lab_section_id
      FROM tmp_sis_roster_resolved r
      LEFT JOIN public.users u
        ON u.sis_user_id = r.sis_user_id
      WHERE u.user_id IS NULL
    LOOP
      SELECT *
      INTO v_existing_inv
      FROM public.invitations i
      WHERE i.class_id = p_class_id
        AND i.sis_user_id = rec.sis_user_id
      LIMIT 1;

      IF FOUND THEN
        UPDATE public.invitations i
        SET
          sis_managed = true,
          role = rec.role,
          name = COALESCE(rec.name, i.name),
          class_section_id = rec.class_section_id,
          lab_section_id = rec.lab_section_id,
          status = CASE WHEN i.status = 'expired' THEN 'pending' ELSE i.status END,
          updated_at = now()
        WHERE i.id = v_existing_inv.id
          AND i.status IN ('pending', 'expired');

        IF v_existing_inv.status = 'expired' THEN
          UPDATE tmp_change_counts
          SET invitations_reactivated = invitations_reactivated + 1
          WHERE true;
        ELSE
          UPDATE tmp_change_counts
          SET invitations_updated = invitations_updated + 1
          WHERE true;
        END IF;
      ELSE
        v_inv_id := public.create_invitation(
          p_class_id,
          rec.role,
          rec.sis_user_id,
          NULL,
          rec.name,
          v_admin_user_id,
          rec.class_section_id,
          rec.lab_section_id,
          true
        );
        PERFORM v_inv_id;
        UPDATE tmp_change_counts
        SET invitations_created = invitations_created + 1
        WHERE true;
      END IF;
    END LOOP;
  END;

  -- 5) Handle missing users (drop from SIS): expire invitations + disable enrollments (SIS-managed only)
  IF v_expire_missing THEN
    -- Expire invitations not present in roster, but only those managed by SIS and in SIS-enabled sections.
    WITH present AS (
      SELECT sis_user_id FROM tmp_sis_roster_resolved
    )
    UPDATE public.invitations i
    SET
      status = 'expired',
      updated_at = now()
    WHERE i.class_id = p_class_id
      AND i.sis_managed = true
      AND i.status IN ('pending', 'accepted')
      AND NOT EXISTS (SELECT 1 FROM present p WHERE p.sis_user_id = i.sis_user_id)
      AND (i.class_section_id IS NULL OR i.class_section_id IN (SELECT id FROM tmp_enabled_class_sections))
      AND (i.lab_section_id IS NULL OR i.lab_section_id IN (SELECT id FROM tmp_enabled_lab_sections));

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_invitations_expired := v_rows;
    -- Disable enrollments not present in roster, but only SIS-managed and not opted out and in enabled sections.
    WITH present AS (
      SELECT sis_user_id FROM tmp_sis_roster_resolved
    ),
    candidates AS (
      SELECT
        ur.id
      FROM public.user_roles ur
      JOIN public.users u
        ON u.user_id = ur.user_id
      LEFT JOIN public.invitations inv
        ON inv.id = ur.invitation_id
      WHERE ur.class_id = p_class_id
        AND COALESCE(ur.disabled, false) = false
        AND COALESCE(ur.sis_sync_opt_out, false) = false
        AND u.sis_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM present p WHERE p.sis_user_id = u.sis_user_id)
        -- SIS-managed enrollment: either linked invitation is SIS-managed, or canvas_id matches SIS user id
        AND (
          (inv.id IS NOT NULL AND inv.sis_managed = true) OR
          (ur.canvas_id IS NOT NULL AND ur.canvas_id = u.sis_user_id::numeric)
        )
        AND (ur.class_section_id IS NULL OR ur.class_section_id IN (SELECT id FROM tmp_enabled_class_sections))
        AND (ur.lab_section_id IS NULL OR ur.lab_section_id IN (SELECT id FROM tmp_enabled_lab_sections))
    )
    UPDATE public.user_roles ur
    SET disabled = true
    WHERE ur.id IN (SELECT id FROM candidates);

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_enrollments_disabled := v_rows;
  END IF;

  -- Build result
  SELECT jsonb_build_object(
    'success', true,
    'class_id', p_class_id,
    'expire_missing', v_expire_missing,
    'counts', jsonb_build_object(
      'invitations_created', (SELECT invitations_created FROM tmp_change_counts),
      'invitations_updated', (SELECT invitations_updated FROM tmp_change_counts),
      'invitations_expired', v_invitations_expired,
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

COMMENT ON FUNCTION "public"."sis_sync_enrollment"("p_class_id" bigint, "p_roster_data" "jsonb", "p_sync_options" "jsonb") IS 
'Atomically applies an SIS roster sync for a class. Now includes real-change filters on section updates to prevent unnecessary writes when nothing changed.';
