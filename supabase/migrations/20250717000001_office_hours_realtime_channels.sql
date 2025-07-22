-- Migration: Office Hours Realtime Channels
-- This migration creates realtime broadcast channels for office hours features:
-- - help_request:<id> (all associated details for a given help_request)
-- - help_request:<id>:staff (moderation and karma data, filtered for students to see their own)
-- - help_queue:<id> (current status of a single help_queue)
-- - help_queues (all help queues with assignments)

-- Create function to pre-create help request channels when help request is inserted
CREATE OR REPLACE FUNCTION create_help_request_channels()
RETURNS TRIGGER AS $$
DECLARE
    affected_profile_ids UUID[];
    profile_id UUID;
BEGIN
    -- Pre-create the main help request channel by sending an initial message
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'help_request_id', NEW.id,
            'class_id', NEW.class_id,
            'created_at', NOW()
        ),
        'system',
        'help_request:' || NEW.id,
        true
    );

    -- Pre-create the staff channel for moderation and karma data
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'help_request_id', NEW.id,
            'class_id', NEW.class_id,
            'created_at', NOW()
        ),
        'system',
        'help_request:' || NEW.id || ':staff',
        true
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to pre-create help request channels
CREATE OR REPLACE TRIGGER create_help_request_channels_trigger
    AFTER INSERT ON "public"."help_requests"
    FOR EACH ROW
    EXECUTE FUNCTION create_help_request_channels();

-- Create function to pre-create help queue channels when help queue is inserted
CREATE OR REPLACE FUNCTION create_help_queue_channels()
RETURNS TRIGGER AS $$
BEGIN
    -- Pre-create the individual help queue channel
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'help_queue_id', NEW.id,
            'class_id', NEW.class_id,
            'created_at', NOW()
        ),
        'system',
        'help_queue:' || NEW.id,
        true
    );

    -- Also broadcast to the global help_queues channel
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'help_queue_created',
            'help_queue_id', NEW.id,
            'class_id', NEW.class_id,
            'created_at', NOW()
        ),
        'system',
        'help_queues',
        true
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to pre-create help queue channels
CREATE OR REPLACE TRIGGER create_help_queue_channels_trigger
    AFTER INSERT ON "public"."help_queues"
    FOR EACH ROW
    EXECUTE FUNCTION create_help_queue_channels();

-- Create unified broadcast function for help request data changes
CREATE OR REPLACE FUNCTION broadcast_help_request_data_change()
RETURNS TRIGGER AS $$
DECLARE
    help_request_id BIGINT;
    class_id BIGINT;
    row_id BIGINT;
    main_payload JSONB;
BEGIN
    -- Get the help_request_id and class_id based on the table
    IF TG_TABLE_NAME = 'help_requests' THEN
        IF TG_OP = 'INSERT' THEN
            help_request_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_request_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            help_request_id := OLD.id;
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    ELSE
        -- For related tables, get help_request_id from the appropriate column
        IF TG_TABLE_NAME = 'help_request_message_read_receipts' THEN
            -- For read receipts, we need to look up help_request_id via message_id
            IF TG_OP = 'INSERT' THEN
                SELECT hrm.help_request_id INTO help_request_id
                FROM public.help_request_messages hrm
                WHERE hrm.id = NEW.message_id;
                class_id := NEW.class_id;
                row_id := NEW.id;
            ELSIF TG_OP = 'UPDATE' THEN
                SELECT hrm.help_request_id INTO help_request_id
                FROM public.help_request_messages hrm
                WHERE hrm.id = NEW.message_id;
                class_id := NEW.class_id;
                row_id := NEW.id;
            ELSIF TG_OP = 'DELETE' THEN
                SELECT hrm.help_request_id INTO help_request_id
                FROM public.help_request_messages hrm
                WHERE hrm.id = OLD.message_id;
                class_id := OLD.class_id;
                row_id := OLD.id;
            END IF;
        ELSE
            -- For other related tables, get help_request_id from the direct column
            IF TG_OP = 'INSERT' THEN
                help_request_id := NEW.help_request_id;
                class_id := NEW.class_id;
                row_id := NEW.id;
            ELSIF TG_OP = 'UPDATE' THEN
                help_request_id := COALESCE(NEW.help_request_id, OLD.help_request_id);
                class_id := COALESCE(NEW.class_id, OLD.class_id);
                row_id := NEW.id;
            ELSIF TG_OP = 'DELETE' THEN
                help_request_id := OLD.help_request_id;
                class_id := OLD.class_id;
                row_id := OLD.id;
            END IF;
        END IF;
    END IF;

    -- Only broadcast if we have valid help_request_id and class_id
    IF help_request_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Create payload with help request specific information
        main_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'help_request_id', help_request_id,
            'class_id', class_id,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- Broadcast to main help request channel
        PERFORM realtime.send(
            main_payload,
            'broadcast',
            'help_request:' || help_request_id,
            true
        );
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create unified broadcast function for help request staff data changes (moderation and karma)
CREATE OR REPLACE FUNCTION broadcast_help_request_staff_data_change()
RETURNS TRIGGER AS $$
DECLARE
    help_request_id BIGINT;
    class_id BIGINT;
    student_profile_id UUID;
    row_id BIGINT;
    staff_payload JSONB;
BEGIN
    -- Get relevant IDs based on table
    IF TG_TABLE_NAME = 'help_request_moderation' THEN
        IF TG_OP = 'INSERT' THEN
            help_request_id := NEW.help_request_id;
            class_id := NEW.class_id;
            student_profile_id := NEW.student_profile_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_request_id := NEW.help_request_id;
            class_id := NEW.class_id;
            student_profile_id := NEW.student_profile_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            help_request_id := OLD.help_request_id;
            class_id := OLD.class_id;
            student_profile_id := OLD.student_profile_id;
            row_id := OLD.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'student_karma_notes' THEN
        -- For karma data, we'll broadcast to all relevant help request staff channels
        -- This is more complex as karma isn't directly tied to a help request
        -- For now, we'll just broadcast to class-level staff channels
        IF TG_OP = 'INSERT' THEN
            class_id := NEW.class_id;
            student_profile_id := NEW.student_profile_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            class_id := NEW.class_id;
            student_profile_id := NEW.student_profile_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            class_id := OLD.class_id;
            student_profile_id := OLD.student_profile_id;
            row_id := OLD.id;
        END IF;
    END IF;

    -- Only broadcast if we have valid class_id
    IF class_id IS NOT NULL THEN
        -- Create payload with staff-specific information
        staff_payload := jsonb_build_object(
            'type', 'staff_data_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'class_id', class_id,
            'student_profile_id', student_profile_id,
            'help_request_id', help_request_id,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- If tied to a specific help request, broadcast to that help request's staff channel
        IF help_request_id IS NOT NULL THEN
            PERFORM realtime.send(
                staff_payload,
                'broadcast',
                'help_request:' || help_request_id || ':staff',
                true
            );
        END IF;

        -- For karma data, also broadcast to class-level staff channel if it exists
        IF TG_TABLE_NAME = 'student_karma_notes' THEN
            PERFORM realtime.send(
                staff_payload,
                'broadcast',
                'class:' || class_id || ':staff',
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

-- Create unified broadcast function for help queue data changes
CREATE OR REPLACE FUNCTION broadcast_help_queue_data_change()
RETURNS TRIGGER AS $$
DECLARE
    help_queue_id BIGINT;
    class_id BIGINT;
    row_id BIGINT;
    queue_payload JSONB;
BEGIN
    -- Get help_queue_id and class_id based on the table
    IF TG_TABLE_NAME = 'help_queues' THEN
        IF TG_OP = 'INSERT' THEN
            help_queue_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_queue_id := NEW.id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.id;
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'help_queue_assignments' THEN
        IF TG_OP = 'INSERT' THEN
            help_queue_id := NEW.help_queue_id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_queue_id := NEW.help_queue_id;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.help_queue_id;
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    ELSIF TG_TABLE_NAME = 'help_requests' THEN
        -- For help requests, we also need to update the help queue status
        IF TG_OP = 'INSERT' THEN
            help_queue_id := NEW.help_queue;
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            help_queue_id := COALESCE(NEW.help_queue, OLD.help_queue);
            class_id := COALESCE(NEW.class_id, OLD.class_id);
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            help_queue_id := OLD.help_queue;
            class_id := OLD.class_id;
            row_id := OLD.id;
        END IF;
    END IF;

    -- Only broadcast if we have valid help_queue_id and class_id
    IF help_queue_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Create payload with help queue specific information
        queue_payload := jsonb_build_object(
            'type', 'queue_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'help_queue_id', help_queue_id,
            'class_id', class_id,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'timestamp', NOW()
        );

        -- Broadcast to individual help queue channel
        PERFORM realtime.send(
            queue_payload,
            'broadcast',
            'help_queue:' || help_queue_id,
            true
        );

        -- Also broadcast to global help queues channel
        PERFORM realtime.send(
            queue_payload,
            'broadcast',
            'help_queues',
            true
        );
    END IF;

    -- Return the appropriate record
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create triggers for help request related tables
CREATE OR REPLACE TRIGGER broadcast_help_requests_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."help_requests"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_request_data_change();

CREATE OR REPLACE TRIGGER broadcast_help_request_messages_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."help_request_messages"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_request_data_change();

CREATE OR REPLACE TRIGGER broadcast_help_request_message_read_receipts_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."help_request_message_read_receipts"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_request_data_change();

CREATE OR REPLACE TRIGGER broadcast_help_request_file_references_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."help_request_file_references"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_request_data_change();

CREATE OR REPLACE TRIGGER broadcast_help_request_students_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."help_request_students"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_request_data_change();

-- Create triggers for help request staff data (moderation and karma)
CREATE OR REPLACE TRIGGER broadcast_help_request_moderation_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."help_request_moderation"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_request_staff_data_change();

CREATE OR REPLACE TRIGGER broadcast_student_karma_notes_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."student_karma_notes"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_request_staff_data_change();

-- Create triggers for help queue related tables
CREATE OR REPLACE TRIGGER broadcast_help_queues_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."help_queues"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_queue_data_change();

CREATE OR REPLACE TRIGGER broadcast_help_queue_assignments_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."help_queue_assignments"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_queue_data_change();

-- Also broadcast help request changes to help queue channels
CREATE OR REPLACE TRIGGER broadcast_help_requests_to_queue_change
    AFTER INSERT OR UPDATE OR DELETE ON "public"."help_requests"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_help_queue_data_change();

-- Update the unified realtime authorization function to handle office hours channels
CREATE OR REPLACE FUNCTION check_unified_realtime_authorization(topic_text text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    topic_parts text[];
    topic_type text;
    class_id_text text;
    submission_id_text text;
    profile_id_text text;
    help_request_id_text text;
    help_queue_id_text text;
    class_id_bigint bigint;
    submission_id_bigint bigint;
    profile_id_uuid uuid;
    help_request_id_bigint bigint;
    help_queue_id_bigint bigint;
    is_class_grader boolean;
    is_submission_authorized boolean;
    is_profile_owner boolean;
    channel_type text;
BEGIN
    -- Parse topic - can be class:123:staff, class:123:user:profile_uid, 
    -- submission:123:graders, submission:123:profile_id:uuid, 
    -- help_request_123, help_request:123, help_request:123:staff,
    -- help_queue:123, or help_queues
    
    -- Handle special case for help_queues (global channel)
    IF topic_text = 'help_queues' THEN
        -- Allow authenticated users to subscribe to global help queues channel
        -- Individual queue access will be checked by RLS policies
        RETURN auth.role() = 'authenticated';
    END IF;
    
    -- Handle help_request_ channels (legacy format: help_request_123)
    IF topic_text ~ '^help_request_[0-9]+$' THEN
        -- Extract help request ID from topic (format: help_request_123)
        help_request_id_text := substring(topic_text from '^help_request_([0-9]+)$');
        
        -- Convert to bigint
        BEGIN
            help_request_id_bigint := help_request_id_text::bigint;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
        
        -- Use existing help request access function
        RETURN public.can_access_help_request(help_request_id_bigint);
    END IF;

    topic_parts := string_to_array(topic_text, ':');
    
    -- Must have at least 2 parts for new formats
    IF array_length(topic_parts, 1) < 2 THEN
        RETURN false;
    END IF;
    
    topic_type := topic_parts[1];
    
    -- Handle help_request channels (format: help_request:123 or help_request:123:staff)
    IF topic_type = 'help_request' THEN
        help_request_id_text := topic_parts[2];
        
        -- Convert help_request_id to bigint
        BEGIN
            help_request_id_bigint := help_request_id_text::bigint;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
        
        -- Check if this is the staff channel
        IF array_length(topic_parts, 1) = 3 AND topic_parts[3] = 'staff' THEN
            -- Staff channel: check if user is staff or can access help request
            SELECT hr.class_id INTO class_id_bigint
            FROM public.help_requests hr
            WHERE hr.id = help_request_id_bigint;
            
            IF class_id_bigint IS NULL THEN
                RETURN false;
            END IF;
            
            -- Staff can see all moderation data, students can see their own
            RETURN public.authorizeforclassgrader(class_id_bigint) 
                   OR public.can_access_help_request(help_request_id_bigint);
        ELSE
            -- Main help request channel
            RETURN public.can_access_help_request(help_request_id_bigint);
        END IF;
    
    -- Handle help_queue channels (format: help_queue:123)
    ELSIF topic_type = 'help_queue' THEN
        help_queue_id_text := topic_parts[2];
        
        -- Convert help_queue_id to bigint
        BEGIN
            help_queue_id_bigint := help_queue_id_text::bigint;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
        
        -- Check access to help queue by checking class access
        SELECT hq.class_id INTO class_id_bigint
        FROM public.help_queues hq
        WHERE hq.id = help_queue_id_bigint;
        
        IF class_id_bigint IS NOT NULL THEN
            RETURN public.authorizeforclass(class_id_bigint);
        ELSE
            RETURN false;
        END IF;
    
    -- Handle class-level channels (for review_assignments, etc.)
    ELSIF topic_type = 'class' THEN
        class_id_text := topic_parts[2];
        channel_type := topic_parts[3];
        
        -- Convert class_id to bigint
        BEGIN
            class_id_bigint := class_id_text::bigint;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
        
        -- Handle staff channel
        IF channel_type = 'staff' THEN
            RETURN public.authorizeforclassgrader(class_id_bigint);
        
        -- Handle user channel
        ELSIF channel_type = 'user' THEN
            -- Must have 4 parts for user channel
            IF array_length(topic_parts, 1) != 4 THEN
                RETURN false;
            END IF;
            
            profile_id_text := topic_parts[4];

            -- Convert profile_id to uuid
            BEGIN
                profile_id_uuid := profile_id_text::uuid;
            EXCEPTION WHEN OTHERS THEN
                RETURN false;
            END;
            
            -- Check if user is grader/instructor OR is the profile owner
            is_class_grader := public.authorizeforclassgrader(class_id_bigint);
            is_profile_owner := public.authorizeforprofile(profile_id_uuid);
            
            RETURN is_class_grader OR is_profile_owner;
        
        ELSE
            RETURN false;
        END IF;
    
    -- Handle submission-level channels (for comments, reviews, etc.)
    ELSIF topic_type = 'submission' THEN
        submission_id_text := topic_parts[2];
        channel_type := topic_parts[3];
        
        -- Convert submission_id to bigint
        BEGIN
            submission_id_bigint := submission_id_text::bigint;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
        
        -- Handle graders channel
        IF channel_type = 'graders' THEN
            -- Get class_id from submission to check grader status
            SELECT s.class_id INTO class_id_bigint
            FROM public.submissions s
            WHERE s.id = submission_id_bigint;
            
            IF class_id_bigint IS NOT NULL THEN
                RETURN public.authorizeforclassgrader(class_id_bigint);
            ELSE
                RETURN false;
            END IF;
        
        ELSIF channel_type = 'profile_id' THEN
            -- Must have 4 parts for profile_id channel
            IF array_length(topic_parts, 1) != 4 THEN
                RETURN false;
            END IF;
            
            profile_id_text := topic_parts[4];
            
            -- Convert profile_id to uuid
            BEGIN
                profile_id_uuid := profile_id_text::uuid;
            EXCEPTION WHEN OTHERS THEN
                RETURN false;
            END;
            
            -- Check if user has access to the submission OR is the profile owner
            is_submission_authorized := public.authorize_for_submission(submission_id_bigint);
            is_profile_owner := public.authorizeforprofile(profile_id_uuid);
            
            -- Also check if user is a grader for the class (for extra access)
            SELECT s.class_id INTO class_id_bigint
            FROM public.submissions s
            WHERE s.id = submission_id_bigint;
            
            IF class_id_bigint IS NOT NULL THEN
                is_class_grader := public.authorizeforclassgrader(class_id_bigint);
            ELSE
                is_class_grader := false;
            END IF;
            
            RETURN is_class_grader OR is_submission_authorized OR is_profile_owner;
        
        ELSE
            RETURN false;
        END IF;
    
    ELSE
        RETURN false;
    END IF;
END;
$$;

-- Pre-create channels for all existing help requests
DO $$
DECLARE
    help_request_record RECORD;
BEGIN
    FOR help_request_record IN SELECT id, class_id FROM "public"."help_requests"
    LOOP
        -- Pre-create the main help request channel
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'help_request_id', help_request_record.id,
                'class_id', help_request_record.class_id,
                'created_at', NOW()
            ),
            'system',
            'help_request:' || help_request_record.id,
            true
        );

        -- Pre-create the staff channel
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'help_request_id', help_request_record.id,
                'class_id', help_request_record.class_id,
                'created_at', NOW()
            ),
            'system',
            'help_request:' || help_request_record.id || ':staff',
            true
        );
    END LOOP;
END $$;

-- Pre-create channels for all existing help queues
DO $$
DECLARE
    help_queue_record RECORD;
BEGIN
    FOR help_queue_record IN SELECT id, class_id FROM "public"."help_queues"
    LOOP
        -- Pre-create the individual help queue channel
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'help_queue_id', help_queue_record.id,
                'class_id', help_queue_record.class_id,
                'created_at', NOW()
            ),
            'system',
            'help_queue:' || help_queue_record.id,
            true
        );
    END LOOP;
END $$;

-- Pre-create global help_queues channel
DO $$
BEGIN
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'global_channel_created',
            'created_at', NOW()
        ),
        'system',
        'help_queues',
        true
    );
END $$;

-- Update the RLS policy for realtime messages to use the updated authorization function
DROP POLICY IF EXISTS "authenticated can read realtime messages" ON "realtime"."messages";
CREATE POLICY "authenticated can read realtime messages"
ON "realtime"."messages"
FOR SELECT
TO authenticated
USING (check_unified_realtime_authorization(realtime.topic()));

-- Add comments for documentation
COMMENT ON FUNCTION create_help_request_channels() IS 
'Pre-creates help request broadcast channels (main and staff) when a new help request is created';

COMMENT ON FUNCTION create_help_queue_channels() IS 
'Pre-creates help queue broadcast channels when a new help queue is created';

COMMENT ON FUNCTION broadcast_help_request_data_change() IS 
'Broadcasts changes to help request related tables (help_requests, help_request_messages, help_request_message_read_receipts, help_request_file_references, help_request_students) using help_request:$help_request_id channels';

COMMENT ON FUNCTION broadcast_help_request_staff_data_change() IS 
'Broadcasts changes to help request staff data (moderation and karma) using help_request:$help_request_id:staff channels. Students can see their own moderation data, staff can see all';

COMMENT ON FUNCTION broadcast_help_queue_data_change() IS 
'Broadcasts changes to help queue related tables (help_queues, help_queue_assignments, help_requests status) using help_queue:$help_queue_id and help_queues channels';

-- Usage Examples:
-- 
-- 1. Office Hours Channel Patterns:
--    Help Request Channels:
--    - Main: help_request:123 or help_request_123 (legacy)
--    - Staff: help_request:123:staff
--    
--    Help Queue Channels:
--    - Individual: help_queue:456
--    - Global: help_queues
--
-- 2. Message Payload Formats:
--    Help Request Changes:
--    {
--      "type": "table_change",
--      "operation": "INSERT|UPDATE|DELETE",
--      "table": "help_request_messages",
--      "row_id": 789,
--      "help_request_id": 123,
--      "class_id": 456,
--      "data": { ... },
--      "timestamp": "2025-01-15T..."
--    }
--    
--    Staff Data Changes:
--    {
--      "type": "staff_data_change", 
--      "operation": "INSERT|UPDATE|DELETE",
--      "table": "help_request_moderation",
--      "row_id": 789,
--      "help_request_id": 123,
--      "class_id": 456,
--      "student_profile_id": "uuid-here",
--      "data": { ... },
--      "timestamp": "2025-01-15T..."
--    }
--    
--    Help Queue Changes:
--    {
--      "type": "queue_change",
--      "operation": "INSERT|UPDATE|DELETE", 
--      "table": "help_requests",
--      "row_id": 789,
--      "help_queue_id": 456,
--      "class_id": 123,
--      "data": { ... },
--      "timestamp": "2025-01-15T..."
--    }
--
-- 3. Authorization:
--    - help_request:X channels: controlled by can_access_help_request(X)
--    - help_request:X:staff channels: staff OR students can see their own moderation data
--    - help_queue:X channels: controlled by class access authorization
--    - help_queues channel: all authenticated users (individual queue data filtered by RLS)
--
-- 4. Client Usage:
--    - Subscribe to help_request:123 for all help request updates
--    - Subscribe to help_request:123:staff for moderation/karma data (staff view)
--    - Subscribe to help_queue:456 for specific queue status changes
--    - Subscribe to help_queues for all queue status changes across all queues
--    - Filter messages by table name and relevant context IDs
--    - RLS policies automatically apply when fetching additional data 