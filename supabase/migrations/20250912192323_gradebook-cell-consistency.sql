-- Gradebook cell consistency and groundwork for per-student row recalculation
-- 1) Add "dirty" flag to gradebook cells
-- 2) Indexes to support efficient row-level operations (by class, student, privacy)
-- 3) Clear dirty on successful recalculation completion
-- 4) Provide helper to enqueue recalculation for a student's gradebook row (per privacy)
-- 5) Keep existing behavior for is_recalculating (still set during enqueue) to avoid breaking current workers

-- 1) Introduce row-level recalculation state table (per (class, gradebook, student, is_private))
CREATE TABLE IF NOT EXISTS public.gradebook_row_recalc_state (
  class_id bigint NOT NULL,
  gradebook_id bigint NOT NULL,
  student_id uuid NOT NULL,
  is_private boolean NOT NULL,
  dirty boolean NOT NULL DEFAULT false,
  is_recalculating boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, gradebook_id, student_id, is_private)
);

COMMENT ON TABLE public.gradebook_row_recalc_state IS 'Row-level recalculation state flags for a student in a gradebook (per privacy).';
COMMENT ON COLUMN public.gradebook_row_recalc_state.dirty IS 'True when row needs recalculation.';
COMMENT ON COLUMN public.gradebook_row_recalc_state.is_recalculating IS 'True while a row recalculation is in progress.';

-- 2) Indexes for common access patterns
-- Row-state primary key covers lookups; add supporting index by (class_id, student_id, is_private)
CREATE INDEX IF NOT EXISTS idx_gradebook_row_state_class_student_privacy
  ON public.gradebook_row_recalc_state (class_id, student_id, is_private);

-- Index to accelerate updates/selects for a student's entire row (per gradebook and privacy)
CREATE INDEX IF NOT EXISTS idx_gcs_class_gradebook_student_privacy
  ON public.gradebook_column_students (class_id, gradebook_id, student_id, is_private)
  INCLUDE (id);

-- Additional composite index to accelerate row+column updates
CREATE INDEX IF NOT EXISTS idx_gcs_row_and_column
  ON public.gradebook_column_students (class_id, gradebook_id, student_id, is_private, gradebook_column_id);

-- 3) Remove any previous per-cell dirty management created earlier in this migration
DROP TRIGGER IF EXISTS trg_gradebook_clear_dirty_on_finish ON public.gradebook_column_students;
DROP FUNCTION IF EXISTS public.gradebook_clear_dirty_on_finish();

-- 4) Provide helper to enqueue recalculation for a student's gradebook row (per privacy)
-- This prepares for row-level recalculation but uses the existing per-cell queue and helper
-- to avoid changing worker behavior in this migration.
CREATE OR REPLACE FUNCTION public.enqueue_gradebook_row_recalculation(
  p_class_id bigint,
  p_gradebook_id bigint,
  p_student_id uuid,
  p_is_private boolean,
  p_reason text DEFAULT 'row_recalc_request',
  p_trigger_id bigint DEFAULT NULL
) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
DECLARE
  row_message jsonb;
BEGIN
  -- Per-row advisory lock to avoid duplicate enqueues under concurrency
  PERFORM pg_advisory_xact_lock(
    hashtext(p_class_id::text || ':' || p_gradebook_id::text || ':' || p_student_id::text || ':' || p_is_private::text)::bigint
  );

  -- Gating rules against row-state table:
  -- - If row is currently recalculating, allow re-enqueue (ensure newest deps are seen)
  -- - Else if row is already dirty (and not recalculating), skip enqueue
  IF NOT EXISTS (
    SELECT 1 FROM public.gradebook_row_recalc_state s
    WHERE s.class_id = p_class_id
      AND s.gradebook_id = p_gradebook_id
      AND s.student_id = p_student_id
      AND s.is_private = p_is_private
      AND s.is_recalculating = true
  ) THEN
    IF EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state s
      WHERE s.class_id = p_class_id
        AND s.gradebook_id = p_gradebook_id
        AND s.student_id = p_student_id
        AND s.is_private = p_is_private
        AND s.dirty = true
    ) THEN
      RETURN;
    END IF;
  END IF;

  -- Build a single row-level message
  row_message := jsonb_build_object(
    'class_id', p_class_id,
    'gradebook_id', p_gradebook_id,
    'student_id', p_student_id,
    'is_private', p_is_private
  );

  -- Send a single message to the row queue
  PERFORM pgmq_public.send(
    queue_name := 'gradebook_row_recalculate',
    message := row_message
  );

  -- Mark row-state dirty and set recalculating (upsert)
  INSERT INTO public.gradebook_row_recalc_state (class_id, gradebook_id, student_id, is_private, dirty, is_recalculating)
  VALUES (p_class_id, p_gradebook_id, p_student_id, p_is_private, true, true)
  ON CONFLICT (class_id, gradebook_id, student_id, is_private)
  DO UPDATE SET dirty = true, is_recalculating = true, updated_at = now();
END;
$$;

COMMENT ON FUNCTION public.enqueue_gradebook_row_recalculation(bigint, bigint, uuid, boolean, text, bigint)
  IS 'Enqueues recalculation for all gradebook cells of a specific student in a class for the given privacy variant.';

-- 5b) Batch update a student's gradebook row atomically from a jsonb[] of per-column updates
-- Each element in p_updates should be an object with at least { gradebook_column_id } and
-- optional fields: score, score_override, is_missing, is_excused, is_droppable, released,
-- score_override_note, incomplete_values. Only provided keys are updated; others are left as-is.
CREATE OR REPLACE FUNCTION public.update_gradebook_row(
  p_class_id bigint,
  p_gradebook_id bigint,
  p_student_id uuid,
  p_is_private boolean,
  p_updates jsonb[]
) RETURNS integer
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
DECLARE
  updated_count integer := 0;
BEGIN
  IF p_updates IS NULL OR array_length(p_updates, 1) IS NULL THEN
    RETURN 0;
  END IF;

  WITH src AS (
    SELECT u AS obj
    FROM unnest(p_updates) AS u
  ), up AS (
    SELECT
      (obj->>'gradebook_column_id')::bigint AS gradebook_column_id,
      (obj ? 'score') AS has_score,
      (obj->>'score')::numeric AS score,
      (obj ? 'score_override') AS has_score_override,
      (obj->>'score_override')::numeric AS score_override,
      (obj ? 'is_missing') AS has_is_missing,
      (obj->>'is_missing')::boolean AS is_missing,
      (obj ? 'is_excused') AS has_is_excused,
      (obj->>'is_excused')::boolean AS is_excused,
      (obj ? 'is_droppable') AS has_is_droppable,
      (obj->>'is_droppable')::boolean AS is_droppable,
      (obj ? 'released') AS has_released,
      (obj->>'released')::boolean AS released,
      (obj ? 'score_override_note') AS has_score_override_note,
      (obj->>'score_override_note')::text AS score_override_note,
      (obj ? 'incomplete_values') AS has_incomplete_values,
      (obj->'incomplete_values')::jsonb AS incomplete_values
    FROM src
  ), updated AS (
    UPDATE public.gradebook_column_students g
    SET
      score = CASE WHEN up.has_score THEN up.score ELSE g.score END,
      score_override = CASE WHEN up.has_score_override THEN up.score_override ELSE g.score_override END,
      is_missing = CASE WHEN up.has_is_missing THEN up.is_missing ELSE g.is_missing END,
      is_excused = CASE WHEN up.has_is_excused THEN up.is_excused ELSE g.is_excused END,
      is_droppable = CASE WHEN up.has_is_droppable THEN up.is_droppable ELSE g.is_droppable END,
      released = CASE WHEN up.has_released THEN up.released ELSE g.released END,
      score_override_note = CASE WHEN up.has_score_override_note THEN up.score_override_note ELSE g.score_override_note END,
      incomplete_values = CASE WHEN up.has_incomplete_values THEN up.incomplete_values ELSE g.incomplete_values END
    FROM up
    WHERE g.class_id = p_class_id
      AND g.gradebook_id = p_gradebook_id
      AND g.student_id = p_student_id
      AND g.is_private = p_is_private
      AND g.gradebook_column_id = up.gradebook_column_id
      AND (
        (up.has_score AND up.score IS DISTINCT FROM g.score) OR
        (up.has_score_override AND up.score_override IS DISTINCT FROM g.score_override) OR
        (up.has_is_missing AND up.is_missing IS DISTINCT FROM g.is_missing) OR
        (up.has_is_excused AND up.is_excused IS DISTINCT FROM g.is_excused) OR
        (up.has_is_droppable AND up.is_droppable IS DISTINCT FROM g.is_droppable) OR
        (up.has_released AND up.released IS DISTINCT FROM g.released) OR
        (up.has_score_override_note AND up.score_override_note IS DISTINCT FROM g.score_override_note) OR
        (up.has_incomplete_values AND up.incomplete_values IS DISTINCT FROM g.incomplete_values)
      )
    RETURNING 1
  )
  SELECT count(*)::integer INTO updated_count FROM updated;

  RETURN updated_count;
END;
$$;

-- 5a) RLS: mirror gradebook_column_students policies
ALTER TABLE public.gradebook_row_recalc_state ENABLE ROW LEVEL SECURITY;

-- instructors and graders view all
CREATE POLICY "instructors and graders view all (row state)" ON public.gradebook_row_recalc_state
  FOR SELECT TO authenticated
  USING (public.authorizeforclassgrader(class_id));

-- instructors and graders edit
CREATE POLICY "instructors and graders edit (row state)" ON public.gradebook_row_recalc_state
  FOR UPDATE TO authenticated
  USING (public.authorizeforclassgrader(class_id));

-- instructors delete
CREATE POLICY "instructors delete (row state)" ON public.gradebook_row_recalc_state
  FOR DELETE TO authenticated
  USING (public.authorizeforclassinstructor(class_id));

-- students can view their own non-private row states (useful for UIs if needed)
CREATE POLICY "student views non-private only (row state)" ON public.gradebook_row_recalc_state
  FOR SELECT TO authenticated
  USING (public.authorizeforprofile(student_id) AND is_private = false);

-- 5) Update the existing helper to also set dirty=true when enqueuing
-- Keep setting is_recalculating=true here to preserve current dependency coordination until workers are refactored.
CREATE OR REPLACE FUNCTION public.send_gradebook_recalculation_messages(messages jsonb[]) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
DECLARE
  -- Distinct row targets derived from per-cell messages
  _row_messages jsonb[];
BEGIN
  IF messages IS NULL THEN
    RETURN;
  END IF;

  -- Build one row-level message per distinct (class_id, gradebook_id, student_id, is_private)
  WITH targets AS (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM unnest(messages) AS msg
    JOIN public.gradebook_column_students gcs
      ON gcs.id = (msg->>'gradebook_column_student_id')::bigint
  )
  SELECT array_agg(
    jsonb_build_object(
      'class_id', t.class_id,
      'gradebook_id', t.gradebook_id,
      'student_id', t.student_id,
      'is_private', t.is_private
    )
  )
  INTO _row_messages
  FROM targets t;

  IF _row_messages IS NULL THEN
    RETURN;
  END IF;

  -- Send to the new row-level queue
  PERFORM pgmq_public.send_batch(
    queue_name := 'gradebook_row_recalculate',
    messages := _row_messages
  );

  -- Mark entire rows dirty and set recalculating to coordinate workers
  WITH targets AS (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM unnest(messages) AS msg
    JOIN public.gradebook_column_students gcs
      ON gcs.id = (msg->>'gradebook_column_student_id')::bigint
  )
  UPDATE public.gradebook_column_students g
  SET dirty = true,
      is_recalculating = true
  FROM targets t
  WHERE g.class_id = t.class_id
    AND g.gradebook_id = t.gradebook_id
    AND g.student_id = t.student_id
    AND g.is_private = t.is_private;
END;
$$;

COMMENT ON FUNCTION public.send_gradebook_recalculation_messages(jsonb[])
  IS 'Converts per-cell triggers to per-row messages and enqueues to gradebook_row_recalculate; marks entire rows dirty and sets is_recalculating.';

-- 6) Attempt to drop the old per-cell queue, if the drop function exists (safe no-op if not)
DO $$
BEGIN
  PERFORM pgmq.drop_queue('gradebook_column_recalculate');
EXCEPTION
  WHEN undefined_function THEN
    -- pgmq.drop_queue may not exist or extension may not support it in this environment
    NULL;
  WHEN OTHERS THEN
    -- Ignore failures to avoid breaking migration; the queue will simply be unused
    NULL;
END $$;

-- 7) Ensure the new row-level queue exists (safe attempt)
DO $$
BEGIN
  PERFORM pgmq.create('gradebook_row_recalculate');
EXCEPTION
  WHEN undefined_function THEN
    BEGIN
      PERFORM pgmq_public.create('gradebook_row_recalculate');
    EXCEPTION
      WHEN undefined_function THEN
        NULL;
      WHEN OTHERS THEN
        NULL;
    END;
  WHEN OTHERS THEN
    NULL;
END $$;

-- 8) Replace legacy per-cell enqueueing functions to call row-level enqueue directly
-- 8a) Column score_expression changed: enqueue all rows for that column
CREATE OR REPLACE FUNCTION public.recalculate_gradebook_column_for_all_students_statement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    JOIN old_table o ON n.id = o.id
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = n.id
    WHERE n.score_expression IS DISTINCT FROM o.score_expression
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(r.class_id, r.gradebook_id, r.student_id, r.is_private, 'score_expression_change', NULL);
  END LOOP;
  RETURN NULL;
END;
$$;

-- 8c) New gradebook_column_students rows: enqueue rows only for columns with expressions
CREATE OR REPLACE FUNCTION public.recalculate_new_gradebook_column_students() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table gcs
    JOIN public.gradebook_columns gc ON gc.id = gcs.gradebook_column_id
    WHERE gc.score_expression IS NOT NULL
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(r.class_id, r.gradebook_id, r.student_id, r.is_private, 'gradebook_column_student_insert', NULL);
  END LOOP;
  RETURN NULL;
END;
$$;

-- 8d) When a submission review changes scores/released, enqueue dependent rows
CREATE OR REPLACE FUNCTION public.submission_review_recalculate_dependent_columns_statement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  r RECORD;
BEGIN
  -- Individual submissions with changed totals/released
  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    LEFT JOIN old_table o ON n.id = o.id
    JOIN public.submissions s ON s.id = n.submission_id
    JOIN public.gradebook_columns gc ON gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id AND gcs.student_id = s.profile_id
    WHERE s.profile_id IS NOT NULL
      AND (o.id IS NULL OR n.total_score IS DISTINCT FROM o.total_score OR n.released IS DISTINCT FROM o.released)
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(r.class_id, r.gradebook_id, r.student_id, r.is_private, 'submission_review_change', NULL);
  END LOOP;

  -- Group submissions with changed totals/released
  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    LEFT JOIN old_table o ON n.id = o.id
    JOIN public.submissions s ON s.id = n.submission_id
    JOIN public.assignment_groups_members agm ON agm.assignment_group_id = s.assignment_group_id
    JOIN public.gradebook_columns gc ON gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id AND gcs.student_id = agm.profile_id
    WHERE s.assignment_group_id IS NOT NULL
      AND (o.id IS NULL OR n.total_score IS DISTINCT FROM o.total_score OR n.released IS DISTINCT FROM o.released)
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(r.class_id, r.gradebook_id, r.student_id, r.is_private, 'submission_review_change', NULL);
  END LOOP;

  RETURN NULL;
END;
$$;

-- INSERT-only statement-level function using only NEW TABLE
CREATE OR REPLACE FUNCTION public.submission_review_recalculate_dependent_columns_statement_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  r RECORD;
BEGIN
  -- Individual submissions (new rows)
  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    JOIN public.submissions s ON s.id = n.submission_id
    JOIN public.gradebook_columns gc ON gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id AND gcs.student_id = s.profile_id
    WHERE s.profile_id IS NOT NULL
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(r.class_id, r.gradebook_id, r.student_id, r.is_private, 'submission_review_change', NULL);
  END LOOP;

  -- Group submissions (new rows)
  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    JOIN public.submissions s ON s.id = n.submission_id
    JOIN public.assignment_groups_members agm ON agm.assignment_group_id = s.assignment_group_id
    JOIN public.gradebook_columns gc ON gc.dependencies->'assignments' @> to_jsonb(ARRAY[s.assignment_id]::bigint[])
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id AND gcs.student_id = agm.profile_id
    WHERE s.assignment_group_id IS NOT NULL
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(r.class_id, r.gradebook_id, r.student_id, r.is_private, 'submission_review_change', NULL);
  END LOOP;

  RETURN NULL;
END;
$$;

-- 8e) Cell changes that affect dependent columns: enqueue dependent rows for same student/privacy
CREATE OR REPLACE FUNCTION public.gradebook_column_student_recalculate_dependents() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  r RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Only trigger if relevant fields changed
  IF (NEW.score IS NOT DISTINCT FROM OLD.score AND NEW.score_override IS NOT DISTINCT FROM OLD.score_override AND NEW.is_missing IS NOT DISTINCT FROM OLD.is_missing
      AND NEW.is_droppable IS NOT DISTINCT FROM OLD.is_droppable AND NEW.is_excused IS NOT DISTINCT FROM OLD.is_excused) THEN
    RETURN NEW;
  END IF;

  IF (NEW.is_recalculating) THEN
    RETURN NEW;
  END IF;

  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM public.gradebook_columns gc
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id
    WHERE gc.dependencies->'gradebook_columns' @> to_jsonb(ARRAY[NEW.gradebook_column_id]::bigint[])
      AND gcs.student_id = NEW.student_id
      AND gcs.is_private = NEW.is_private
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(r.class_id, r.gradebook_id, r.student_id, r.is_private, 'cell_change_dependent', NEW.id);
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.gradebook_column_student_recalculate_dependents_statement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  r RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    RETURN NULL;
  END IF;

  FOR r IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, new_rec.student_id AS student_id, gcs.is_private
    FROM new_table new_rec
    INNER JOIN old_table old_rec ON new_rec.id = old_rec.id
    INNER JOIN public.gradebook_columns gc ON gc.dependencies->'gradebook_columns' @> to_jsonb(ARRAY[new_rec.gradebook_column_id]::bigint[])
    INNER JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = gc.id 
        AND gcs.student_id = new_rec.student_id 
        AND gcs.is_private = new_rec.is_private
    WHERE (
      new_rec.score IS DISTINCT FROM old_rec.score OR
      new_rec.score_override IS DISTINCT FROM old_rec.score_override OR
      new_rec.is_missing IS DISTINCT FROM old_rec.is_missing OR
      new_rec.is_droppable IS DISTINCT FROM old_rec.is_droppable OR
      new_rec.is_excused IS DISTINCT FROM old_rec.is_excused
    )
  ) LOOP
    PERFORM public.enqueue_gradebook_row_recalculation(r.class_id, r.gradebook_id, r.student_id, r.is_private, 'cell_change_dependent_stmt', NULL);
  END LOOP;

  RETURN NULL;
END;
$$;

-- 9) Remove the legacy helper
DROP FUNCTION IF EXISTS public.send_gradebook_recalculation_messages(jsonb[]);

-- 9b) Remove per-cell dirty artifacts added earlier
DO $$
BEGIN
  -- Drop indexes created earlier in this migration that reference per-cell dirty
  PERFORM 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_gradebook_column_students_class_student_privacy_covering';
  IF FOUND THEN
    EXECUTE 'DROP INDEX IF EXISTS public.idx_gradebook_column_students_class_student_privacy_covering';
  END IF;
  EXECUTE 'DROP INDEX IF EXISTS public.idx_gradebook_column_students_dirty_true';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Optionally drop the per-cell dirty column if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'gradebook_column_students' AND column_name = 'dirty'
  ) THEN
    EXECUTE 'ALTER TABLE public.gradebook_column_students DROP COLUMN dirty';
  END IF;
END $$;

-- 10) Update triggers to use statement-level variants
-- Drop old per-row trigger on gradebook_columns and recreate as statement-level
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger t 
    JOIN pg_class c ON c.oid = t.tgrelid 
    JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
    WHERE t.tgname = 'trigger_recalculate_column_on_score_expression_change'
      AND nsp.nspname = 'public'
      AND c.relname = 'gradebook_columns'
  ) THEN
    EXECUTE 'DROP TRIGGER trigger_recalculate_column_on_score_expression_change ON public.gradebook_columns';
  END IF;
END $$;

CREATE TRIGGER trigger_recalculate_column_on_score_expression_change
  AFTER UPDATE ON public.gradebook_columns
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.recalculate_gradebook_column_for_all_students_statement();

-- Replace submission_reviews trigger with statement-level versions (split to satisfy transition table rules)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger t 
    JOIN pg_class c ON c.oid = t.tgrelid 
    JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
    WHERE t.tgname = 'trigger_recalculate_dependent_columns_on_review'
      AND nsp.nspname = 'public'
      AND c.relname = 'submission_reviews'
  ) THEN
    EXECUTE 'DROP TRIGGER trigger_recalculate_dependent_columns_on_review ON public.submission_reviews';
  END IF;
END $$;

CREATE TRIGGER trigger_recalculate_dependent_columns_on_review_update
  AFTER UPDATE ON public.submission_reviews
  REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.submission_review_recalculate_dependent_columns_statement();

CREATE TRIGGER trigger_recalculate_dependent_columns_on_review_insert
  AFTER INSERT ON public.submission_reviews
  REFERENCING NEW TABLE AS new_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.submission_review_recalculate_dependent_columns_statement_insert();

DROP FUNCTION IF EXISTS public.recalculate_gradebook_column_for_all_students();
DROP FUNCTION IF EXISTS public.submission_review_recalculate_dependent_columns();


-- 11) Broadcast row-level recalculation state changes (use existing class:* topics)
CREATE OR REPLACE FUNCTION public.broadcast_gradebook_row_state_change()
RETURNS TRIGGER AS $$
DECLARE
  target_class_id BIGINT;
  target_student_id UUID;
  staff_payload JSONB;
  user_payload JSONB;
  target_is_private BOOLEAN;
BEGIN
  -- Determine IDs and privacy based on operation
  IF TG_OP = 'INSERT' THEN
    target_class_id := NEW.class_id;
    target_student_id := NEW.student_id;
    target_is_private := NEW.is_private;
  ELSIF TG_OP = 'UPDATE' THEN
    target_class_id := COALESCE(NEW.class_id, OLD.class_id);
    target_student_id := COALESCE(NEW.student_id, OLD.student_id);
    target_is_private := COALESCE(NEW.is_private, OLD.is_private);
  ELSIF TG_OP = 'DELETE' THEN
    target_class_id := OLD.class_id;
    target_student_id := OLD.student_id;
    target_is_private := OLD.is_private;
  END IF;

  IF target_class_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- Build base payload matching existing table_change format
  staff_payload := jsonb_build_object(
    'type', 'table_change',
    'operation', TG_OP,
    'table', 'gradebook_row_recalc_state',
    'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
    'class_id', target_class_id,
    'timestamp', NOW()
  );

  -- Always broadcast to staff channel
  PERFORM realtime.send(
    staff_payload || jsonb_build_object('target_audience', 'staff'),
    'broadcast',
    'class:' || target_class_id || ':staff',
    true
  );

  -- If non-private, also broadcast to the student's user channel
  IF target_is_private = false THEN
    user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
    PERFORM realtime.send(
      user_payload,
      'broadcast',
      'class:' || target_class_id || ':user:' || target_student_id,
      true
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE TRIGGER broadcast_gradebook_row_recalc_state
  AFTER INSERT OR UPDATE OR DELETE ON public.gradebook_row_recalc_state
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_gradebook_row_state_change();

