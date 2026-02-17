-- Office Hours Queue Enhancements
-- Adds: course-level description, demo queue mode, ordinal-based ordering

-- 1. Add office_hours_description to classes table
ALTER TABLE public.classes ADD COLUMN IF NOT EXISTS office_hours_description TEXT;

-- 2. Update only_calendar_or_discord_ids_changed() to allow office_hours_description
CREATE OR REPLACE FUNCTION public.only_calendar_or_discord_ids_changed(new_row public.classes)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (
      SELECT COALESCE(
        (
          SELECT bool_and(changed.key = ANY(ARRAY[
            'discord_server_id',
            'discord_channel_group_id',
            'office_hours_ics_url',
            'events_ics_url',
            'office_hours_description',
            'updated_at'
          ]))
          FROM (
            SELECT t.key
            FROM jsonb_each(to_jsonb(new_row)) AS t(key, value)
            WHERE (to_jsonb(old_row)->t.key) IS DISTINCT FROM t.value
          ) AS changed
        ),
        true  -- no differences -> allow
      )
      FROM public.classes old_row
      WHERE old_row.id = new_row.id
    ),
    false -- no matching row found
  );
$$;

-- 3. Add is_demo and ordinal to help_queues table
ALTER TABLE public.help_queues ADD COLUMN IF NOT EXISTS is_demo BOOLEAN DEFAULT FALSE NOT NULL;
ALTER TABLE public.help_queues ADD COLUMN IF NOT EXISTS ordinal INTEGER DEFAULT 0 NOT NULL;

-- 4. Initialize ordinals for existing queues (per class)
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY class_id ORDER BY id) - 1 AS new_ordinal
  FROM public.help_queues
)
UPDATE public.help_queues SET ordinal = ranked.new_ordinal
FROM ranked WHERE help_queues.id = ranked.id;

-- 5. Create ordinal enforcement trigger function
CREATE OR REPLACE FUNCTION public.help_queues_enforce_ordinal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  max_ordinal integer;
BEGIN
  -- Avoid re-entrant work when our own UPDATEs fire the trigger
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Take per-class advisory locks to serialize operations and avoid races
  IF TG_OP = 'UPDATE' AND NEW.class_id IS DISTINCT FROM OLD.class_id THEN
    IF OLD.class_id < NEW.class_id THEN
      PERFORM pg_advisory_xact_lock(OLD.class_id);
      PERFORM pg_advisory_xact_lock(NEW.class_id);
    ELSE
      PERFORM pg_advisory_xact_lock(NEW.class_id);
      PERFORM pg_advisory_xact_lock(OLD.class_id);
    END IF;
  ELSE
    PERFORM pg_advisory_xact_lock(NEW.class_id);
  END IF;

  -- Handle NULL or negative ordinal
  IF NEW.ordinal IS NULL THEN
    SELECT COALESCE(MAX(ordinal), -1) + 1
      INTO NEW.ordinal
      FROM public.help_queues
     WHERE class_id = NEW.class_id
       AND id != NEW.id;
  ELSIF NEW.ordinal < 0 THEN
    NEW.ordinal := 0;
  END IF;

  -- Handle conflicts by shifting other rows
  IF TG_OP = 'INSERT' THEN
    -- Shift right any conflicting or following queues
    UPDATE public.help_queues
       SET ordinal = ordinal + 1
     WHERE class_id = NEW.class_id
       AND ordinal >= NEW.ordinal
       AND id != NEW.id;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Moving across classes: close gap in old, insert into new
    IF NEW.class_id IS DISTINCT FROM OLD.class_id THEN
      -- Close gap in old class
      IF OLD.ordinal IS NOT NULL THEN
        UPDATE public.help_queues
           SET ordinal = ordinal - 1
         WHERE class_id = OLD.class_id
           AND ordinal > OLD.ordinal
           AND id != NEW.id;
      END IF;

      -- Make room in new class
      UPDATE public.help_queues
         SET ordinal = ordinal + 1
       WHERE class_id = NEW.class_id
         AND ordinal >= NEW.ordinal
         AND id != NEW.id;

    -- Within same class: reposition if changed
    ELSIF NEW.ordinal IS DISTINCT FROM OLD.ordinal AND NEW.class_id = OLD.class_id THEN
      IF OLD.ordinal IS NOT NULL THEN
        -- Moving up: increment rows in the range [NEW.ordinal, OLD.ordinal)
        IF NEW.ordinal < OLD.ordinal THEN
          UPDATE public.help_queues
             SET ordinal = ordinal + 1
           WHERE class_id = NEW.class_id
             AND ordinal >= NEW.ordinal
             AND ordinal < OLD.ordinal
             AND id != NEW.id;
        -- Moving down: decrement rows in the range (OLD.ordinal, NEW.ordinal]
        ELSIF NEW.ordinal > OLD.ordinal THEN
          UPDATE public.help_queues
             SET ordinal = ordinal - 1
           WHERE class_id = NEW.class_id
             AND ordinal <= NEW.ordinal
             AND ordinal > OLD.ordinal
             AND id != NEW.id;
        END IF;
      -- OLD.ordinal IS NULL: make room at new position
      ELSE
        UPDATE public.help_queues
           SET ordinal = ordinal + 1
         WHERE class_id = NEW.class_id
           AND ordinal >= NEW.ordinal
           AND id != NEW.id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

-- 6. Create trigger for ordinal enforcement
DROP TRIGGER IF EXISTS help_queues_enforce_ordinal_tr ON public.help_queues;

CREATE TRIGGER help_queues_enforce_ordinal_tr
BEFORE INSERT OR UPDATE OF ordinal, class_id ON public.help_queues
FOR EACH ROW
EXECUTE FUNCTION public.help_queues_enforce_ordinal();

-- 7. Update create_help_request_notification to skip demo queues
CREATE OR REPLACE FUNCTION public.create_help_request_notification(
  p_class_id bigint,
  p_notification_type text,
  p_help_request_id bigint,
  p_help_queue_id bigint,
  p_help_queue_name text,
  p_creator_profile_id uuid,
  p_creator_name text,
  p_assignee_profile_id uuid DEFAULT NULL,
  p_assignee_name text DEFAULT NULL,
  p_status public.help_request_status DEFAULT NULL,
  p_request_preview text DEFAULT '',
  p_is_private boolean DEFAULT false,
  p_action text DEFAULT 'created'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
declare
  notification_body jsonb;
  v_is_demo boolean;
begin
  -- Check if queue is demo - skip notifications for demo queues
  SELECT is_demo INTO v_is_demo
  FROM public.help_queues
  WHERE id = p_help_queue_id;

  IF v_is_demo THEN
    -- Skip all notifications for demo queues
    RETURN;
  END IF;

  if p_notification_type = 'help_request' then
    notification_body := jsonb_build_object(
      'type', 'help_request',
      'action', p_action,
      'help_request_id', p_help_request_id,
      'help_queue_id', p_help_queue_id,
      'help_queue_name', p_help_queue_name,
      'creator_profile_id', p_creator_profile_id,
      'creator_name', p_creator_name,
      'assignee_profile_id', p_assignee_profile_id,
      'assignee_name', p_assignee_name,
      'status', p_status,
      'request_preview', p_request_preview,
      -- Enrich with subject/body for email templates and digests
      'request_subject', coalesce(
        (
          select hrt.name
          from public.help_request_templates hrt
          where hrt.id = (
            select hr.template_id from public.help_requests hr where hr.id = p_help_request_id
          )
        ),
        'General'
      ),
      'request_body', (
        select hr.request from public.help_requests hr where hr.id = p_help_request_id
      ),
      'is_private', p_is_private
    );
  elsif p_notification_type is null then
    raise exception 'create_help_request_notification: p_notification_type must not be null';
  else
    -- Future-proof: explicitly reject unsupported types
    raise exception 'create_help_request_notification: unsupported p_notification_type=%', p_notification_type;
  end if;

  -- On creation: notify instructors and graders only (do NOT blast the entire class)
  if p_action = 'created' then
    insert into public.notifications (user_id, class_id, subject, body)
    select distinct
      ur.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.user_roles ur
    left join public.notification_preferences np
      on np.user_id = ur.user_id and np.class_id = p_class_id
    left join public.users u
      on u.user_id = ur.user_id
    where ur.class_id = p_class_id
      and ur.role in ('instructor', 'grader')
      -- Default to 'none' if Discord linked, otherwise 'all'
      and coalesce(
        np.help_request_creation_notification::text,
        CASE 
          WHEN u.discord_id IS NOT NULL AND ur.role IN ('instructor', 'grader') THEN 'none'
          ELSE 'all'
        END
      ) <> 'none'
      and (
        coalesce(
          np.help_request_creation_notification::text,
          CASE 
            WHEN u.discord_id IS NOT NULL AND ur.role IN ('instructor', 'grader') THEN 'none'
            ELSE 'all'
          END
        ) = 'all'
        or (
          coalesce(
            np.help_request_creation_notification::text,
            CASE 
              WHEN u.discord_id IS NOT NULL AND ur.role IN ('instructor', 'grader') THEN 'none'
              ELSE 'all'
            END
          ) = 'only_active_queue'
          and exists (
            select 1
            from public.help_queue_assignments hqa
            where hqa.class_id = p_class_id
              and hqa.help_queue_id = p_help_queue_id
              and hqa.ta_profile_id = ur.private_profile_id
              and hqa.is_active = true
              and hqa.ended_at is null
          )
        )
      );

    -- Ensure the creator is watching their own request
    insert into public.help_request_watchers (user_id, help_request_id, class_id, enabled)
    select ur.user_id, p_help_request_id, p_class_id, true
    from public.user_roles ur
    where ur.private_profile_id = p_creator_profile_id
      and ur.class_id = p_class_id
    on conflict (user_id, help_request_id) do nothing;

  else
    -- For assignment/status changes: notify watchers
    insert into public.notifications (user_id, class_id, subject, body)
    select 
      hrw.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.help_request_watchers hrw
    where hrw.help_request_id = p_help_request_id
      and hrw.enabled = true;
  end if;
end;
$$;

-- 8. Update trigger_discord_help_request_notification to skip demo queues
CREATE OR REPLACE FUNCTION public.trigger_discord_help_request_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_is_demo boolean;
BEGIN
  -- Check if queue is demo - skip Discord notifications for demo queues
  SELECT is_demo INTO v_is_demo
  FROM public.help_queues
  WHERE id = NEW.help_queue;

  IF v_is_demo THEN
    RETURN NEW; -- Skip Discord notifications
  END IF;

  -- On INSERT: send created message
  IF TG_OP = 'INSERT' THEN
    PERFORM public.enqueue_discord_help_request_message(NEW.id, 'created');
    RETURN NEW;
  END IF;

  -- On UPDATE: send updated message if status changed
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IS DISTINCT FROM NEW.status THEN
      IF NEW.status = 'resolved' THEN
        PERFORM public.enqueue_discord_help_request_message(NEW.id, 'resolved');
      ELSE
        PERFORM public.enqueue_discord_help_request_message(NEW.id, 'updated');
      END IF;
    ELSIF OLD.assignee IS DISTINCT FROM NEW.assignee THEN
      -- Assignment changed
      PERFORM public.enqueue_discord_help_request_message(NEW.id, 'updated');
    END IF;
    RETURN NEW;
  END IF;

  RETURN NULL;
END;
$$;

-- 9. Add resolved_help_queue_id column to calendar_events for intelligent queue mapping
ALTER TABLE public.calendar_events 
ADD COLUMN IF NOT EXISTS resolved_help_queue_id bigint 
REFERENCES public.help_queues(id) ON DELETE SET NULL;

-- 10. Create function to resolve calendar event queue mappings using fuzzy matching
CREATE OR REPLACE FUNCTION public.resolve_calendar_event_queues(p_class_id bigint DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_event RECORD;
  v_resolved_queue_id bigint;
  v_matched_staff_name text;
  v_matched_staff_role text;
  v_extracted_queue_name text;
  v_extracted_organizer_name text;
BEGIN
  -- Process all events for the specified class, or all events if p_class_id is NULL
  FOR v_event IN
    SELECT 
      ce.id,
      ce.class_id,
      ce.title,
      ce.queue_name,
      ce.organizer_name
    FROM public.calendar_events ce
    WHERE ce.calendar_type = 'office_hours'
      AND (p_class_id IS NULL OR ce.class_id = p_class_id)
  LOOP
    v_resolved_queue_id := NULL;
    v_matched_staff_name := NULL;
    v_matched_staff_role := NULL;
    v_extracted_queue_name := NULL;
    v_extracted_organizer_name := NULL;

    -- Extract queue name and organizer from title if queue_name is NULL
    -- Handles formats like:
    --   "Name (Queue Name)" -> queue="Queue Name", organizer="Name"
    --   "Name (Queue Name) [Location]" -> queue="Queue Name", organizer="Name"
    --   "Name (Queue Name) [In-person]" -> queue="Queue Name", organizer="Name"
    IF v_event.queue_name IS NULL AND v_event.title IS NOT NULL THEN
      -- Extract queue name from parentheses (handles suffix after closing paren)
      -- Pattern: anything before (, content in parens, optional suffix
      v_extracted_queue_name := (
        SELECT (regexp_matches(v_event.title, '\(([^)]+)\)', 'i'))[1]
      );
      -- Extract organizer name (everything before the opening parenthesis)
      v_extracted_organizer_name := TRIM(
        regexp_replace(v_event.title, '\s*\([^)]+\).*$', '', 'i')
      );
    ELSE
      v_extracted_queue_name := v_event.queue_name;
      v_extracted_organizer_name := v_event.organizer_name;
    END IF;

    -- Step 1: Try direct match on queue_name (or extracted queue name)
    IF v_extracted_queue_name IS NOT NULL THEN
      -- First try exact match
      SELECT id INTO v_resolved_queue_id
      FROM public.help_queues
      WHERE class_id = v_event.class_id
        AND LOWER(TRIM(name)) = LOWER(TRIM(v_extracted_queue_name))
      LIMIT 1;

      -- If no exact match, try partial match (queue name contains or is contained)
      IF v_resolved_queue_id IS NULL THEN
        SELECT id INTO v_resolved_queue_id
        FROM public.help_queues
        WHERE class_id = v_event.class_id
          AND (
            LOWER(name) ILIKE '%' || LOWER(TRIM(v_extracted_queue_name)) || '%'
            OR LOWER(TRIM(v_extracted_queue_name)) ILIKE '%' || LOWER(name) || '%'
          )
        ORDER BY length(name) ASC, name ASC
        LIMIT 1;
      END IF;
    END IF;

    -- Step 2: If no direct match, try fuzzy matching organizer_name to staff, then find matching queue
    IF v_resolved_queue_id IS NULL AND v_extracted_organizer_name IS NOT NULL THEN
      -- Find best matching staff member using fuzzy matching
      WITH class_staff AS (
        -- Get all graders and instructors for the class
        SELECT DISTINCT
          p.name AS staff_name,
          ur.role AS staff_role
        FROM public.user_roles ur
        INNER JOIN public.profiles p ON p.id = ur.private_profile_id
        WHERE ur.class_id = v_event.class_id
          AND ur.role IN ('grader', 'instructor')
          AND ur.disabled = false
      ),
      matched_staff AS (
        -- Find best matching staff member using fuzzy matching
        SELECT 
          cs.staff_name,
          cs.staff_role,
          -- Calculate similarity score with first name boost
          CASE
            WHEN LOWER(SPLIT_PART(TRIM(v_extracted_organizer_name), ' ', 1)) = LOWER(SPLIT_PART(TRIM(cs.staff_name), ' ', 1))
              AND LENGTH(TRIM(v_extracted_organizer_name)) < LENGTH(TRIM(cs.staff_name))
            THEN GREATEST(
              extensions.similarity(
                LOWER(TRIM(v_extracted_organizer_name)), 
                LOWER(TRIM(cs.staff_name))
              ),
              0.75  -- High score for first name matches
            )
            ELSE extensions.similarity(
              LOWER(TRIM(v_extracted_organizer_name)), 
              LOWER(TRIM(cs.staff_name))
            )
          END AS similarity_score
        FROM class_staff cs
        WHERE cs.staff_name IS NOT NULL
          AND (
            -- Exact match
            LOWER(TRIM(v_extracted_organizer_name)) = LOWER(TRIM(cs.staff_name))
            -- First name match
            OR LOWER(SPLIT_PART(TRIM(v_extracted_organizer_name), ' ', 1)) = LOWER(SPLIT_PART(TRIM(cs.staff_name), ' ', 1))
            -- Similarity match (>= 0.3 threshold)
            OR extensions.similarity(
              LOWER(TRIM(v_extracted_organizer_name)), 
              LOWER(TRIM(cs.staff_name))
            ) >= 0.3
          )
      ),
      best_match AS (
        -- Get the best matching staff member (highest similarity score)
        SELECT 
          staff_name,
          staff_role
        FROM matched_staff
        ORDER BY similarity_score DESC
        LIMIT 1
      )
      -- Get the matched staff member
      SELECT bm.staff_name, bm.staff_role INTO v_matched_staff_name, v_matched_staff_role
      FROM best_match bm;

      -- If we found a matching staff member, try to find a queue matching their name
      IF v_matched_staff_name IS NOT NULL THEN
        SELECT hq.id INTO v_resolved_queue_id
        FROM public.help_queues hq
        WHERE hq.class_id = v_event.class_id
          AND hq.name ILIKE '%' || v_matched_staff_name || '%'
        LIMIT 1;
      END IF;
    END IF;

    -- Step 3: Fall back to queue with ordinal = 0 (default queue)
    -- This applies if:
    -- - No queue_name match found
    -- - Staff matched but no queue with their name exists
    -- - No staff match found
    IF v_resolved_queue_id IS NULL THEN
      SELECT id INTO v_resolved_queue_id
      FROM public.help_queues
      WHERE class_id = v_event.class_id
        AND ordinal = 0
      LIMIT 1;
    END IF;

    -- Update the event with resolved queue ID
    UPDATE public.calendar_events
    SET resolved_help_queue_id = v_resolved_queue_id
    WHERE id = v_event.id;
  END LOOP;
END;
$$;

-- 11. Update sync_calendar_events to resolve queue mappings after insert/update
CREATE OR REPLACE FUNCTION public.sync_calendar_events(
  p_class_id bigint, 
  p_calendar_type text, 
  p_parsed_events jsonb, 
  p_has_discord_server boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_now timestamptz := NOW();
  v_added_count int := 0;
  v_updated_count int := 0;
  v_deleted_count int := 0;
  v_error_count int := 0;
  v_errors text[] := '{}';
  v_result jsonb;
  v_row_count integer;
BEGIN
  -- 1. Create temp table from parsed events (single parse, reusable)
  -- This avoids repeated jsonb_array_elements calls and array_append operations
  CREATE TEMP TABLE temp_parsed_events ON COMMIT DROP AS
  SELECT 
    (x->>'uid')::text as uid,
    (x->>'title')::text as title,
    NULLIF(x->>'description', '') as description,
    (x->>'start_time')::timestamptz as start_time,
    (x->>'end_time')::timestamptz as end_time,
    NULLIF(x->>'location', '') as location,
    NULLIF(x->>'queue_name', '') as queue_name,
    NULLIF(x->>'organizer_name', '') as organizer_name,
    COALESCE(x->'raw_ics_data', '{}'::jsonb) as raw_ics_data
  FROM jsonb_array_elements(p_parsed_events) x
  WHERE x->>'uid' IS NOT NULL;

  -- Create index on temp table for efficient joins
  CREATE INDEX ON temp_parsed_events(uid);

  -- 2. Batch INSERT new events using LEFT JOIN anti-pattern
  -- This is much faster than checking existence row-by-row
  BEGIN
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
    )
    SELECT 
      p_class_id,
      p_calendar_type,
      tpe.uid,
      tpe.title,
      tpe.description,
      tpe.start_time,
      tpe.end_time,
      tpe.location,
      tpe.queue_name,
      tpe.organizer_name,
      tpe.raw_ics_data,
      CASE WHEN tpe.end_time <= v_now THEN v_now ELSE NULL END,
      CASE WHEN tpe.start_time <= v_now THEN v_now ELSE NULL END,
      CASE WHEN tpe.end_time <= v_now THEN v_now ELSE NULL END
    FROM temp_parsed_events tpe
    LEFT JOIN public.calendar_events ce 
      ON ce.class_id = p_class_id 
      AND ce.calendar_type = p_calendar_type 
      AND ce.uid = tpe.uid
    WHERE ce.id IS NULL
    ON CONFLICT (class_id, calendar_type, uid) DO NOTHING;  -- Handle race conditions
    
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_added_count := v_row_count;
  EXCEPTION WHEN OTHERS THEN
    v_error_count := v_error_count + 1;
    v_errors := array_append(v_errors, format('Failed to insert events: %s', SQLERRM));
  END;

  -- 3. Batch UPDATE changed events using single UPDATE with JOIN
  -- This replaces the row-by-row update loop
  BEGIN
    UPDATE public.calendar_events ce
    SET
      title = tpe.title,
      description = tpe.description,
      start_time = tpe.start_time,
      end_time = tpe.end_time,
      location = tpe.location,
      queue_name = tpe.queue_name,
      organizer_name = tpe.organizer_name,
      raw_ics_data = tpe.raw_ics_data,
      -- Reset resolved_help_queue_id when queue_name or organizer_name changes
      resolved_help_queue_id = NULL,
      -- Reset announcement flags if times changed and event is in the future
      change_announced_at = CASE 
        WHEN ce.end_time != tpe.end_time AND tpe.end_time > v_now THEN NULL
        WHEN tpe.end_time <= v_now THEN v_now 
        ELSE ce.change_announced_at
      END,
      start_announced_at = CASE
        WHEN ce.start_time != tpe.start_time AND tpe.start_time > v_now THEN NULL
        WHEN ce.start_time != tpe.start_time AND tpe.start_time <= v_now THEN v_now
        WHEN ce.start_time = tpe.start_time AND ce.start_announced_at IS NULL AND tpe.start_time <= v_now THEN v_now
        ELSE ce.start_announced_at
      END,
      end_announced_at = CASE
        WHEN ce.end_time != tpe.end_time AND tpe.end_time > v_now THEN NULL
        WHEN ce.end_time != tpe.end_time AND tpe.end_time <= v_now THEN v_now
        WHEN ce.end_time = tpe.end_time AND ce.end_announced_at IS NULL AND tpe.end_time <= v_now THEN v_now
        ELSE ce.end_announced_at
      END
    FROM temp_parsed_events tpe
    WHERE ce.class_id = p_class_id
      AND ce.calendar_type = p_calendar_type
      AND ce.uid = tpe.uid
      AND (
        ce.title != tpe.title
        OR COALESCE(ce.description, '') != COALESCE(tpe.description, '')
        OR ce.start_time != tpe.start_time
        OR ce.end_time != tpe.end_time
        OR COALESCE(ce.location, '') != COALESCE(tpe.location, '')
        OR COALESCE(ce.queue_name, '') != COALESCE(tpe.queue_name, '')
        OR COALESCE(ce.organizer_name, '') != COALESCE(tpe.organizer_name, '')
      );
    
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_updated_count := v_row_count;
  EXCEPTION WHEN OTHERS THEN
    v_error_count := v_error_count + 1;
    v_errors := array_append(v_errors, format('Failed to update events: %s', SQLERRM));
  END;

  -- 4. Batch DELETE removed events using single DELETE with NOT IN
  -- Only delete recent events (last 30 days) to avoid deleting old historical data
  BEGIN
    DELETE FROM public.calendar_events ce
    WHERE ce.class_id = p_class_id
      AND ce.calendar_type = p_calendar_type
      AND ce.end_time >= (v_now - INTERVAL '30 days')
      AND ce.uid NOT IN (SELECT uid FROM temp_parsed_events);
    
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    v_deleted_count := v_row_count;
  EXCEPTION WHEN OTHERS THEN
    v_error_count := v_error_count + 1;
    v_errors := array_append(v_errors, format('Failed to delete events: %s', SQLERRM));
  END;

  -- 5. Resolve queue mappings for office hours events (new and updated)
  IF p_calendar_type = 'office_hours' THEN
    BEGIN
      PERFORM public.resolve_calendar_event_queues(p_class_id);
    EXCEPTION WHEN OTHERS THEN
      -- Log error but don't fail the sync
      v_error_count := v_error_count + 1;
      v_errors := array_append(v_errors, format('Failed to resolve queue mappings: %s', SQLERRM));
    END;
  END IF;

  -- Return result
  v_result := jsonb_build_object(
    'success', v_error_count = 0,
    'added', v_added_count,
    'updated', v_updated_count,
    'deleted', v_deleted_count,
    'errors', v_errors,
    'error_count', v_error_count
  );

  RETURN v_result;
END;
$$;

-- 12. Backfill resolved_help_queue_id for existing calendar events
-- This will resolve queue mappings for all existing office hours events
DO $$
BEGIN
  PERFORM public.resolve_calendar_event_queues(NULL);
END $$;
