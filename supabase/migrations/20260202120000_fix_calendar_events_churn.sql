-- Fix calendar_events table churn caused by:
-- 1. Timestamp precision issues in sync_calendar_events causing false "changes"
-- 2. process_calendar_announcements updating rows when Discord notifications are disabled
--
-- Root cause: The sync_calendar_events RPC compared timestamps with simple != operator,
-- which could trigger false updates due to sub-second precision differences.
-- Combined with announcement processing running on every sync, this caused
-- hundreds of thousands of unnecessary updates per day.

-- Fix 1: Update sync_calendar_events to use second-precision timestamp comparison
-- This prevents false positives from sub-second differences (e.g., .000Z vs no fractional seconds)

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
      -- Pre-mark past events as announced to avoid unnecessary announcement processing
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
  -- IMPORTANT: Use date_trunc('second', ...) for timestamp comparisons to avoid
  -- false positives from sub-second precision differences. ICS files only have
  -- second precision, but parsing/storage can introduce sub-second values.
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
      -- Reset announcement flags if times changed and event is in the future
      change_announced_at = CASE
        WHEN date_trunc('second', ce.end_time) != date_trunc('second', tpe.end_time) AND tpe.end_time > v_now THEN NULL
        WHEN tpe.end_time <= v_now THEN v_now
        ELSE ce.change_announced_at
      END,
      start_announced_at = CASE
        WHEN date_trunc('second', ce.start_time) != date_trunc('second', tpe.start_time) AND tpe.start_time > v_now THEN NULL
        WHEN date_trunc('second', ce.start_time) != date_trunc('second', tpe.start_time) AND tpe.start_time <= v_now THEN v_now
        WHEN date_trunc('second', ce.start_time) = date_trunc('second', tpe.start_time) AND ce.start_announced_at IS NULL AND tpe.start_time <= v_now THEN v_now
        ELSE ce.start_announced_at
      END,
      end_announced_at = CASE
        WHEN date_trunc('second', ce.end_time) != date_trunc('second', tpe.end_time) AND tpe.end_time > v_now THEN NULL
        WHEN date_trunc('second', ce.end_time) != date_trunc('second', tpe.end_time) AND tpe.end_time <= v_now THEN v_now
        WHEN date_trunc('second', ce.end_time) = date_trunc('second', tpe.end_time) AND ce.end_announced_at IS NULL AND tpe.end_time <= v_now THEN v_now
        ELSE ce.end_announced_at
      END
    FROM temp_parsed_events tpe
    WHERE ce.class_id = p_class_id
      AND ce.calendar_type = p_calendar_type
      AND ce.uid = tpe.uid
      -- Use date_trunc for timestamp comparisons to avoid sub-second precision issues
      AND (
        ce.title IS DISTINCT FROM tpe.title
        OR COALESCE(ce.description, '') IS DISTINCT FROM COALESCE(tpe.description, '')
        OR date_trunc('second', ce.start_time) != date_trunc('second', tpe.start_time)
        OR date_trunc('second', ce.end_time) != date_trunc('second', tpe.end_time)
        OR COALESCE(ce.location, '') IS DISTINCT FROM COALESCE(tpe.location, '')
        OR COALESCE(ce.queue_name, '') IS DISTINCT FROM COALESCE(tpe.queue_name, '')
        OR COALESCE(ce.organizer_name, '') IS DISTINCT FROM COALESCE(tpe.organizer_name, '')
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
$function$;


-- Fix 2: Make process_calendar_announcements a no-op
-- Discord notifications are disabled, so there's no need to track announcement status.
-- This eliminates thousands of unnecessary UPDATE operations per sync cycle.
--
-- If Discord notifications are re-enabled in the future, this function should be
-- updated to actually process announcements again.

CREATE OR REPLACE FUNCTION public.process_calendar_announcements()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Discord notifications are currently disabled.
  -- Return immediately without updating any rows to avoid database churn.
  -- When Discord notifications are re-enabled, restore the announcement logic.
  RETURN jsonb_build_object(
    'success', true,
    'processed_count', 0,
    'messages_queued', 0,
    'change_announcements', 0,
    'start_announcements', 0,
    'end_announcements', 0,
    'skipped', true,
    'reason', 'Discord notifications disabled'
  );
END;
$function$;


-- Add a comment to document the change
COMMENT ON FUNCTION public.process_calendar_announcements() IS
'Processes calendar announcements for Discord. Currently disabled (no-op) to prevent database churn. Re-enable when Discord notifications are turned back on.';

COMMENT ON FUNCTION public.sync_calendar_events(bigint, text, jsonb, boolean) IS
'Syncs calendar events from parsed ICS data. Uses second-precision timestamp comparison to avoid false updates from sub-second differences.';
