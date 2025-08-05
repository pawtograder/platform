-- Migration: Add broadcast triggers for gradebook tables
-- This migration creates broadcast triggers for gradebook_columns and gradebook_column_students
-- following the unified channel system established in 20250707020000_unified-broadcast-channels.sql

-- Create unified broadcast function for gradebook_columns changes
CREATE OR REPLACE FUNCTION broadcast_gradebook_columns_change()
RETURNS TRIGGER AS $$
DECLARE
    target_class_id BIGINT;
    staff_payload JSONB;
    user_payload JSONB;
    affected_profile_ids UUID[];
    profile_id UUID;
BEGIN
    -- Get the class_id from the record
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
    END IF;

    IF target_class_id IS NOT NULL THEN
        -- Create payload for gradebook_columns changes
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END,
            'data', CASE
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', target_class_id,
            'target_audience', 'staff',
            'timestamp', NOW()
        );

        -- Broadcast to staff channel (instructors and graders see all column changes)
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- Get all students in the class for user channels
        SELECT ARRAY(
            SELECT ur.private_profile_id
            FROM user_roles ur
            WHERE ur.class_id = target_class_id AND ur.role = 'student'
        ) INTO affected_profile_ids;

        -- Create user payload (same as staff but marked for users)
        user_payload := staff_payload || jsonb_build_object('target_audience', 'user');

        -- Broadcast to all student user channels (students see column structure changes)
        FOREACH profile_id IN ARRAY affected_profile_ids
        LOOP
            PERFORM realtime.send(
                user_payload,
                'broadcast',
                'class:' || target_class_id || ':user:' || profile_id,
                true
            );
        END LOOP;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create unified broadcast function for gradebook_column_students changes
CREATE OR REPLACE FUNCTION broadcast_gradebook_column_students_change()
RETURNS TRIGGER AS $$
DECLARE
    target_class_id BIGINT;
    target_student_id UUID;
    target_is_private BOOLEAN;
    staff_payload JSONB;
    user_payload JSONB;
BEGIN
    -- Get the class_id, student_id, and is_private from the record
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

    IF target_class_id IS NOT NULL AND target_student_id IS NOT NULL THEN
        -- Create base payload for gradebook_column_students changes
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE
                WHEN TG_OP = 'DELETE' THEN OLD.id
                ELSE NEW.id
            END,
            'data', CASE
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', target_class_id,
            'student_id', target_student_id,
            'is_private', target_is_private,
            'timestamp', NOW()
        );

        -- Always broadcast to staff channel (instructors and graders see all changes)
        PERFORM realtime.send(
            staff_payload || jsonb_build_object('target_audience', 'staff'),
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- If this is a public record (is_private = false), also broadcast to the student's channel
        IF target_is_private = false THEN
            user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
            
            PERFORM realtime.send(
                user_payload,
                'broadcast',
                'class:' || target_class_id || ':user:' || target_student_id,
                true
            );
        END IF;
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create triggers for gradebook_columns
CREATE OR REPLACE TRIGGER broadcast_gradebook_columns_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."gradebook_columns"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_gradebook_columns_change();

-- Create triggers for gradebook_column_students
CREATE OR REPLACE TRIGGER broadcast_gradebook_column_students_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."gradebook_column_students"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_gradebook_column_students_change();

-- Add comments for documentation
COMMENT ON FUNCTION broadcast_gradebook_columns_change() IS 
'Broadcasts changes to gradebook_columns table using unified channel system. Messages are sent to both staff channel and all student user channels.';

COMMENT ON FUNCTION broadcast_gradebook_column_students_change() IS 
'Broadcasts changes to gradebook_column_students table using unified channel system. Messages are sent to staff channel for all changes, and to individual student user channels for public records (is_private = false).';

-- Usage Notes:
-- 
-- 1. Channel patterns:
--    Staff (sees all changes): class:$class_id:staff
--    Students (sees their public records): class:$class_id:user:$student_id
--    
-- 2. Message payload format:
--    {
--      "type": "table_change",
--      "operation": "INSERT|UPDATE|DELETE",
--      "table": "gradebook_columns|gradebook_column_students",
--      "row_id": 123,
--      "data": { ... },                    // Full record data
--      "class_id": 456,                    // Context information
--      "student_id": "uuid-here",          // Only for gradebook_column_students
--      "is_private": true|false,           // Only for gradebook_column_students
--      "target_audience": "staff|user",    // Indicates intended audience
--      "timestamp": "2025-08-04T..."
--    }
--
-- 3. Client-side handling:
--    - Staff subscribe to class:$class_id:staff to see all gradebook changes
--    - Students subscribe to class:$class_id:user:$their_profile_id to see their public grades
--    - Filter messages by table name and relevant fields
--    - Handle both gradebook structure changes (columns) and grade changes (column_students)
--    - RLS policies automatically apply when fetching additional data