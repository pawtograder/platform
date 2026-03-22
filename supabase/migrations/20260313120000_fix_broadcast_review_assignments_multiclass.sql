-- Migration: Fix broadcast_review_assignments_statement to handle multi-class operations
--
-- Problem: The check_assignment_deadlines_passed() cron job does a bulk INSERT into 
-- review_assignments that can span multiple classes. The broadcast_review_assignments_statement()
-- trigger was raising an exception when this happened, causing the cron job to fail.
--
-- Solution: Instead of raising an exception when multiple classes are affected, broadcast
-- to each class separately. For multi-class bulk operations, use requires_refetch=true
-- for each class since we can't efficiently partition row IDs by class.

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
    class_ids BIGINT[];
    class_affected_count INTEGER;
    class_row_ids BIGINT[];
    class_assignees UUID[];
    assignee_id UUID;
    staff_payload JSONB;
    user_payload JSONB;
    operation_type TEXT;
    BULK_THRESHOLD CONSTANT INTEGER := 50;
    MAX_IDS CONSTANT INTEGER := 49;
    MULTICLASS_ROW_THRESHOLD CONSTANT INTEGER := 300;
BEGIN
    operation_type := TG_OP;
    
    -- Collect class_ids from all affected rows
    IF operation_type = 'DELETE' THEN
        SELECT ARRAY_AGG(DISTINCT old_table.class_id ORDER BY old_table.class_id)
        INTO class_ids
        FROM old_table
        WHERE old_table.class_id IS NOT NULL;
        
        SELECT COUNT(*) INTO affected_count FROM old_table;
    ELSE
        SELECT ARRAY_AGG(DISTINCT new_table.class_id ORDER BY new_table.class_id)
        INTO class_ids
        FROM new_table
        WHERE new_table.class_id IS NOT NULL;
        
        SELECT COUNT(*) INTO affected_count FROM new_table;
    END IF;
    
    -- Early exit if no classes affected
    IF class_ids IS NULL OR array_length(class_ids, 1) IS NULL OR array_length(class_ids, 1) = 0 THEN
        RETURN NULL;
    END IF;
    
    IF affected_count IS NULL OR affected_count = 0 THEN
        RETURN NULL;
    END IF;
    
    -- Skip broadcasting for very large INSERT operations (>300 rows total) - too slow
    IF operation_type = 'INSERT' AND affected_count > MULTICLASS_ROW_THRESHOLD THEN
        RETURN NULL;
    END IF;
    
    -- Process each class separately
    FOREACH class_id_value IN ARRAY class_ids
    LOOP
        -- Get class-specific data
        IF operation_type = 'DELETE' THEN
            SELECT 
                ARRAY_AGG(old_table.id ORDER BY old_table.id),
                COUNT(*),
                ARRAY_AGG(DISTINCT old_table.assignee_profile_id ORDER BY old_table.assignee_profile_id)
            INTO class_row_ids, class_affected_count, class_assignees
            FROM old_table
            WHERE old_table.class_id = class_id_value
              AND old_table.assignee_profile_id IS NOT NULL;
        ELSE
            SELECT 
                ARRAY_AGG(new_table.id ORDER BY new_table.id),
                COUNT(*),
                ARRAY_AGG(DISTINCT new_table.assignee_profile_id ORDER BY new_table.assignee_profile_id)
            INTO class_row_ids, class_affected_count, class_assignees
            FROM new_table
            WHERE new_table.class_id = class_id_value
              AND new_table.assignee_profile_id IS NOT NULL;
        END IF;
        
        -- Skip this class if no rows with assignees
        IF class_affected_count IS NULL OR class_affected_count = 0 THEN
            CONTINUE;
        END IF;
        
        -- Build payload based on affected count for this class
        IF class_affected_count >= BULK_THRESHOLD THEN
            staff_payload := jsonb_build_object(
                'type', 'table_change',
                'operation', operation_type,
                'table', 'review_assignments',
                'class_id', class_id_value,
                'affected_count', class_affected_count,
                'requires_refetch', true,
                'timestamp', NOW()
            );
        ELSE
            IF class_row_ids IS NOT NULL AND array_length(class_row_ids, 1) > MAX_IDS THEN
                class_row_ids := class_row_ids[1:MAX_IDS];
            END IF;
            
            staff_payload := jsonb_build_object(
                'type', 'table_change',
                'operation', operation_type,
                'table', 'review_assignments',
                'row_ids', COALESCE(class_row_ids, ARRAY[]::BIGINT[]),
                'affected_count', class_affected_count,
                'class_id', class_id_value,
                'requires_refetch', false,
                'timestamp', NOW()
            );
        END IF;
        
        -- Broadcast to staff channel for this class
        PERFORM public.safe_broadcast(
            staff_payload,
            'broadcast',
            'class:' || class_id_value || ':staff',
            true
        );
        
        -- For small operations per class, broadcast to individual assignee channels
        IF class_affected_count < BULK_THRESHOLD AND class_assignees IS NOT NULL THEN
            FOREACH assignee_id IN ARRAY class_assignees
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
    END LOOP;
    
    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.broadcast_review_assignments_statement() IS 
'Statement-level trigger function that broadcasts review_assignments changes to realtime channels.
Handles multi-class operations by broadcasting to each class separately (e.g., from check_assignment_deadlines_passed cron job).
For bulk operations (>=50 rows per class), sends requires_refetch=true. For small operations, includes specific row IDs.
Skips broadcasting entirely for very large inserts (>300 rows total) for performance.';
