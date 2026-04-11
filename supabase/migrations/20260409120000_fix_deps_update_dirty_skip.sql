-- Fix: when source is 'deps_update', always enqueue recalculation even if
-- the row is already dirty. The previous dirty pass used stale dependencies,
-- so a fresh recalculation is required.

CREATE OR REPLACE FUNCTION public.enqueue_gradebook_row_recalculation_batch(p_rows jsonb[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  row_rec jsonb;
  row_message jsonb;
  messages jsonb[];
  rows_to_insert jsonb[];
  class_id_val bigint;
  gradebook_id_val bigint;
  student_id_val uuid;
  is_private_val boolean;
  source_val text;
  skipped_count integer := 0;
  opposite_privacy_rows jsonb[] := ARRAY[]::jsonb[];
BEGIN
  messages := ARRAY[]::jsonb[];
  rows_to_insert := ARRAY[]::jsonb[];

  FOREACH row_rec IN ARRAY p_rows
  LOOP
    class_id_val := (row_rec->>'class_id')::bigint;
    gradebook_id_val := (row_rec->>'gradebook_id')::bigint;
    student_id_val := (row_rec->>'student_id')::uuid;
    is_private_val := (row_rec->>'is_private')::boolean;
    source_val := COALESCE(row_rec->>'source', '');

    -- Per-row advisory lock to avoid duplicate enqueues under concurrency
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        class_id_val::text || ':' || gradebook_id_val::text || ':' || student_id_val::text || ':' || is_private_val::text,
        42
      )::bigint
    );

    -- Gating rules:
    -- - If row is currently recalculating, allow re-enqueue
    -- - If source is 'deps_update', always enqueue (deps changed, stale calc must be redone)
    -- - Else if row is already dirty (and not recalculating), skip enqueue
    IF source_val != 'deps_update' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.gradebook_row_recalc_state s
        WHERE s.class_id = class_id_val
          AND s.gradebook_id = gradebook_id_val
          AND s.student_id = student_id_val
          AND s.is_private = is_private_val
          AND s.is_recalculating = true
      ) THEN
        IF EXISTS (
          SELECT 1 FROM public.gradebook_row_recalc_state s
          WHERE s.class_id = class_id_val
            AND s.gradebook_id = gradebook_id_val
            AND s.student_id = student_id_val
            AND s.is_private = is_private_val
            AND s.dirty = true
            AND s.is_recalculating = false
        ) THEN
          skipped_count := skipped_count + 1;
          CONTINUE;
        END IF;
      END IF;
    END IF;

    -- Build message for queue
    row_message := jsonb_build_object(
      'class_id', class_id_val,
      'gradebook_id', gradebook_id_val,
      'student_id', student_id_val,
      'is_private', is_private_val
    );
    messages := array_append(messages, row_message);
    rows_to_insert := array_append(rows_to_insert, row_rec);

    -- If is_private=true, also enqueue is_private=false
    IF is_private_val = true THEN
      IF NOT EXISTS (
        SELECT 1 FROM unnest(p_rows) AS existing_row
        WHERE (existing_row->>'class_id')::bigint = class_id_val
          AND (existing_row->>'gradebook_id')::bigint = gradebook_id_val
          AND (existing_row->>'student_id')::uuid = student_id_val
          AND (existing_row->>'is_private')::boolean = false
      ) THEN
        opposite_privacy_rows := array_append(opposite_privacy_rows,
          jsonb_build_object(
            'class_id', class_id_val,
            'gradebook_id', gradebook_id_val,
            'student_id', student_id_val,
            'is_private', false,
            'source', source_val
          )
        );
      END IF;
    END IF;
  END LOOP;

  -- Process opposite privacy rows with same gating logic
  IF array_length(opposite_privacy_rows, 1) > 0 THEN
    FOREACH row_rec IN ARRAY opposite_privacy_rows
    LOOP
      class_id_val := (row_rec->>'class_id')::bigint;
      gradebook_id_val := (row_rec->>'gradebook_id')::bigint;
      student_id_val := (row_rec->>'student_id')::uuid;
      is_private_val := false;
      source_val := COALESCE(row_rec->>'source', '');

      PERFORM pg_advisory_xact_lock(
        hashtextextended(
          class_id_val::text || ':' || gradebook_id_val::text || ':' || student_id_val::text || ':false',
          42
        )::bigint
      );

      IF source_val != 'deps_update' THEN
        IF NOT EXISTS (
          SELECT 1 FROM public.gradebook_row_recalc_state s
          WHERE s.class_id = class_id_val
            AND s.gradebook_id = gradebook_id_val
            AND s.student_id = student_id_val
            AND s.is_private = false
            AND s.is_recalculating = true
        ) THEN
          IF EXISTS (
            SELECT 1 FROM public.gradebook_row_recalc_state s
            WHERE s.class_id = class_id_val
              AND s.gradebook_id = gradebook_id_val
              AND s.student_id = student_id_val
              AND s.is_private = false
              AND s.dirty = true
              AND s.is_recalculating = false
          ) THEN
            CONTINUE;
          END IF;
        END IF;
      END IF;

      row_message := jsonb_build_object(
        'class_id', class_id_val,
        'gradebook_id', gradebook_id_val,
        'student_id', student_id_val,
        'is_private', false
      );
      messages := array_append(messages, row_message);
      rows_to_insert := array_append(rows_to_insert, row_rec);
    END LOOP;
  END IF;

  IF array_length(messages, 1) > 0 THEN
    PERFORM pgmq_public.send_batch(
      queue_name := 'gradebook_row_recalculate',
      messages := messages
    );
  END IF;

  IF array_length(rows_to_insert, 1) > 0 THEN
    INSERT INTO public.gradebook_row_recalc_state (
      class_id, gradebook_id, student_id, is_private, dirty, is_recalculating, version
    )
    SELECT DISTINCT ON (class_id, gradebook_id, student_id, is_private)
      (r->>'class_id')::bigint AS class_id,
      (r->>'gradebook_id')::bigint AS gradebook_id,
      (r->>'student_id')::uuid AS student_id,
      (r->>'is_private')::boolean AS is_private,
      true,
      true,
      1
    FROM unnest(rows_to_insert) AS r
    ORDER BY class_id, gradebook_id, student_id, is_private
    ON CONFLICT (class_id, gradebook_id, student_id, is_private)
    DO UPDATE SET
      dirty = true,
      is_recalculating = true,
      version = public.gradebook_row_recalc_state.version + 1,
      updated_at = now();
  END IF;
END;
$function$;
