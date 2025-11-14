-- Migration: Reduce realtime broadcast spam for bulk operations
-- This migration replaces row-level broadcast triggers with statement-level triggers
-- that consolidate broadcasts for INSERT, UPDATE, and DELETE operations.
--
-- Strategy:
-- 1. Drop row-level broadcast trigger (broadcast_gradebook_column_students_unified)
-- 2. Add statement-level triggers for INSERT, UPDATE, and DELETE operations
-- 3. For operations affecting 1-49 rows: send a single message with array of row_ids
-- 4. For operations affecting 50+ rows: send a refetch signal (no row_ids to avoid huge payloads)

-- Configuration: Thresholds for bulk operation handling
-- These can be adjusted based on performance needs
DO $$
DECLARE
    bulk_update_threshold INTEGER := 50;  -- If >= this many rows, send refetch signal instead of IDs
    max_ids_in_message INTEGER := 49;    -- Maximum IDs to include in a bulk message
BEGIN
    -- Store configuration in a temporary table (for reference, not used in triggers)
    -- Actual thresholds are hardcoded in functions for performance
    RAISE NOTICE 'Bulk update threshold: % rows, max IDs in message: %', bulk_update_threshold, max_ids_in_message;
END $$;

-- ============================================================================
-- GRADEBOOK-SPECIFIC STATEMENT-LEVEL BROADCAST HANDLING
-- ============================================================================

-- Unified function for gradebook_column_students that handles INSERT, UPDATE, and DELETE
-- at the statement level to consolidate broadcasts and reduce spam.
-- Uses gradebook-specific channels: gradebook:$class_id:staff and gradebook:$class_id:student:$student_id
-- Privacy filtering: is_private=true goes only to staff, is_private=false goes only to students
CREATE OR REPLACE FUNCTION public.broadcast_gradebook_column_students_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    affected_row_ids BIGINT[];
    affected_count INTEGER;
    class_id_value BIGINT;
    private_student_ids UUID[];
    public_student_ids UUID[];
    student_id UUID;
    staff_payload JSONB;
    student_payload JSONB;
    operation_type TEXT;
    transition_table_name TEXT;
    BULK_THRESHOLD CONSTANT INTEGER := 50;
    MAX_IDS CONSTANT INTEGER := 49;
BEGIN
    operation_type := TG_OP;
    RAISE NOTICE '[broadcast_gradebook_column_students_statement] Trigger fired: operation=%, table=gradebook_column_students', operation_type;
    
    -- Determine which transition table to use
    IF operation_type = 'DELETE' THEN
        transition_table_name := 'old_table';
    ELSE
        transition_table_name := 'new_table';
    END IF;
    
    -- Collect affected row IDs and separate students by privacy
    IF operation_type = 'DELETE' THEN
        SELECT 
            ARRAY_AGG(old_table.id ORDER BY old_table.id),
            COUNT(*),
            ARRAY_AGG(DISTINCT old_table.student_id ORDER BY old_table.student_id) FILTER (WHERE old_table.is_private = true),
            ARRAY_AGG(DISTINCT old_table.student_id ORDER BY old_table.student_id) FILTER (WHERE old_table.is_private = false)
        INTO affected_row_ids, affected_count, private_student_ids, public_student_ids
        FROM old_table;
        
        SELECT DISTINCT old_table.class_id INTO class_id_value
        FROM old_table
        LIMIT 1;
    ELSE
        SELECT 
            ARRAY_AGG(new_table.id ORDER BY new_table.id),
            COUNT(*),
            ARRAY_AGG(DISTINCT new_table.student_id ORDER BY new_table.student_id) FILTER (WHERE new_table.is_private = true),
            ARRAY_AGG(DISTINCT new_table.student_id ORDER BY new_table.student_id) FILTER (WHERE new_table.is_private = false)
        INTO affected_row_ids, affected_count, private_student_ids, public_student_ids
        FROM new_table;
        
        SELECT DISTINCT new_table.class_id INTO class_id_value
        FROM new_table
        LIMIT 1;
    END IF;
    
    RAISE NOTICE '[broadcast_gradebook_column_students_statement] Collected: affected_count=%, class_id=%, private_students=%, public_students=%', 
        affected_count, class_id_value, 
        COALESCE(array_length(private_student_ids, 1), 0), 
        COALESCE(array_length(public_student_ids, 1), 0);
    
    -- If no rows affected, exit early
    IF affected_count IS NULL OR affected_count = 0 THEN
        RAISE NOTICE '[broadcast_gradebook_column_students_statement] Early return: no rows affected';
        RETURN NULL;
    END IF;
    
    IF class_id_value IS NULL THEN
        RAISE NOTICE '[broadcast_gradebook_column_students_statement] Early return: no class_id found';
        RETURN NULL;
    END IF;
    
    -- Build payload based on affected count
    IF affected_count >= BULK_THRESHOLD THEN
        -- Large bulk: refetch signal
        RAISE NOTICE '[broadcast_gradebook_column_students_statement] Using bulk mode (>=% rows): refetch signal', BULK_THRESHOLD;
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', operation_type,
            'table', 'gradebook_column_students',
            'class_id', class_id_value,
            'affected_count', affected_count,
            'requires_refetch', true,
            'timestamp', NOW()
        );
        
        student_payload := staff_payload; -- Same payload for students
    ELSE
        -- Small bulk: include IDs (up to MAX_IDS)
        IF array_length(affected_row_ids, 1) > MAX_IDS THEN
            affected_row_ids := affected_row_ids[1:MAX_IDS];
            RAISE NOTICE '[broadcast_gradebook_column_students_statement] Truncated row_ids to first %', MAX_IDS;
        END IF;
        
        RAISE NOTICE '[broadcast_gradebook_column_students_statement] Using small bulk mode (<% rows): including row_ids', BULK_THRESHOLD;
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', operation_type,
            'table', 'gradebook_column_students',
            'row_ids', affected_row_ids,
            'affected_count', affected_count,
            'class_id', class_id_value,
            'requires_refetch', false,
            'timestamp', NOW()
        );
        
        student_payload := staff_payload; -- Same payload for students
    END IF;
    
    -- Privacy-based routing:
    -- - is_private = true: ONLY broadcast to staff channel (gradebook:$class_id:staff)
    -- - is_private = false: ONLY broadcast to individual student channels (gradebook:$class_id:student:$student_id)
    
    -- Broadcast private records to staff channel only
    IF private_student_ids IS NOT NULL AND array_length(private_student_ids, 1) > 0 THEN
        RAISE NOTICE '[broadcast_gradebook_column_students_statement] Broadcasting % private records to staff channel: gradebook:%:staff', 
            array_length(private_student_ids, 1), class_id_value;
        -- Only private records: broadcast to staff channel
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'gradebook:' || class_id_value || ':staff',
            true
        );
    END IF;
    
    -- Broadcast non-private records to individual student channels only
    -- Each student gets their own gradebook channel: gradebook:$class_id:student:$student_id
    IF public_student_ids IS NOT NULL AND array_length(public_student_ids, 1) > 0 THEN
        RAISE NOTICE '[broadcast_gradebook_column_students_statement] Broadcasting % public records to individual student channels', 
            array_length(public_student_ids, 1);
        FOREACH student_id IN ARRAY public_student_ids
        LOOP
            PERFORM public.safe_broadcast(
                student_payload,
                'broadcast',
                'gradebook:' || class_id_value || ':student:' || student_id,
                true
            );
        END LOOP;
        RAISE NOTICE '[broadcast_gradebook_column_students_statement] Completed broadcasting to % student channels', array_length(public_student_ids, 1);
    END IF;
    
    RAISE NOTICE '[broadcast_gradebook_column_students_statement] Function completed';
    RETURN NULL;
END;
$$;

-- ============================================================================
-- DROP ROW-LEVEL BROADCAST TRIGGERS
-- ============================================================================

-- Drop the existing row-level broadcast trigger for gradebook_column_students
-- We're replacing it with statement-level triggers for all operations
DROP TRIGGER IF EXISTS broadcast_gradebook_column_students_unified ON public.gradebook_column_students;

-- ============================================================================
-- CREATE STATEMENT-LEVEL TRIGGERS
-- ============================================================================

-- For gradebook_column_students: statement-level triggers for INSERT, UPDATE, and DELETE
-- These replace the row-level trigger and consolidate broadcasts to reduce spam
DROP TRIGGER IF EXISTS broadcast_gradebook_column_students_insert_trigger ON public.gradebook_column_students;
DROP TRIGGER IF EXISTS broadcast_gradebook_column_students_update_trigger ON public.gradebook_column_students;
DROP TRIGGER IF EXISTS broadcast_gradebook_column_students_delete_trigger ON public.gradebook_column_students;

-- INSERT trigger
CREATE TRIGGER broadcast_gradebook_column_students_insert_trigger
    AFTER INSERT ON public.gradebook_column_students
    REFERENCING NEW TABLE AS new_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_gradebook_column_students_statement();

-- UPDATE trigger
CREATE TRIGGER broadcast_gradebook_column_students_update_trigger
    AFTER UPDATE ON public.gradebook_column_students
    REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_gradebook_column_students_statement();

-- DELETE trigger
CREATE TRIGGER broadcast_gradebook_column_students_delete_trigger
    AFTER DELETE ON public.gradebook_column_students
    REFERENCING OLD TABLE AS old_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_gradebook_column_students_statement();

-- Add comments explaining the triggers
COMMENT ON TRIGGER broadcast_gradebook_column_students_insert_trigger ON public.gradebook_column_students IS 
'Statement-level trigger that consolidates INSERT operations on gradebook_column_students. 
For inserts affecting 50+ rows, sends a refetch signal instead of individual row broadcasts to reduce spam.
For smaller bulk inserts (1-49 rows), sends a consolidated message with row IDs array.';

COMMENT ON TRIGGER broadcast_gradebook_column_students_update_trigger ON public.gradebook_column_students IS 
'Statement-level trigger that consolidates UPDATE operations on gradebook_column_students. 
For updates affecting 50+ rows, sends a refetch signal instead of individual row broadcasts to reduce spam.
For smaller bulk updates (1-49 rows), sends a consolidated message with row IDs array.';

COMMENT ON TRIGGER broadcast_gradebook_column_students_delete_trigger ON public.gradebook_column_students IS 
'Statement-level trigger that consolidates DELETE operations on gradebook_column_students. 
For deletes affecting 50+ rows, sends a refetch signal instead of individual row broadcasts to reduce spam.
For smaller bulk deletes (1-49 rows), sends a consolidated message with row IDs array.';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
-- This migration replaces row-level broadcast triggers with statement-level triggers
-- for frequently bulk-updated tables. All INSERT, UPDATE, and DELETE operations are now
-- handled at the statement level, which consolidates broadcasts and reduces spam.
--
-- Tables updated:
-- 1. gradebook_column_students
-- 2. gradebook_row_recalc_state
-- 3. submission_reviews
-- 4. review_assignments
--
-- Key improvements:
-- 1. Row-level triggers have been dropped for all tables
-- 2. Statement-level triggers handle all operations (INSERT, UPDATE, DELETE)
-- 3. Bulk operations (50+ rows) send refetch signals instead of individual broadcasts
-- 4. Small operations (1-49 rows) send consolidated messages with row IDs arrays
--
-- Future work:
-- - Add privacy filtering for per-student broadcasts based on is_private flag
-- - Refactor gradebook updates into separate channels as planned

-- ============================================================================
-- GRADEBOOK_ROW_RECALC_STATE STATEMENT-LEVEL BROADCAST HANDLING
-- ============================================================================
-- Use statement-level triggers to batch broadcasts when multiple rows are updated
-- Individual function calls still work, but bulk operations are batched efficiently

-- Drop all existing triggers (row-level and statement-level)
DROP TRIGGER IF EXISTS broadcast_gradebook_row_recalc_state ON public.gradebook_row_recalc_state;
DROP TRIGGER IF EXISTS broadcast_gradebook_row_recalc_state_insert_trigger ON public.gradebook_row_recalc_state;
DROP TRIGGER IF EXISTS broadcast_gradebook_row_recalc_state_update_trigger ON public.gradebook_row_recalc_state;
DROP TRIGGER IF EXISTS broadcast_gradebook_row_recalc_state_delete_trigger ON public.gradebook_row_recalc_state;

-- Statement-level broadcast function for gradebook_row_recalc_state
-- Batches all changes in a single statement into one broadcast
-- Updated to include affected rows data so frontend can update without refetching
CREATE OR REPLACE FUNCTION public.broadcast_gradebook_row_recalc_state_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    affected_count INTEGER;
    class_id_value BIGINT;
    staff_payload JSONB;
    operation_type TEXT;
    class_ids BIGINT[];
    affected_rows_by_class JSONB; -- Map of class_id -> array of affected rows
BEGIN
    operation_type := TG_OP;
    RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Trigger fired: operation=%, table=gradebook_row_recalc_state', operation_type;
    
    -- Collect affected count, all unique class_ids, and affected rows data grouped by class_id
    -- Use transition tables directly (old_table/new_table are statement-level trigger transition tables)
    -- Note: For INSERT ... ON CONFLICT DO UPDATE, PostgreSQL fires UPDATE trigger when conflict occurs
    -- so we need to handle both INSERT and UPDATE cases properly
    -- IMPORTANT: Only broadcast is_private = true rows to staff channel
    IF operation_type = 'DELETE' THEN
        SELECT 
            COUNT(*), 
            ARRAY_AGG(DISTINCT t.class_id ORDER BY t.class_id),
            COALESCE(jsonb_object_agg(
                t.class_id::text,
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'student_id', t2.student_id,
                            'dirty', t2.dirty,
                            'is_recalculating', t2.is_recalculating
                        ) ORDER BY t2.student_id
                    )
                    FROM old_table t2
                    WHERE t2.class_id = t.class_id AND t2.is_private = true
                )
            ), '{}'::jsonb)
        INTO affected_count, class_ids, affected_rows_by_class
        FROM (SELECT DISTINCT class_id FROM old_table WHERE is_private = true) t;
    ELSIF operation_type = 'UPDATE' THEN
        -- For UPDATE (including INSERT ... ON CONFLICT DO UPDATE), use new_table to get updated values
        SELECT 
            COUNT(*), 
            ARRAY_AGG(DISTINCT t.class_id ORDER BY t.class_id),
            COALESCE(jsonb_object_agg(
                t.class_id::text,
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'student_id', t2.student_id,
                            'dirty', t2.dirty,
                            'is_recalculating', t2.is_recalculating
                        ) ORDER BY t2.student_id
                    )
                    FROM new_table t2
                    WHERE t2.class_id = t.class_id AND t2.is_private = true
                )
            ), '{}'::jsonb)
        INTO affected_count, class_ids, affected_rows_by_class
        FROM (SELECT DISTINCT class_id FROM new_table WHERE is_private = true) t;
    ELSE
        -- INSERT (including INSERT ... ON CONFLICT DO UPDATE when no conflict)
        -- Optimization: When INSERT ... ON CONFLICT DO UPDATE has a conflict, PostgreSQL fires both
        -- INSERT and UPDATE triggers. The INSERT trigger will have an empty new_table (because the INSERT
        -- didn't happen, the UPDATE did). We check for this and return early.
        SELECT 
            COUNT(*), 
            ARRAY_AGG(DISTINCT t.class_id ORDER BY t.class_id),
            COALESCE(jsonb_object_agg(
                t.class_id::text,
                (
                    SELECT jsonb_agg(
                        jsonb_build_object(
                            'student_id', t2.student_id,
                            'dirty', t2.dirty,
                            'is_recalculating', t2.is_recalculating
                        ) ORDER BY t2.student_id
                    )
                    FROM new_table t2
                    WHERE t2.class_id = t.class_id AND t2.is_private = true
                )
            ), '{}'::jsonb)
        INTO affected_count, class_ids, affected_rows_by_class
        FROM (SELECT DISTINCT class_id FROM new_table WHERE is_private = true) t;
        
        -- Early return for INSERT triggers with empty new_table (INSERT ... ON CONFLICT DO UPDATE conflict case)
        IF affected_count = 0 THEN
            RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Early return: INSERT trigger with empty new_table (likely INSERT ... ON CONFLICT DO UPDATE conflict) or no private rows';
            RETURN NULL;
        END IF;
    END IF;
    
    RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Collected: affected_count=%, class_ids=% (private rows only)', affected_count, class_ids;
    
    -- Early return if no private rows affected
    -- Note: COUNT(*) should never return NULL, but check for 0
    IF affected_count IS NULL OR affected_count = 0 THEN
        RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Early return: no private rows affected (only public rows or no rows)';
        RETURN NULL;
    END IF;
    
    -- Early return if no class_ids found
    -- Note: ARRAY_AGG returns NULL if no rows, so check for NULL or empty array
    IF class_ids IS NULL OR array_length(class_ids, 1) IS NULL OR array_length(class_ids, 1) = 0 THEN
        RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Early return: no class_ids found for private rows';
        RETURN NULL;
    END IF;
    
    -- Broadcast to each affected class's gradebook staff channel
    -- This handles cases where updates affect multiple classes
    -- IMPORTANT: Only private rows (is_private = true) are broadcast to staff channel
    FOREACH class_id_value IN ARRAY class_ids
    LOOP
        -- Extract affected_rows for this specific class_id from the map
        DECLARE
            rows_for_class JSONB;
            count_for_class INTEGER;
        BEGIN
            -- Get rows for this class_id (default to empty array if not found)
            rows_for_class := COALESCE(affected_rows_by_class->(class_id_value::text), '[]'::jsonb);
            count_for_class := jsonb_array_length(rows_for_class);
            
            staff_payload := jsonb_build_object(
                'type', 'gradebook_row_recalc_state',
                'operation', operation_type,
                'table', 'gradebook_row_recalc_state',
                'class_id', class_id_value,
                'affected_count', count_for_class,
                'affected_rows', rows_for_class,
                'requires_refetch', false, -- Always false since we include the data
                'timestamp', NOW()
            );
        END;
        
        RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Broadcasting to class_id=%, channel=gradebook:%:staff, affected_count=% (private rows only)', 
            class_id_value, class_id_value, jsonb_array_length(staff_payload->'affected_rows');
        
        -- Broadcast to gradebook staff channel for this class
        -- Note: safe_broadcast checks for subscribers before sending, so if no one is subscribed, it won't send
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'gradebook:' || class_id_value || ':staff',
            true
        );
        
        RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Broadcast completed for class_id=%', class_id_value;
    END LOOP;
    
    RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Function completed: total broadcasts=%', array_length(class_ids, 1);
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.broadcast_gradebook_row_recalc_state_statement()
  IS 'Broadcasts gradebook_row_recalc_state changes with affected rows data (student_id, dirty, is_recalculating) so frontend can update without refetching.';

-- Create statement-level triggers for INSERT, UPDATE, DELETE
CREATE TRIGGER broadcast_gradebook_row_recalc_state_insert_trigger
    AFTER INSERT ON public.gradebook_row_recalc_state
    REFERENCING NEW TABLE AS new_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_gradebook_row_recalc_state_statement();

CREATE TRIGGER broadcast_gradebook_row_recalc_state_update_trigger
    AFTER UPDATE ON public.gradebook_row_recalc_state
    REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_gradebook_row_recalc_state_statement();

CREATE TRIGGER broadcast_gradebook_row_recalc_state_delete_trigger
    AFTER DELETE ON public.gradebook_row_recalc_state
    REFERENCING OLD TABLE AS old_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_gradebook_row_recalc_state_statement();

-- Update enqueue_gradebook_row_recalculation - remove individual broadcast since statement-level trigger handles it
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
    SET search_path = public, pg_temp
    AS $$
DECLARE
  row_message jsonb;
BEGIN
  RAISE NOTICE '[enqueue_gradebook_row_recalculation] Called: class_id=%, gradebook_id=%, student_id=%, is_private=%, reason=%', 
    p_class_id, p_gradebook_id, p_student_id, p_is_private, p_reason;
  
  -- Per-row advisory lock to avoid duplicate enqueues under concurrency
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_class_id::text || ':' || p_gradebook_id::text || ':' || p_student_id::text || ':' || p_is_private::text,
      42
    )::bigint
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
        AND s.is_recalculating = false
    ) THEN
      RAISE NOTICE '[enqueue_gradebook_row_recalculation] Skipped: row already dirty and not recalculating';
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
  RAISE NOTICE '[enqueue_gradebook_row_recalculation] Sending message to queue: gradebook_row_recalculate';
  PERFORM pgmq_public.send(
    queue_name := 'gradebook_row_recalculate',
    message := row_message
  );

  -- Mark row-state dirty and set recalculating (upsert), bump version to invalidate older workers
  -- The statement-level trigger will broadcast all changes in this statement at once
  -- Note: This INSERT ... ON CONFLICT DO UPDATE will fire either the INSERT or UPDATE trigger
  -- depending on whether a conflict occurs. Both triggers use the same function which handles both cases.
  RAISE NOTICE '[enqueue_gradebook_row_recalculation] Upserting gradebook_row_recalc_state (this will trigger statement-level broadcast)';
  INSERT INTO public.gradebook_row_recalc_state (class_id, gradebook_id, student_id, is_private, dirty, is_recalculating, version)
  VALUES (p_class_id, p_gradebook_id, p_student_id, p_is_private, true, true, 1)
  ON CONFLICT (class_id, gradebook_id, student_id, is_private)
  DO UPDATE SET dirty = true, is_recalculating = true, version = public.gradebook_row_recalc_state.version + 1, updated_at = now();
  
  RAISE NOTICE '[enqueue_gradebook_row_recalculation] Completed upsert';
END;
$$;

COMMENT ON FUNCTION public.enqueue_gradebook_row_recalculation(bigint, bigint, uuid, boolean, text, bigint)
  IS 'Enqueues recalculation for all gradebook cells of a specific student in a class for the given privacy variant. State changes are broadcast via statement-level triggers, which batch multiple updates efficiently.';

-- ============================================================================
-- BATCH ENQUEUE FUNCTION
-- ============================================================================

-- Batch version of enqueue_gradebook_row_recalculation that processes multiple rows
-- in a single statement, allowing statement-level triggers to batch broadcasts
CREATE OR REPLACE FUNCTION public.enqueue_gradebook_row_recalculation_batch(
  p_rows jsonb[]
) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
  row_rec jsonb;
  row_message jsonb;
  messages jsonb[];
  rows_to_insert jsonb[];
  class_id_val bigint;
  gradebook_id_val bigint;
  student_id_val uuid;
  is_private_val boolean;
  skipped_count integer := 0;
BEGIN
  RAISE NOTICE '[enqueue_gradebook_row_recalculation_batch] Called with % rows', array_length(p_rows, 1);
  
  -- Collect messages and rows to insert/update
  messages := ARRAY[]::jsonb[];
  rows_to_insert := ARRAY[]::jsonb[];
  
  -- Process each row, applying gating rules
  FOREACH row_rec IN ARRAY p_rows
  LOOP
    class_id_val := (row_rec->>'class_id')::bigint;
    gradebook_id_val := (row_rec->>'gradebook_id')::bigint;
    student_id_val := (row_rec->>'student_id')::uuid;
    is_private_val := (row_rec->>'is_private')::boolean;
    
    -- Apply gating rules: skip if already dirty and not recalculating
    -- Per-row advisory lock to avoid duplicate enqueues under concurrency
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        class_id_val::text || ':' || gradebook_id_val::text || ':' || student_id_val::text || ':' || is_private_val::text,
        42
      )::bigint
    );
    
    -- Gating rules against row-state table:
    -- - If row is currently recalculating, allow re-enqueue (ensure newest deps are seen)
    -- - Else if row is already dirty (and not recalculating), skip enqueue
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
        CONTINUE; -- Skip this row
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
    
    -- Collect row for batch upsert
    rows_to_insert := array_append(rows_to_insert, row_rec);
  END LOOP;
  
  RAISE NOTICE '[enqueue_gradebook_row_recalculation_batch] Processed: total=%, skipped=%, to_enqueue=%, to_upsert=%', 
    array_length(p_rows, 1), skipped_count, array_length(messages, 1), array_length(rows_to_insert, 1);
  
  -- Send all messages to queue in batch if any
  IF array_length(messages, 1) > 0 THEN
    RAISE NOTICE '[enqueue_gradebook_row_recalculation_batch] Sending % messages to queue: gradebook_row_recalculate', array_length(messages, 1);
    PERFORM pgmq_public.send_batch(
      queue_name := 'gradebook_row_recalculate',
      messages := messages
    );
  END IF;
  
  -- Batch upsert all rows in a single statement
  -- This will trigger the statement-level broadcast trigger once for all rows
  IF array_length(rows_to_insert, 1) > 0 THEN
    RAISE NOTICE '[enqueue_gradebook_row_recalculation_batch] Batch upserting % rows (this will trigger statement-level broadcast)', array_length(rows_to_insert, 1);
    INSERT INTO public.gradebook_row_recalc_state (
      class_id, gradebook_id, student_id, is_private, dirty, is_recalculating, version
    )
    SELECT 
      (r->>'class_id')::bigint,
      (r->>'gradebook_id')::bigint,
      (r->>'student_id')::uuid,
      (r->>'is_private')::boolean,
      true, -- dirty
      true, -- is_recalculating
      1     -- version
    FROM unnest(rows_to_insert) AS r
    ON CONFLICT (class_id, gradebook_id, student_id, is_private)
    DO UPDATE SET 
      dirty = true, 
      is_recalculating = true, 
      version = public.gradebook_row_recalc_state.version + 1, 
      updated_at = now();
    RAISE NOTICE '[enqueue_gradebook_row_recalculation_batch] Batch upsert completed';
  END IF;
  
  RAISE NOTICE '[enqueue_gradebook_row_recalculation_batch] Function completed';
END;
$$;

COMMENT ON FUNCTION public.enqueue_gradebook_row_recalculation_batch(jsonb[])
  IS 'Batch version of enqueue_gradebook_row_recalculation that processes multiple rows in a single statement, allowing statement-level triggers to batch broadcasts efficiently.';

-- ============================================================================
-- UPDATE recalculate_gradebook_column_for_all_students_statement TO USE BATCH
-- ============================================================================

CREATE OR REPLACE FUNCTION public.recalculate_gradebook_column_for_all_students_statement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  rows_to_enqueue jsonb[];
  row_rec RECORD;
BEGIN
  RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] Trigger fired: operation=%, table=gradebook_columns', TG_OP;
  
  -- Collect all affected students into a JSONB array
  rows_to_enqueue := ARRAY[]::jsonb[];
  
  FOR row_rec IN (
    SELECT DISTINCT gcs.class_id, gcs.gradebook_id, gcs.student_id, gcs.is_private
    FROM new_table n
    JOIN old_table o ON n.id = o.id
    JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = n.id
    WHERE n.score_expression IS DISTINCT FROM o.score_expression
  ) LOOP
    rows_to_enqueue := array_append(rows_to_enqueue, 
      jsonb_build_object(
        'class_id', row_rec.class_id,
        'gradebook_id', row_rec.gradebook_id,
        'student_id', row_rec.student_id,
        'is_private', row_rec.is_private
      )
    );
  END LOOP;
  
  RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] Collected % rows to enqueue', array_length(rows_to_enqueue, 1);
  
  -- Batch enqueue all rows in a single call
  -- This will result in a single INSERT statement, triggering the broadcast trigger once
  IF array_length(rows_to_enqueue, 1) > 0 THEN
    RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] Calling batch enqueue function';
    PERFORM public.enqueue_gradebook_row_recalculation_batch(rows_to_enqueue);
    RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] Batch enqueue completed';
  ELSE
    RAISE NOTICE '[recalculate_gradebook_column_for_all_students_statement] No rows to enqueue';
  END IF;
  
  RETURN NULL;
END;
$$;

-- ============================================================================
-- UPDATE gradebook_column_student_recalculate_dependents_statement TO USE BATCH
-- ============================================================================

-- This function is called when gradebook_column_students is updated and needs to
-- enqueue recalculation for dependent columns. Currently it loops and calls
-- enqueue_gradebook_row_recalculation individually, causing multiple broadcasts.
-- Update it to use batch operations.
CREATE OR REPLACE FUNCTION public.gradebook_column_student_recalculate_dependents_statement() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  rows_to_enqueue jsonb[];
  r RECORD;
BEGIN
  RAISE NOTICE '[gradebook_column_student_recalculate_dependents_statement] Trigger fired: operation=%, table=gradebook_column_students', TG_OP;
  
  IF TG_OP = 'INSERT' THEN
    RETURN NULL;
  END IF;

  -- Collect all affected rows into a JSONB array
  rows_to_enqueue := ARRAY[]::jsonb[];
  
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
    -- Skip rows that are currently being recalculated by a worker
    -- This prevents feedback loops when update_gradebook_row() updates rows during recalculation
    -- Note: We don't skip rows that were just cleared (dirty=false, is_recalculating=false) because
    -- if the score changed, we need to recalculate dependent columns. The worker clearing the state
    -- means it finished processing THIS column, but other dependent columns may still need recalculation.
    AND NOT EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = gcs.class_id
        AND rs.gradebook_id = gcs.gradebook_id
        AND rs.student_id = gcs.student_id
        AND rs.is_private = gcs.is_private
        AND rs.is_recalculating = true
    )
  ) LOOP
    rows_to_enqueue := array_append(rows_to_enqueue, 
      jsonb_build_object(
        'class_id', r.class_id,
        'gradebook_id', r.gradebook_id,
        'student_id', r.student_id,
        'is_private', r.is_private
      )
    );
  END LOOP;
  
  RAISE NOTICE '[gradebook_column_student_recalculate_dependents_statement] Collected % rows to enqueue (after filtering out rows currently being recalculated)', array_length(rows_to_enqueue, 1);
  
  -- Batch enqueue all rows in a single call
  -- This will result in a single INSERT/UPDATE statement, triggering the broadcast trigger once
  -- Note: Rows that are currently being recalculated (is_recalculating = true) are skipped
  -- to prevent feedback loops when update_gradebook_row() updates rows during recalculation
  IF array_length(rows_to_enqueue, 1) > 0 THEN
    RAISE NOTICE '[gradebook_column_student_recalculate_dependents_statement] Calling batch enqueue function';
    PERFORM public.enqueue_gradebook_row_recalculation_batch(rows_to_enqueue);
    RAISE NOTICE '[gradebook_column_student_recalculate_dependents_statement] Batch enqueue completed';
  ELSE
    RAISE NOTICE '[gradebook_column_student_recalculate_dependents_statement] No rows to enqueue (all filtered out or no dependencies)';
  END IF;

  RETURN NULL;
END;
$$;

-- ============================================================================
-- BATCH UPDATE GRADEBOOK ROWS FUNCTION
-- ============================================================================

-- Batch update gradebook rows and recalc state
-- This function updates multiple students' gradebook_column_students and gradebook_row_recalc_state
-- in a single transaction, eliminating multiple RPC calls and version checks.
--
-- Input: p_batch_updates jsonb[] where each element is:
--   {
--     "class_id": bigint,
--     "gradebook_id": bigint,
--     "student_id": uuid,
--     "is_private": boolean,
--     "expected_version": bigint,
--     "message_ids": bigint[],  -- Array of message IDs to archive/re-enqueue
--     "updates": jsonb[]  -- Array of column updates (same format as update_gradebook_row)
--   }
--
-- Returns: jsonb[] with results for each student:
--   {
--     "student_id": uuid,
--     "is_private": boolean,
--     "updated_count": integer,
--     "version_matched": boolean,
--     "cleared": boolean
--   }
--
-- Side effects:
--   - Archives messages for rows that were successfully cleared (version matched)
--   - Re-enqueues messages for rows that had version mismatches
--   - Also clears state for students with no updates when version matches (fixes infinite loop)

CREATE OR REPLACE FUNCTION public.update_gradebook_rows_batch(
  p_batch_updates jsonb[]
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
  results jsonb;
  expanded_count integer;
  version_matched_count integer;
  updated_gcs_count integer;
  unique_students_count integer;
  cleared_state_count integer;
  cleared_details jsonb;
  message_ids_to_archive bigint[];
  rows_to_reenqueue jsonb;
  messages_to_send jsonb[];
  msg_id bigint;
BEGIN
  RAISE NOTICE '[update_gradebook_rows_batch] Called with % students', array_length(p_batch_updates, 1);
  
  -- Single query execution with all CTEs chained together
  -- This ensures updated_rows CTE is available for subsequent steps
  WITH student_updates_expanded AS (
    SELECT 
      (su->>'class_id')::bigint AS class_id,
      (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id,
      (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version,
      update_obj AS update_data,
      -- Extract message_ids array
      ARRAY(
        SELECT jsonb_array_elements_text(su->'message_ids')
      )::bigint[] AS message_ids
    FROM unnest(p_batch_updates) AS su
    CROSS JOIN LATERAL jsonb_array_elements(su->'updates') AS update_obj
    WHERE su->'updates' IS NOT NULL 
      AND jsonb_typeof(su->'updates') = 'array'
      AND jsonb_array_length(su->'updates') > 0
  ),
  updates_with_context AS (
    SELECT 
      sue.class_id,
      sue.gradebook_id,
      sue.student_id,
      sue.is_private,
      sue.expected_version,
      (sue.update_data->>'gradebook_column_id')::bigint AS gradebook_column_id,
      (sue.update_data ? 'score') AS has_score,
      (sue.update_data->>'score')::numeric AS score,
      (sue.update_data ? 'score_override') AS has_score_override,
      (sue.update_data->>'score_override')::numeric AS score_override,
      (sue.update_data ? 'is_missing') AS has_is_missing,
      (sue.update_data->>'is_missing')::boolean AS is_missing,
      (sue.update_data ? 'is_excused') AS has_is_excused,
      (sue.update_data->>'is_excused')::boolean AS is_excused,
      (sue.update_data ? 'is_droppable') AS has_is_droppable,
      (sue.update_data->>'is_droppable')::boolean AS is_droppable,
      (sue.update_data ? 'released') AS has_released,
      (sue.update_data->>'released')::boolean AS released,
      (sue.update_data ? 'score_override_note') AS has_score_override_note,
      (sue.update_data->>'score_override_note')::text AS score_override_note,
      (sue.update_data ? 'incomplete_values') AS has_incomplete_values,
      (sue.update_data->'incomplete_values')::jsonb AS incomplete_values
    FROM student_updates_expanded sue
    WHERE EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = sue.class_id 
        AND rs.gradebook_id = sue.gradebook_id 
        AND rs.student_id = sue.student_id 
        AND rs.is_private = sue.is_private
        AND rs.version = sue.expected_version
    )
  ),
  updated_rows AS (
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
    FROM updates_with_context up
    WHERE g.class_id = up.class_id
      AND g.gradebook_id = up.gradebook_id
      AND g.student_id = up.student_id
      AND g.is_private = up.is_private
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
    RETURNING 
      g.class_id,
      g.gradebook_id,
      g.student_id,
      g.is_private,
      g.gradebook_column_id,
      up.expected_version
  ),
  update_counts AS (
    SELECT 
      class_id,
      gradebook_id,
      student_id,
      is_private,
      expected_version,
      COUNT(*)::integer AS updated_count
    FROM updated_rows
    GROUP BY class_id, gradebook_id, student_id, is_private, expected_version
  ),
  -- Identify students with no updates but matching versions (need to clear state)
  students_with_no_updates AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id,
      (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id,
      (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version
    FROM unnest(p_batch_updates) AS su
    WHERE (
      su->'updates' IS NULL 
      OR jsonb_typeof(su->'updates') != 'array'
      OR jsonb_array_length(su->'updates') = 0
    )
    AND EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = (su->>'class_id')::bigint
        AND rs.gradebook_id = (su->>'gradebook_id')::bigint
        AND rs.student_id = (su->>'student_id')::uuid
        AND rs.is_private = (su->>'is_private')::boolean
        AND rs.version = (su->>'expected_version')::bigint
    )
  ),
  -- Combine update_counts with students_with_no_updates for clearing state
  all_students_to_clear AS (
    SELECT 
      class_id,
      gradebook_id,
      student_id,
      is_private,
      expected_version
    FROM update_counts
    UNION
    SELECT 
      class_id,
      gradebook_id,
      student_id,
      is_private,
      expected_version
    FROM students_with_no_updates
  ),
  -- Clear recalc state for all version-matched rows (both with updates and without)
  cleared_rows AS (
    UPDATE public.gradebook_row_recalc_state
    SET 
      dirty = false,
      is_recalculating = false,
      updated_at = NOW()
    FROM all_students_to_clear astc
    WHERE gradebook_row_recalc_state.class_id = astc.class_id
      AND gradebook_row_recalc_state.gradebook_id = astc.gradebook_id
      AND gradebook_row_recalc_state.student_id = astc.student_id
      AND gradebook_row_recalc_state.is_private = astc.is_private
      AND gradebook_row_recalc_state.version = astc.expected_version
    RETURNING 
      gradebook_row_recalc_state.class_id,
      gradebook_row_recalc_state.gradebook_id,
      gradebook_row_recalc_state.student_id,
      gradebook_row_recalc_state.is_private,
      gradebook_row_recalc_state.dirty,
      gradebook_row_recalc_state.is_recalculating,
      gradebook_row_recalc_state.version
  ),
  cleared_rows_debug AS (
    SELECT 
      cr.class_id,
      cr.gradebook_id,
      cr.student_id,
      cr.is_private,
      cr.dirty,
      cr.is_recalculating,
      cr.version,
      astc.expected_version AS expected_version_from_all_students
    FROM cleared_rows cr
    JOIN all_students_to_clear astc ON
      astc.class_id = cr.class_id
      AND astc.gradebook_id = cr.gradebook_id
      AND astc.student_id = cr.student_id
      AND astc.is_private = cr.is_private
  ),
  student_results AS (
    SELECT DISTINCT
      (su->>'class_id')::bigint AS class_id,
      (su->>'gradebook_id')::bigint AS gradebook_id,
      (su->>'student_id')::uuid AS student_id,
      (su->>'is_private')::boolean AS is_private,
      (su->>'expected_version')::bigint AS expected_version,
      -- Extract message_ids array and convert to JSONB array for inclusion in results
      COALESCE(
        (SELECT jsonb_agg(elem::text::bigint)
         FROM jsonb_array_elements_text(su->'message_ids') AS elem),
        '[]'::jsonb
      ) AS message_ids,
      COALESCE(uc.updated_count, 0) AS updated_count,
      CASE 
        WHEN EXISTS (
          SELECT 1 FROM public.gradebook_row_recalc_state rs
          WHERE rs.class_id = (su->>'class_id')::bigint
            AND rs.gradebook_id = (su->>'gradebook_id')::bigint
            AND rs.student_id = (su->>'student_id')::uuid
            AND rs.is_private = (su->>'is_private')::boolean
            AND rs.version = (su->>'expected_version')::bigint
        ) THEN true
        ELSE false
      END AS version_matched,
      CASE 
        WHEN EXISTS (
          SELECT 1 FROM cleared_rows cr
          WHERE cr.class_id = (su->>'class_id')::bigint
            AND cr.gradebook_id = (su->>'gradebook_id')::bigint
            AND cr.student_id = (su->>'student_id')::uuid
            AND cr.is_private = (su->>'is_private')::boolean
        ) THEN true
        ELSE false
      END AS cleared
    FROM unnest(p_batch_updates) AS su
    LEFT JOIN update_counts uc ON
      uc.class_id = (su->>'class_id')::bigint
      AND uc.gradebook_id = (su->>'gradebook_id')::bigint
      AND uc.student_id = (su->>'student_id')::uuid
      AND uc.is_private = (su->>'is_private')::boolean
  ),
  debug_counts AS (
    SELECT 
      (SELECT COUNT(*) FROM student_updates_expanded) AS expanded_count_val,
      (SELECT COUNT(*) FROM updates_with_context) AS version_matched_count_val,
      (SELECT COUNT(*) FROM updated_rows) AS updated_gcs_count_val,
      (SELECT COUNT(DISTINCT (class_id, gradebook_id, student_id, is_private)) FROM update_counts) AS unique_students_count_val,
      (SELECT COUNT(*) FROM cleared_rows) AS cleared_state_count_val,
      (SELECT jsonb_agg(jsonb_build_object(
        'student_id', student_id,
        'is_private', is_private,
        'dirty_after_update', dirty,
        'is_recalculating_after_update', is_recalculating,
        'version_after_update', version,
        'expected_version', expected_version_from_all_students
      )) FROM cleared_rows_debug) AS cleared_rows_details
  ),
      final_results AS (
        SELECT 
          jsonb_agg(
            jsonb_build_object(
              'class_id', class_id,
              'gradebook_id', gradebook_id,
              'student_id', student_id,
              'is_private', is_private,
              'message_ids', message_ids,
              'updated_count', updated_count,
              'version_matched', version_matched,
              'cleared', cleared
            ) ORDER BY student_id
          ) AS results_jsonb,
      (SELECT expanded_count_val FROM debug_counts LIMIT 1) AS expanded_count_val,
      (SELECT version_matched_count_val FROM debug_counts LIMIT 1) AS version_matched_count_val,
      (SELECT updated_gcs_count_val FROM debug_counts LIMIT 1) AS updated_gcs_count_val,
      (SELECT unique_students_count_val FROM debug_counts LIMIT 1) AS unique_students_count_val,
      (SELECT cleared_state_count_val FROM debug_counts LIMIT 1) AS cleared_state_count_val,
      (SELECT cleared_rows_details FROM debug_counts LIMIT 1) AS cleared_rows_details_val
    FROM student_results
  )
  SELECT 
    results_jsonb,
    expanded_count_val,
    version_matched_count_val,
    updated_gcs_count_val,
    unique_students_count_val,
    cleared_state_count_val,
    cleared_rows_details_val
  INTO 
    results,
    expanded_count,
    version_matched_count,
    updated_gcs_count,
    unique_students_count,
    cleared_state_count,
    cleared_details
  FROM final_results;
  
  RAISE NOTICE '[update_gradebook_rows_batch] Step 1: Expanded % update rows from input', expanded_count;
  RAISE NOTICE '[update_gradebook_rows_batch] Step 2: % rows matched version check (will be updated)', version_matched_count;
  RAISE NOTICE '[update_gradebook_rows_batch] Step 3: Updated % gradebook_column_students rows', updated_gcs_count;
  RAISE NOTICE '[update_gradebook_rows_batch] Step 4: Found % unique students with updates, preparing to clear recalc state', unique_students_count;
  RAISE NOTICE '[update_gradebook_rows_batch] Step 5: Cleared recalc state for % rows', cleared_state_count;
  
  -- Debug: Log details of cleared rows to verify they were actually cleared
  IF cleared_details IS NOT NULL AND jsonb_array_length(cleared_details) > 0 THEN
    RAISE NOTICE '[update_gradebook_rows_batch] Step 5 details: %', cleared_details;
  END IF;
  
  RAISE NOTICE '[update_gradebook_rows_batch] Step 6: Built results for % students', jsonb_array_length(results);
  
  -- Step 7: Archive messages for successfully cleared rows (version matched)
  -- Extract message IDs from results where version matched and cleared
  SELECT ARRAY_AGG(DISTINCT msg_ids.msg_id) INTO message_ids_to_archive
  FROM (
    SELECT UNNEST(
      ARRAY(
        SELECT jsonb_array_elements_text(sr->'message_ids')
        FROM jsonb_array_elements(results) AS sr
        WHERE (sr->>'version_matched')::boolean = true 
          AND (sr->>'cleared')::boolean = true
          AND sr->'message_ids' IS NOT NULL
      )
    )::bigint AS msg_id
  ) AS msg_ids;
  
  IF message_ids_to_archive IS NOT NULL AND array_length(message_ids_to_archive, 1) > 0 THEN
    RAISE NOTICE '[update_gradebook_rows_batch] Step 7: Archiving % messages', array_length(message_ids_to_archive, 1);
    FOREACH msg_id IN ARRAY message_ids_to_archive
    LOOP
      PERFORM pgmq_public.archive('gradebook_row_recalculate', msg_id);
    END LOOP;
    RAISE NOTICE '[update_gradebook_rows_batch] Step 7: Archived % messages', array_length(message_ids_to_archive, 1);
  END IF;
  
  -- Step 8: Re-enqueue rows with version mismatches
  -- Extract rows from results where version did not match
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'class_id', (sr->>'class_id')::bigint,
        'gradebook_id', (sr->>'gradebook_id')::bigint,
        'student_id', sr->>'student_id',
        'is_private', (sr->>'is_private')::boolean
      )
    ),
    '[]'::jsonb
  ) INTO rows_to_reenqueue
  FROM jsonb_array_elements(results) AS sr
  WHERE (sr->>'version_matched')::boolean = false;
  
  IF rows_to_reenqueue IS NOT NULL AND jsonb_array_length(rows_to_reenqueue) > 0 THEN
    RAISE NOTICE '[update_gradebook_rows_batch] Step 8: Re-enqueueing % rows with version mismatches', jsonb_array_length(rows_to_reenqueue);
    -- Build messages array and send directly to queue (no state update needed)
    -- The state is already set from the original enqueue, we just need to re-send the message
    SELECT ARRAY_AGG(
      jsonb_build_object(
        'class_id', (sr->>'class_id')::bigint,
        'gradebook_id', (sr->>'gradebook_id')::bigint,
        'student_id', sr->>'student_id',
        'is_private', (sr->>'is_private')::boolean
      )
    ) INTO messages_to_send
    FROM jsonb_array_elements(rows_to_reenqueue) AS sr;
    
    IF messages_to_send IS NOT NULL AND array_length(messages_to_send, 1) > 0 THEN
      PERFORM pgmq_public.send_batch(
        queue_name := 'gradebook_row_recalculate',
        messages := messages_to_send
      );
      RAISE NOTICE '[update_gradebook_rows_batch] Step 8: Re-enqueued % messages directly to queue', array_length(messages_to_send, 1);
    END IF;
  END IF;
  
  RAISE NOTICE '[update_gradebook_rows_batch] Function completed successfully';
  
  RETURN COALESCE(results, '[]'::jsonb);
END;
$$;

COMMENT ON FUNCTION public.update_gradebook_rows_batch(jsonb[])
  IS 'Batch updates multiple students gradebook_column_students and clears gradebook_row_recalc_state in a single transaction. Returns results for each student. Also clears state for students with no updates when version matches.';

-- ============================================================================
-- REPLACE TRIGGER WITH RPC FUNCTIONS
-- ============================================================================

-- Replace trigger-based dependent recalculation with explicit RPC calls
-- This gives us explicit control over when recalculation is enqueued,
-- preventing the trigger from firing when the worker updates rows.

DROP TRIGGER IF EXISTS trigger_recalculate_dependent_columns_statement ON public.gradebook_column_students;

-- Single row update with dependent recalculation enqueue
CREATE OR REPLACE FUNCTION public.update_gradebook_column_student_with_recalc(
  p_id bigint,
  p_updates jsonb
) RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
  updated_row public.gradebook_column_students%ROWTYPE;
  old_row public.gradebook_column_students%ROWTYPE;
  rows_to_enqueue jsonb[];
  r RECORD;
BEGIN
  -- Get the old row values
  SELECT * INTO old_row FROM public.gradebook_column_students WHERE id = p_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gradebook_column_students row with id % not found', p_id;
  END IF;
  
  -- Perform the UPDATE
  UPDATE public.gradebook_column_students
  SET
    score = CASE WHEN p_updates ? 'score' THEN (p_updates->>'score')::numeric ELSE score END,
    score_override = CASE WHEN p_updates ? 'score_override' THEN (p_updates->>'score_override')::numeric ELSE score_override END,
    is_missing = CASE WHEN p_updates ? 'is_missing' THEN (p_updates->>'is_missing')::boolean ELSE is_missing END,
    is_excused = CASE WHEN p_updates ? 'is_excused' THEN (p_updates->>'is_excused')::boolean ELSE is_excused END,
    is_droppable = CASE WHEN p_updates ? 'is_droppable' THEN (p_updates->>'is_droppable')::boolean ELSE is_droppable END,
    released = CASE WHEN p_updates ? 'released' THEN (p_updates->>'released')::boolean ELSE released END,
    score_override_note = CASE WHEN p_updates ? 'score_override_note' THEN (p_updates->>'score_override_note')::text ELSE score_override_note END,
    incomplete_values = CASE WHEN p_updates ? 'incomplete_values' THEN p_updates->'incomplete_values' ELSE incomplete_values END
  WHERE id = p_id
  RETURNING * INTO updated_row;
  
  -- Check if any relevant fields changed
  IF (
    updated_row.score IS DISTINCT FROM old_row.score OR
    updated_row.score_override IS DISTINCT FROM old_row.score_override OR
    updated_row.is_missing IS DISTINCT FROM old_row.is_missing OR
    updated_row.is_droppable IS DISTINCT FROM old_row.is_droppable OR
    updated_row.is_excused IS DISTINCT FROM old_row.is_excused
  ) THEN
    -- Enqueue recalculation for this student's row (skip if currently being recalculated)
    IF NOT EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = updated_row.class_id
        AND rs.gradebook_id = updated_row.gradebook_id
        AND rs.student_id = updated_row.student_id
        AND rs.is_private = updated_row.is_private
        AND rs.is_recalculating = true
    ) THEN
      PERFORM public.enqueue_gradebook_row_recalculation_batch(ARRAY[
        jsonb_build_object(
          'class_id', updated_row.class_id,
          'gradebook_id', updated_row.gradebook_id,
          'student_id', updated_row.student_id,
          'is_private', updated_row.is_private
        )
      ]);
    END IF;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.update_gradebook_column_student_with_recalc(bigint, jsonb)
  IS 'Updates a single gradebook_column_students row and enqueues dependent recalculations. Replaces the trigger-based approach for explicit control.';

-- Batch update with dependent recalculation enqueue
CREATE OR REPLACE FUNCTION public.update_gradebook_column_students_batch_with_recalc(
  p_updates jsonb[]
) RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
  update_obj jsonb;
  p_id bigint;
  p_update_data jsonb;
  updated_count integer := 0;
  all_rows_to_enqueue jsonb[] := ARRAY[]::jsonb[];
  r RECORD;
  changed_rows jsonb[];
BEGIN
  -- Process each update
  FOREACH update_obj IN ARRAY p_updates
  LOOP
    p_id := (update_obj->>'id')::bigint;
    p_update_data := update_obj->'updates';
    
    IF p_id IS NULL OR p_update_data IS NULL THEN
      CONTINUE;
    END IF;
    
    -- Get old row values
    DECLARE
      old_row public.gradebook_column_students%ROWTYPE;
      updated_row public.gradebook_column_students%ROWTYPE;
    BEGIN
      SELECT * INTO old_row FROM public.gradebook_column_students WHERE id = p_id;
      
      IF NOT FOUND THEN
        CONTINUE;
      END IF;
      
      -- Perform the UPDATE
      UPDATE public.gradebook_column_students
      SET
        score = CASE WHEN p_update_data ? 'score' THEN (p_update_data->>'score')::numeric ELSE score END,
        score_override = CASE WHEN p_update_data ? 'score_override' THEN (p_update_data->>'score_override')::numeric ELSE score_override END,
        is_missing = CASE WHEN p_update_data ? 'is_missing' THEN (p_update_data->>'is_missing')::boolean ELSE is_missing END,
        is_excused = CASE WHEN p_update_data ? 'is_excused' THEN (p_update_data->>'is_excused')::boolean ELSE is_excused END,
        is_droppable = CASE WHEN p_update_data ? 'is_droppable' THEN (p_update_data->>'is_droppable')::boolean ELSE is_droppable END,
        released = CASE WHEN p_update_data ? 'released' THEN (p_update_data->>'released')::boolean ELSE released END,
        score_override_note = CASE WHEN p_update_data ? 'score_override_note' THEN (p_update_data->>'score_override_note')::text ELSE score_override_note END,
        incomplete_values = CASE WHEN p_update_data ? 'incomplete_values' THEN p_update_data->'incomplete_values' ELSE incomplete_values END
      WHERE id = p_id
      RETURNING * INTO updated_row;
      
      -- Check if any relevant fields changed
      IF (
        updated_row.score IS DISTINCT FROM old_row.score OR
        updated_row.score_override IS DISTINCT FROM old_row.score_override OR
        updated_row.is_missing IS DISTINCT FROM old_row.is_missing OR
        updated_row.is_droppable IS DISTINCT FROM old_row.is_droppable OR
        updated_row.is_excused IS DISTINCT FROM old_row.is_excused
      ) THEN
        updated_count := updated_count + 1;
        changed_rows := array_append(changed_rows, to_jsonb(updated_row));
        
        -- Add this student's row to enqueue list (skip if currently being recalculated)
        IF NOT EXISTS (
          SELECT 1 FROM public.gradebook_row_recalc_state rs
          WHERE rs.class_id = updated_row.class_id
            AND rs.gradebook_id = updated_row.gradebook_id
            AND rs.student_id = updated_row.student_id
            AND rs.is_private = updated_row.is_private
            AND rs.is_recalculating = true
        ) THEN
          -- Check if we already have this row in our enqueue list
          IF NOT EXISTS (
            SELECT 1 FROM unnest(all_rows_to_enqueue) AS existing
            WHERE (existing->>'class_id')::bigint = updated_row.class_id
              AND (existing->>'gradebook_id')::bigint = updated_row.gradebook_id
              AND (existing->>'student_id')::uuid = updated_row.student_id
              AND (existing->>'is_private')::boolean = updated_row.is_private
          ) THEN
            all_rows_to_enqueue := array_append(all_rows_to_enqueue, 
              jsonb_build_object(
                'class_id', updated_row.class_id,
                'gradebook_id', updated_row.gradebook_id,
                'student_id', updated_row.student_id,
                'is_private', updated_row.is_private
              )
            );
          END IF;
        END IF;
      END IF;
    END;
  END LOOP;
  
  -- Batch enqueue all dependent rows in a single call
  IF array_length(all_rows_to_enqueue, 1) > 0 THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(all_rows_to_enqueue);
  END IF;
  
  RETURN jsonb_build_object(
    'updated_count', updated_count,
    'enqueued_count', COALESCE(array_length(all_rows_to_enqueue, 1), 0)
  );
END;
$$;

COMMENT ON FUNCTION public.update_gradebook_column_students_batch_with_recalc(jsonb[])
  IS 'Batch updates multiple gradebook_column_students rows and enqueues dependent recalculations. Replaces the trigger-based approach for explicit control.';

-- ============================================================================
-- SUBMISSION_REVIEWS STATEMENT-LEVEL BROADCAST HANDLING
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcast_submission_reviews_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    affected_row_ids BIGINT[];
    affected_count INTEGER;
    submission_ids BIGINT[];
    submission_id BIGINT;
    class_ids BIGINT[];
    class_id_value BIGINT;
    grader_payload JSONB;
    user_payload JSONB;
    operation_type TEXT;
    affected_profile_ids UUID[];
    profile_id UUID;
    BULK_THRESHOLD CONSTANT INTEGER := 50;
    MAX_IDS CONSTANT INTEGER := 49;
BEGIN
    operation_type := TG_OP;
    
    -- Collect affected row IDs and submission IDs
    IF operation_type = 'DELETE' THEN
        SELECT 
            ARRAY_AGG(old_table.id ORDER BY old_table.id),
            COUNT(*),
            ARRAY_AGG(DISTINCT old_table.submission_id ORDER BY old_table.submission_id),
            ARRAY_AGG(DISTINCT old_table.class_id ORDER BY old_table.class_id)
        INTO affected_row_ids, affected_count, submission_ids, class_ids
        FROM old_table;
        
        SELECT DISTINCT old_table.class_id INTO class_id_value
        FROM old_table
        LIMIT 1;
    ELSE
        SELECT 
            ARRAY_AGG(new_table.id ORDER BY new_table.id),
            COUNT(*),
            ARRAY_AGG(DISTINCT new_table.submission_id ORDER BY new_table.submission_id),
            ARRAY_AGG(DISTINCT new_table.class_id ORDER BY new_table.class_id)
        INTO affected_row_ids, affected_count, submission_ids, class_ids
        FROM new_table;
        
        SELECT DISTINCT new_table.class_id INTO class_id_value
        FROM new_table
        LIMIT 1;
    END IF;
    
    IF affected_count IS NULL OR affected_count = 0 OR class_id_value IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Build payload based on affected count
    IF affected_count >= BULK_THRESHOLD THEN
        grader_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', operation_type,
            'table', 'submission_reviews',
            'class_id', class_id_value,
            'affected_count', affected_count,
            'requires_refetch', true,
            'timestamp', NOW()
        );
    ELSE
        IF array_length(affected_row_ids, 1) > MAX_IDS THEN
            affected_row_ids := affected_row_ids[1:MAX_IDS];
        END IF;
        
        grader_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', operation_type,
            'table', 'submission_reviews',
            'row_ids', affected_row_ids,
            'affected_count', affected_count,
            'class_id', class_id_value,
            'requires_refetch', false,
            'timestamp', NOW()
        );
    END IF;
    
    -- For large bulk operations, broadcast to general class channels
    -- For small operations, broadcast to specific submission channels
    IF affected_count >= BULK_THRESHOLD THEN
        -- Large bulk: broadcast to general class channels (clients will refetch)
        PERFORM public.safe_broadcast(
            grader_payload,
            'broadcast',
            'class:' || class_id_value || ':staff',
            true
        );
    ELSE
        -- Small bulk: broadcast to specific submission channels
        FOREACH submission_id IN ARRAY submission_ids
        LOOP
            -- Broadcast to graders channel for this submission
            PERFORM public.safe_broadcast(
                grader_payload || jsonb_build_object('submission_id', submission_id),
                'broadcast',
                'submission:' || submission_id || ':graders',
                true
            );
            
            -- Get affected profile IDs for this submission
            SELECT ARRAY(
                SELECT DISTINCT COALESCE(s.profile_id, agm.profile_id)
                FROM public.submissions s
                LEFT JOIN public.assignment_groups ag ON s.assignment_group_id = ag.id
                LEFT JOIN public.assignment_groups_members agm ON ag.id = agm.assignment_group_id
                WHERE s.id = submission_id
            ) INTO affected_profile_ids;
            
            -- Broadcast to affected user channels
            user_payload := grader_payload || jsonb_build_object('submission_id', submission_id, 'target_audience', 'user');
            FOREACH profile_id IN ARRAY affected_profile_ids
            LOOP
                IF profile_id IS NOT NULL THEN
                    PERFORM public.safe_broadcast(
                        user_payload,
                        'broadcast',
                        'submission:' || submission_id || ':profile_id:' || profile_id,
                        true
                    );
                END IF;
            END LOOP;
        END LOOP;
    END IF;
    
    RETURN NULL;
END;
$$;

-- Drop row-level trigger and create statement-level triggers
DROP TRIGGER IF EXISTS broadcast_submission_reviews_unified ON public.submission_reviews;

CREATE TRIGGER broadcast_submission_reviews_insert_trigger
    AFTER INSERT ON public.submission_reviews
    REFERENCING NEW TABLE AS new_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_submission_reviews_statement();

CREATE TRIGGER broadcast_submission_reviews_update_trigger
    AFTER UPDATE ON public.submission_reviews
    REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_submission_reviews_statement();

CREATE TRIGGER broadcast_submission_reviews_delete_trigger
    AFTER DELETE ON public.submission_reviews
    REFERENCING OLD TABLE AS old_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_submission_reviews_statement();

-- ============================================================================
-- REVIEW_ASSIGNMENTS STATEMENT-LEVEL BROADCAST HANDLING
-- ============================================================================

CREATE OR REPLACE FUNCTION public.broadcast_review_assignments_statement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    affected_row_ids BIGINT[];
    affected_count INTEGER;
    class_id_value BIGINT;
    affected_assignees UUID[];
    assignee_id UUID;
    staff_payload JSONB;
    user_payload JSONB;
    operation_type TEXT;
    BULK_THRESHOLD CONSTANT INTEGER := 50;
    MAX_IDS CONSTANT INTEGER := 49;
BEGIN
    operation_type := TG_OP;
    
    -- Collect affected row IDs and assignee IDs
    IF operation_type = 'DELETE' THEN
        SELECT 
            ARRAY_AGG(old_table.id ORDER BY old_table.id),
            COUNT(*),
            ARRAY_AGG(DISTINCT old_table.assignee_profile_id ORDER BY old_table.assignee_profile_id)
        INTO affected_row_ids, affected_count, affected_assignees
        FROM old_table
        WHERE old_table.assignee_profile_id IS NOT NULL;
        
        SELECT DISTINCT old_table.class_id INTO class_id_value
        FROM old_table
        LIMIT 1;
    ELSE
        SELECT 
            ARRAY_AGG(new_table.id ORDER BY new_table.id),
            COUNT(*),
            ARRAY_AGG(DISTINCT new_table.assignee_profile_id ORDER BY new_table.assignee_profile_id)
        INTO affected_row_ids, affected_count, affected_assignees
        FROM new_table
        WHERE new_table.assignee_profile_id IS NOT NULL;
        
        SELECT DISTINCT new_table.class_id INTO class_id_value
        FROM new_table
        LIMIT 1;
    END IF;
    
    IF affected_count IS NULL OR affected_count = 0 OR class_id_value IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Build payload based on affected count
    IF affected_count >= BULK_THRESHOLD THEN
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', operation_type,
            'table', 'review_assignments',
            'class_id', class_id_value,
            'affected_count', affected_count,
            'requires_refetch', true,
            'timestamp', NOW()
        );
    ELSE
        IF array_length(affected_row_ids, 1) > MAX_IDS THEN
            affected_row_ids := affected_row_ids[1:MAX_IDS];
        END IF;
        
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', operation_type,
            'table', 'review_assignments',
            'row_ids', affected_row_ids,
            'affected_count', affected_count,
            'class_id', class_id_value,
            'requires_refetch', false,
            'timestamp', NOW()
        );
    END IF;
    
    -- Broadcast to staff channel
    PERFORM public.safe_broadcast(
        staff_payload,
        'broadcast',
        'class:' || class_id_value || ':staff',
        true
    );
    
    -- For large bulk operations, skip individual assignee broadcasts (refetch handles it)
    -- For small operations, broadcast to individual assignee channels
    IF affected_count < BULK_THRESHOLD THEN
        FOREACH assignee_id IN ARRAY affected_assignees
        LOOP
            IF assignee_id IS NOT NULL THEN
                user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
                PERFORM public.safe_broadcast(
                    user_payload,
                    'broadcast',
                    'class:' || class_id_value || ':user:' || assignee_id,
                    true
                );
            END IF;
        END LOOP;
    END IF;
    
    RETURN NULL;
END;
$$;

-- Drop row-level trigger and create statement-level triggers
DROP TRIGGER IF EXISTS broadcast_review_assignments_unified ON public.review_assignments;

CREATE TRIGGER broadcast_review_assignments_insert_trigger
    AFTER INSERT ON public.review_assignments
    REFERENCING NEW TABLE AS new_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_review_assignments_statement();

CREATE TRIGGER broadcast_review_assignments_update_trigger
    AFTER UPDATE ON public.review_assignments
    REFERENCING OLD TABLE AS old_table NEW TABLE AS new_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_review_assignments_statement();

CREATE TRIGGER broadcast_review_assignments_delete_trigger
    AFTER DELETE ON public.review_assignments
    REFERENCING OLD TABLE AS old_table
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.broadcast_review_assignments_statement();

-- ============================================================================
-- UPDATE RLS AUTHORIZATION FUNCTION FOR GRADEBOOK CHANNELS
-- ============================================================================

-- Update the gradebook realtime authorization function to ensure it properly handles
-- the new gradebook channels: gradebook:$class_id:staff and gradebook:$class_id:student:$student_id
-- This function is called by check_unified_realtime_authorization for gradebook topics
CREATE OR REPLACE FUNCTION public.check_gradebook_realtime_authorization(topic_text text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    topic_parts text[];
    class_id_text text;
    student_id_text text;
    class_id_bigint bigint;
    student_id_uuid uuid;
    is_class_grader boolean;
    is_student_owner boolean;
BEGIN
    -- Parse topic - should be gradebook:123:staff, gradebook:123:students, or gradebook:123:student:uuid
    topic_parts := string_to_array(topic_text, ':');
    
    -- Must have at least 3 parts and start with 'gradebook'
    IF array_length(topic_parts, 1) < 3 OR topic_parts[1] != 'gradebook' THEN
        RETURN false;
    END IF;
    
    class_id_text := topic_parts[2];
    
    -- Convert class_id to bigint
    BEGIN
        class_id_bigint := class_id_text::bigint;
    EXCEPTION WHEN OTHERS THEN
        RETURN false;
    END;
    
    -- Handle different channel types
    IF topic_parts[3] = 'staff' THEN
        -- Staff channel - only graders/instructors
        -- Format: gradebook:$class_id:staff
        RETURN public.authorizeforclassgrader(class_id_bigint);
        
    ELSIF topic_parts[3] = 'students' THEN
        -- General students channel - students and staff (legacy format)
        -- Format: gradebook:$class_id:students
        RETURN public.authorizeforclass(class_id_bigint);
        
    ELSIF topic_parts[3] = 'student' THEN
        -- Individual student channel - must have 4 parts
        -- Format: gradebook:$class_id:student:$student_id
        IF array_length(topic_parts, 1) != 4 THEN
            RETURN false;
        END IF;
        
        student_id_text := topic_parts[4];
        
        -- Convert student_id to uuid
        BEGIN
            student_id_uuid := student_id_text::uuid;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
        
        -- Check if user is grader/instructor OR is the specific student
        is_class_grader := public.authorizeforclassgrader(class_id_bigint);
        is_student_owner := public.authorizeforprofile(student_id_uuid);
        
        RETURN is_class_grader OR is_student_owner;
        
    ELSE
        RETURN false;
    END IF;
END;
$$;

COMMENT ON FUNCTION public.check_gradebook_realtime_authorization(text) IS 
'Authorizes access to gradebook broadcast channels. Supports gradebook:$class_id:staff (graders only), gradebook:$class_id:students (all class members, legacy), and gradebook:$class_id:student:$student_id (graders or specific student only).';

CREATE OR REPLACE FUNCTION public.import_gradebook_scores(
  p_class_id bigint,
  p_updates jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invalid_column_id bigint;
  rows_to_enqueue_jsonb jsonb;
BEGIN
  -- Authorization: only instructors for the class may import
  IF NOT public.authorizeforclassinstructor(p_class_id) THEN
    RAISE EXCEPTION 'Access denied: Only instructors can import grades for class %', p_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Basic shape validation
  IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'array' THEN
    RAISE EXCEPTION 'p_updates must be a JSON array of column update objects'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Validate that all referenced columns exist and belong to this class
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT DISTINCT (elem->>'gradebook_column_id')::bigint AS gradebook_column_id
      FROM jsonb_array_elements(p_updates) AS elem
    ) pc
    LEFT JOIN public.gradebook_columns gc ON gc.id = pc.gradebook_column_id
    WHERE gc.id IS NULL OR gc.class_id <> p_class_id
  ) THEN
    SELECT pc.gradebook_column_id INTO v_invalid_column_id
    FROM (
      SELECT DISTINCT (elem->>'gradebook_column_id')::bigint AS gradebook_column_id
      FROM jsonb_array_elements(p_updates) AS elem
    ) pc
    LEFT JOIN public.gradebook_columns gc ON gc.id = pc.gradebook_column_id
    WHERE gc.id IS NULL OR gc.class_id <> p_class_id
    LIMIT 1;

    RAISE EXCEPTION 'Invalid gradebook_column_id % for class %', v_invalid_column_id, p_class_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Single UPDATE with deterministic deduplication using DISTINCT ON
  WITH parsed_with_ordinality AS (
    SELECT
      (col_elem->>'gradebook_column_id')::bigint AS gradebook_column_id,
      (entry_elem->>'student_id')::uuid AS student_id,
      CASE
        WHEN entry_elem ? 'score' THEN NULLIF(entry_elem->>'score','')::numeric
        WHEN entry_elem ? 'value' THEN NULLIF(entry_elem->>'value','')::numeric
        ELSE NULL
      END AS new_score,
      col_ordinality * 1000 + entry_ordinality AS ordinality
    FROM jsonb_array_elements(p_updates) WITH ORDINALITY AS col_elem(col_elem, col_ordinality)
    CROSS JOIN LATERAL jsonb_array_elements(
      COALESCE(col_elem->'entries', col_elem->'student_scores', '[]'::jsonb)
    ) WITH ORDINALITY AS entry_elem(entry_elem, entry_ordinality)
  ), parsed AS (
    SELECT DISTINCT ON (gradebook_column_id, student_id)
      gradebook_column_id,
      student_id,
      new_score
    FROM parsed_with_ordinality
    ORDER BY gradebook_column_id, student_id, ordinality DESC
  ), target_rows AS (
    SELECT gcs.id, gcs.gradebook_column_id, gcs.student_id
    FROM parsed p
    JOIN public.gradebook_column_students gcs
      ON gcs.gradebook_column_id = p.gradebook_column_id
     AND gcs.student_id = p.student_id
     AND gcs.class_id = p_class_id
     AND gcs.is_private = true
  ), cols AS (
    SELECT id, score_expression
    FROM public.gradebook_columns
    WHERE class_id = p_class_id
      AND id IN (SELECT DISTINCT gradebook_column_id FROM parsed)
  ),
  updated_rows AS (
    UPDATE public.gradebook_column_students g
    SET 
      score = CASE 
        WHEN c.score_expression IS NULL THEN p.new_score 
        ELSE g.score 
      END,
      score_override = CASE 
        WHEN c.score_expression IS NOT NULL THEN p.new_score 
        ELSE g.score_override 
      END
    FROM target_rows tr
    JOIN cols c ON c.id = tr.gradebook_column_id
    JOIN parsed p ON p.gradebook_column_id = tr.gradebook_column_id AND p.student_id = tr.student_id
    WHERE g.id = tr.id
    RETURNING 
      g.class_id,
      g.gradebook_id,
      g.student_id,
      g.is_private
  ),
  -- Collect unique student rows that need recalculation
  rows_to_enqueue AS (
    SELECT DISTINCT
      ur.class_id,
      ur.gradebook_id,
      ur.student_id,
      ur.is_private
    FROM updated_rows ur
    WHERE NOT EXISTS (
      SELECT 1 FROM public.gradebook_row_recalc_state rs
      WHERE rs.class_id = ur.class_id
        AND rs.gradebook_id = ur.gradebook_id
        AND rs.student_id = ur.student_id
        AND rs.is_private = ur.is_private
        AND rs.is_recalculating = true
    )
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'class_id', class_id,
      'gradebook_id', gradebook_id,
      'student_id', student_id,
      'is_private', is_private
    )
  ) INTO rows_to_enqueue_jsonb
  FROM rows_to_enqueue;

  -- Batch enqueue recalculation for all affected student rows
  IF rows_to_enqueue_jsonb IS NOT NULL AND jsonb_array_length(rows_to_enqueue_jsonb) > 0 THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(
      ARRAY(SELECT jsonb_array_elements(rows_to_enqueue_jsonb))
    );
  END IF;

  RETURN true;
END;
$$;
