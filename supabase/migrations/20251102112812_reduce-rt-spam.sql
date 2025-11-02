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
    
    -- If no rows affected, exit early
    IF affected_count IS NULL OR affected_count = 0 THEN
        RETURN NULL;
    END IF;
    
    IF class_id_value IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Build payload based on affected count
    IF affected_count >= BULK_THRESHOLD THEN
        -- Large bulk: refetch signal
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
        END IF;
        
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
        FOREACH student_id IN ARRAY public_student_ids
        LOOP
            PERFORM public.safe_broadcast(
                student_payload,
                'broadcast',
                'gradebook:' || class_id_value || ':student:' || student_id,
                true
            );
        END LOOP;
    END IF;
    
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
    BULK_THRESHOLD CONSTANT INTEGER := 50;
BEGIN
    operation_type := TG_OP;
    
    -- Collect affected count (no id column - composite PK on class_id, gradebook_id, student_id, is_private)
    IF operation_type = 'DELETE' THEN
        SELECT COUNT(*)
        INTO affected_count
        FROM old_table;
        
        SELECT DISTINCT old_table.class_id INTO class_id_value
        FROM old_table
        LIMIT 1;
    ELSE
        SELECT COUNT(*)
        INTO affected_count
        FROM new_table;
        
        SELECT DISTINCT new_table.class_id INTO class_id_value
        FROM new_table
        LIMIT 1;
    END IF;
    
    IF affected_count IS NULL OR affected_count = 0 OR class_id_value IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Build payload - always use refetch signal since we don't have simple row IDs
    -- (composite key would be complex to handle, so refetch is simpler)
    staff_payload := jsonb_build_object(
        'type', 'table_change',
        'operation', operation_type,
        'table', 'gradebook_row_recalc_state',
        'class_id', class_id_value,
        'affected_count', affected_count,
        'requires_refetch', true,
        'timestamp', NOW()
    );
    
    -- Broadcast ONLY to gradebook staff channel
    PERFORM public.safe_broadcast(
        staff_payload,
        'broadcast',
        'gradebook:' || class_id_value || ':staff',
        true
    );
    
    RETURN NULL;
END;
$$;

-- Drop row-level trigger and create statement-level triggers
DROP TRIGGER IF EXISTS broadcast_gradebook_row_recalc_state ON public.gradebook_row_recalc_state;

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

