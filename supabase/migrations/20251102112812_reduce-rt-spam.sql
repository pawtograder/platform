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
BEGIN
    operation_type := TG_OP;
    RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Trigger fired: operation=%, table=gradebook_row_recalc_state', operation_type;
    
    -- Collect affected count and all unique class_ids
    -- Use transition tables directly (old_table/new_table are statement-level trigger transition tables)
    -- Note: For INSERT ... ON CONFLICT DO UPDATE, PostgreSQL fires UPDATE trigger when conflict occurs
    -- so we need to handle both INSERT and UPDATE cases properly
    -- IMPORTANT: Only broadcast is_private = true rows to staff channel
    IF operation_type = 'DELETE' THEN
        SELECT COUNT(*), ARRAY_AGG(DISTINCT t.class_id ORDER BY t.class_id)
        INTO affected_count, class_ids
        FROM old_table t
        WHERE t.is_private = true;
    ELSIF operation_type = 'UPDATE' THEN
        -- For UPDATE (including INSERT ... ON CONFLICT DO UPDATE), use new_table to get updated values
        SELECT COUNT(*), ARRAY_AGG(DISTINCT t.class_id ORDER BY t.class_id)
        INTO affected_count, class_ids
        FROM new_table t
        WHERE t.is_private = true;
    ELSE
        -- INSERT (including INSERT ... ON CONFLICT DO UPDATE when no conflict)
        -- Optimization: When INSERT ... ON CONFLICT DO UPDATE has a conflict, PostgreSQL fires both
        -- INSERT and UPDATE triggers. The INSERT trigger will have an empty new_table (because the INSERT
        -- didn't happen, the UPDATE did). We check for this and return early.
        SELECT COUNT(*), ARRAY_AGG(DISTINCT t.class_id ORDER BY t.class_id)
        INTO affected_count, class_ids
        FROM new_table t
        WHERE t.is_private = true;
        
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
        -- Build payload - always use refetch signal since we have multiple rows with composite keys
        -- This ensures the frontend refreshes all affected rows
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', operation_type,
            'table', 'gradebook_row_recalc_state',
            'class_id', class_id_value,
            'affected_count', affected_count,
            'requires_refetch', true,
            'timestamp', NOW()
        );
        
        RAISE NOTICE '[broadcast_gradebook_row_recalc_state_statement] Broadcasting to class_id=%, channel=gradebook:%:staff, affected_count=% (private rows only)', class_id_value, class_id_value, affected_count;
        
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

