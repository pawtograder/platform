-- Fix calendar_events sync spam by preventing unnecessary UPDATEs at the source
-- The sync RPC was updating ALL events on every sync due to:
-- 1. Using != instead of IS DISTINCT FROM (NULL handling bug)
-- 2. Missing queue_name/organizer_name in comparison
-- This caused ~660k+ unnecessary writes and broadcasts per day

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
