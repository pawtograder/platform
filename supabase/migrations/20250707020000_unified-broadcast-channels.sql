-- Migration: Unified broadcast channels with multiplexed messages
-- This migration creates a unified channel system with only two patterns:
-- - class:$class_id:staff (for instructors/graders)
-- - class:$class_id:user:$profile_id (for individual users)

-- First, drop the old functions and triggers
DROP FUNCTION IF EXISTS broadcast_submission_comment_change() CASCADE;
DROP FUNCTION IF EXISTS broadcast_review_assignment_change() CASCADE;
DROP FUNCTION IF EXISTS broadcast_review_assignment_rubric_part_change() CASCADE;
DROP FUNCTION IF EXISTS check_realtime_authorization(text) CASCADE;

-- Create function to pre-create staff channel when course is inserted
CREATE OR REPLACE FUNCTION create_staff_channel()
RETURNS TRIGGER AS $$
BEGIN
    -- Pre-create the staff channel by sending an initial message
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'class_id', NEW.id,
            'created_at', NOW()
        ),
        'system',
        'class:' || NEW.id || ':staff',
        true
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to pre-create staff channel
CREATE OR REPLACE TRIGGER create_staff_channel_trigger
    AFTER INSERT ON "public"."classes"
    FOR EACH ROW
    EXECUTE FUNCTION create_staff_channel();

-- Create function to pre-create user channel when user_role is created
CREATE OR REPLACE FUNCTION create_user_channel()
RETURNS TRIGGER AS $$
BEGIN
    -- Pre-create the user channel by sending an initial message
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'class_id', NEW.class_id,
            'profile_id', NEW.private_profile_id,
            'created_at', NOW()
        ),
        'system',
        'class:' || NEW.class_id || ':user:' || NEW.private_profile_id,
        true
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to pre-create user channel
CREATE OR REPLACE TRIGGER create_user_channel_trigger
    AFTER INSERT ON "public"."user_roles"
    FOR EACH ROW
    EXECUTE FUNCTION create_user_channel();

-- Create function to pre-create submission channels when submission is created
CREATE OR REPLACE FUNCTION create_submission_channels()
RETURNS TRIGGER AS $$
DECLARE
    affected_profile_ids UUID[];
    profile_id UUID;
BEGIN
    -- Pre-create the graders channel for this submission
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'channel_created',
            'submission_id', NEW.id,
            'class_id', NEW.class_id,
            'created_at', NOW()
        ),
        'system',
        'submission:' || NEW.id || ':graders',
        true
    );

    -- Get affected profile IDs (submission author and group members)
    SELECT ARRAY(
        SELECT DISTINCT COALESCE(s.profile_id, agm.profile_id)
        FROM submissions s
        LEFT JOIN assignment_groups ag ON s.assignment_group_id = ag.id
        LEFT JOIN assignment_groups_members agm ON ag.id = agm.assignment_group_id
        WHERE s.id = NEW.id
    ) INTO affected_profile_ids;

    -- Pre-create user channels for affected users
    FOREACH profile_id IN ARRAY affected_profile_ids
    LOOP
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'submission_id', NEW.id,
                'class_id', NEW.class_id,
                'profile_id', profile_id,
                'created_at', NOW()
            ),
            'system',
            'submission:' || NEW.id || ':profile_id:' || profile_id,
            true
        );
    END LOOP;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to pre-create submission channels
CREATE OR REPLACE TRIGGER create_submission_channels_trigger
    AFTER INSERT ON "public"."submissions"
    FOR EACH ROW
    EXECUTE FUNCTION create_submission_channels();

-- Pre-create channels for all existing classes
DO $$
DECLARE
    class_record RECORD;
BEGIN
    FOR class_record IN SELECT id FROM "public"."classes"
    LOOP
        -- Pre-create the staff channel by sending an initial message
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'class_id', class_record.id,
                'created_at', NOW()
            ),
            'system',
            'class:' || class_record.id || ':staff',
            true
        );
    END LOOP;
END $$;

-- Pre-create channels for all existing user roles
DO $$
DECLARE
    user_role_record RECORD;
BEGIN
    FOR user_role_record IN SELECT class_id, private_profile_id FROM "public"."user_roles"
    LOOP
        -- Pre-create the user channel by sending an initial message
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'class_id', user_role_record.class_id,
                'profile_id', user_role_record.private_profile_id,
                'created_at', NOW()
            ),
            'system',
            'class:' || user_role_record.class_id || ':user:' || user_role_record.private_profile_id,
            true
        );
    END LOOP;
END $$;

-- Pre-create channels for all existing submissions
DO $$
DECLARE
    submission_record RECORD;
    affected_profile_ids UUID[];
    profile_id UUID;
BEGIN
    FOR submission_record IN SELECT id, class_id FROM "public"."submissions"
    LOOP
        -- Pre-create the graders channel for this submission
        PERFORM realtime.send(
            jsonb_build_object(
                'type', 'channel_created',
                'submission_id', submission_record.id,
                'class_id', submission_record.class_id,
                'created_at', NOW()
            ),
            'system',
            'submission:' || submission_record.id || ':graders',
            true
        );

        -- Get affected profile IDs (submission author and group members)
        SELECT ARRAY(
            SELECT DISTINCT COALESCE(s.profile_id, agm.profile_id)
            FROM submissions s
            LEFT JOIN assignment_groups ag ON s.assignment_group_id = ag.id
            LEFT JOIN assignment_groups_members agm ON ag.id = agm.assignment_group_id
            WHERE s.id = submission_record.id
        ) INTO affected_profile_ids;

        -- Pre-create user channels for affected users
        FOREACH profile_id IN ARRAY affected_profile_ids
        LOOP
            PERFORM realtime.send(
                jsonb_build_object(
                    'type', 'channel_created',
                    'submission_id', submission_record.id,
                    'class_id', submission_record.class_id,
                    'profile_id', profile_id,
                    'created_at', NOW()
                ),
                'system',
                'submission:' || submission_record.id || ':profile_id:' || profile_id,
                true
            );
        END LOOP;
    END LOOP;
END $$;

-- Create unified broadcast function for submission-related tables
CREATE OR REPLACE FUNCTION broadcast_submission_data_change()
RETURNS TRIGGER AS $$
DECLARE
    class_id BIGINT;
    submission_id BIGINT;
    comment_id BIGINT;
    grader_payload JSONB;
    user_payload JSONB;
    affected_profile_ids UUID[];
    profile_id UUID;
BEGIN
    -- Get the comment ID, submission_id, and class_id
    IF TG_OP = 'INSERT' THEN
        comment_id := NEW.id;
        submission_id := NEW.submission_id;
        class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        comment_id := NEW.id;
        submission_id := COALESCE(NEW.submission_id, OLD.submission_id);
        class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        comment_id := OLD.id;
        submission_id := OLD.submission_id;
        class_id := OLD.class_id;
    END IF;

    -- Only broadcast if there's a submission_id and class_id
    IF submission_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Create payload with submission-specific information
        grader_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', comment_id,
            'submission_id', submission_id,
            'class_id', class_id,
            'timestamp', NOW()
        );

        -- Broadcast to graders channel for this submission
        PERFORM realtime.send(
            grader_payload,
            'broadcast',
            'submission:' || submission_id || ':graders',
            true
        );

        -- Get affected profile IDs (submission author and group members)
        SELECT ARRAY(
            SELECT DISTINCT COALESCE(s.profile_id, agm.profile_id)
            FROM submissions s
            LEFT JOIN assignment_groups ag ON s.assignment_group_id = ag.id
            LEFT JOIN assignment_groups_members agm ON ag.id = agm.assignment_group_id
            WHERE s.id = submission_id
        ) INTO affected_profile_ids;

        -- Create user payload (same as grader payload but marked for users)
        user_payload := grader_payload || jsonb_build_object('target_audience', 'user');

        -- Broadcast to affected user channels for this specific submission
        FOREACH profile_id IN ARRAY affected_profile_ids
        LOOP
            PERFORM realtime.send(
                user_payload,
                'broadcast',
                'submission:' || submission_id || ':profile_id:' || profile_id,
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

-- Create triggers for submission-related tables
CREATE OR REPLACE TRIGGER broadcast_submission_file_comments_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."submission_file_comments"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_submission_data_change();

CREATE OR REPLACE TRIGGER broadcast_submission_comments_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."submission_comments"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_submission_data_change();

CREATE OR REPLACE TRIGGER broadcast_submission_artifact_comments_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."submission_artifact_comments"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_submission_data_change();

CREATE OR REPLACE TRIGGER broadcast_submission_reviews_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."submission_reviews"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_submission_data_change();

-- Create unified broadcast function for review assignments
CREATE OR REPLACE FUNCTION broadcast_review_assignment_data_change()
RETURNS TRIGGER AS $$
DECLARE
    class_id BIGINT;
    assignee_profile_id UUID;
    staff_payload JSONB;
    user_payload JSONB;
BEGIN
    -- Get the assignee_profile_id and class_id
    IF TG_OP = 'INSERT' THEN
        assignee_profile_id := NEW.assignee_profile_id;
        class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        assignee_profile_id := COALESCE(NEW.assignee_profile_id, OLD.assignee_profile_id);
        class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        assignee_profile_id := OLD.assignee_profile_id;
        class_id := OLD.class_id;
    END IF;

    IF class_id IS NOT NULL THEN
        -- Create payload with multiplexing information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', class_id,
            'timestamp', NOW()
        );

        -- Broadcast to staff channel
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || class_id || ':staff',
            true
        );

        -- Broadcast to assignee user channel if there's an assignee
        IF assignee_profile_id IS NOT NULL THEN
            user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
            PERFORM realtime.send(
                user_payload,
                'broadcast',
                'class:' || class_id || ':user:' || assignee_profile_id,
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

-- Create triggers for review assignment tables
CREATE OR REPLACE TRIGGER broadcast_review_assignments_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."review_assignments"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_review_assignment_data_change();

-- Create unified broadcast function for review assignment rubric parts
CREATE OR REPLACE FUNCTION broadcast_review_assignment_rubric_part_data_change()
RETURNS TRIGGER AS $$
DECLARE
    class_id BIGINT;
    assignee_profile_id UUID;
    staff_payload JSONB;
    user_payload JSONB;
BEGIN
    -- Get the assignee_profile_id and class_id from the review_assignment
    IF TG_OP = 'INSERT' THEN
        SELECT ra.assignee_profile_id, ra.class_id 
        INTO assignee_profile_id, class_id
        FROM "public"."review_assignments" ra
        WHERE ra.id = NEW.review_assignment_id;
    ELSIF TG_OP = 'UPDATE' THEN
        SELECT ra.assignee_profile_id, ra.class_id 
        INTO assignee_profile_id, class_id
        FROM "public"."review_assignments" ra
        WHERE ra.id = COALESCE(NEW.review_assignment_id, OLD.review_assignment_id);
    ELSIF TG_OP = 'DELETE' THEN
        SELECT ra.assignee_profile_id, ra.class_id 
        INTO assignee_profile_id, class_id
        FROM "public"."review_assignments" ra
        WHERE ra.id = OLD.review_assignment_id;
    END IF;

    IF class_id IS NOT NULL THEN
        -- Create payload with multiplexing information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'class_id', class_id,
            'timestamp', NOW()
        );

        -- Broadcast to staff channel
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || class_id || ':staff',
            true
        );

        -- Broadcast to assignee user channel if there's an assignee
        IF assignee_profile_id IS NOT NULL THEN
            user_payload := staff_payload || jsonb_build_object('target_audience', 'user');
            PERFORM realtime.send(
                user_payload,
                'broadcast',
                'class:' || class_id || ':user:' || assignee_profile_id,
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

-- Create trigger for review assignment rubric parts
CREATE OR REPLACE TRIGGER broadcast_review_assignment_rubric_parts_unified
    AFTER INSERT OR UPDATE OR DELETE ON "public"."review_assignment_rubric_parts"
    FOR EACH ROW
    EXECUTE FUNCTION broadcast_review_assignment_rubric_part_data_change();

-- Create unified RLS authorization function
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
    class_id_bigint bigint;
    submission_id_bigint bigint;
    profile_id_uuid uuid;
    is_class_grader boolean;
    is_submission_authorized boolean;
    is_profile_owner boolean;
    channel_type text;
BEGIN
    -- Parse topic - can be class:123:staff, class:123:user:profile_uid, submission:123:graders, or submission:123:profile_id:uuid
    topic_parts := string_to_array(topic_text, ':');
    RAISE WARNING 'authorize: %', topic_text;
    RAISE WARNING 'topic_parts: %', topic_parts;
    -- Must have at least 3 parts
    IF array_length(topic_parts, 1) < 3 THEN
        RETURN false;
    END IF;
    
    topic_type := topic_parts[1];
    
    -- Handle class-level channels (for review_assignments, etc.)
    IF topic_type = 'class' THEN
        class_id_text := topic_parts[2];
        channel_type := topic_parts[3];

        RAISE WARNING 'class_id_text: %', class_id_text;
        RAISE WARNING 'channel_type: %', channel_type;

        
        -- Convert class_id to bigint
        BEGIN
            class_id_bigint := class_id_text::bigint;
        EXCEPTION WHEN OTHERS THEN
            RETURN false;
        END;
        
        -- Handle staff channel
        IF channel_type = 'staff' THEN
            RETURN authorizeforclassgrader(class_id_bigint);
        
        -- Handle user channel
        ELSIF channel_type = 'user' THEN
            -- Must have 4 parts for user channel
            IF array_length(topic_parts, 1) != 4 THEN
                RETURN false;
            END IF;
            
            profile_id_text := topic_parts[4];
            RAISE WARNING 'profile_id_text: %', profile_id_text;

            -- Convert profile_id to uuid
            BEGIN
                profile_id_uuid := profile_id_text::uuid;
            EXCEPTION WHEN OTHERS THEN
                RETURN false;
            END;
            
            -- Check if user is grader/instructor OR is the profile owner
            is_class_grader := authorizeforclassgrader(class_id_bigint);
            is_profile_owner := authorizeforprofile(profile_id_uuid);
            
            RETURN is_class_grader OR is_profile_owner;
        
        ELSE
            RETURN false;
        END IF;
    
    -- Handle submission-level channels (for submission comments, etc.)
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
            -- Get class_id from submission to check grader authorization
            SELECT s.class_id INTO class_id_bigint
            FROM submissions s
            WHERE s.id = submission_id_bigint;
            
            IF class_id_bigint IS NULL THEN
                RETURN false;
            END IF;
            
            RETURN authorizeforclassgrader(class_id_bigint);
        
        -- Handle profile_id channel
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
            is_submission_authorized := authorize_for_submission(submission_id_bigint);
            is_profile_owner := authorizeforprofile(profile_id_uuid);
            
            -- Also check if user is a grader for the class (for extra access)
            SELECT s.class_id INTO class_id_bigint
            FROM submissions s
            WHERE s.id = submission_id_bigint;
            
            IF class_id_bigint IS NOT NULL THEN
                is_class_grader := authorizeforclassgrader(class_id_bigint);
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

-- Update RLS policy for realtime messages
DROP POLICY IF EXISTS "authenticated can read realtime messages" ON "realtime"."messages";
CREATE POLICY "authenticated can read realtime messages"
ON "realtime"."messages"
FOR SELECT
TO authenticated
USING (check_unified_realtime_authorization(realtime.topic()));

-- Add comments for documentation
COMMENT ON FUNCTION create_staff_channel() IS 
'Pre-creates staff broadcast channel when a new course is created';

COMMENT ON FUNCTION create_user_channel() IS 
'Pre-creates user broadcast channel when a new user role is created';

COMMENT ON FUNCTION create_submission_channels() IS 
'Pre-creates submission broadcast channels (both graders and user channels) when a new submission is created';

COMMENT ON FUNCTION broadcast_submission_data_change() IS 
'Broadcasts changes to submission-related tables using submission-specific channels. Messages are sent to submission:$submission_id:graders channel and submission:$submission_id:profile_id:$profile_id channels for affected users.';

COMMENT ON FUNCTION broadcast_review_assignment_data_change() IS 
'Broadcasts changes to review_assignments table using unified channel system. Messages are sent to both staff channel and assignee user channel.';

COMMENT ON FUNCTION broadcast_review_assignment_rubric_part_data_change() IS 
'Broadcasts changes to review_assignment_rubric_parts table using unified channel system. Messages are sent to both staff channel and assignee user channel.';

COMMENT ON FUNCTION check_unified_realtime_authorization(text) IS 
'Authorizes access to unified broadcast channels. Supports both class-level channels (class:$class_id:staff, class:$class_id:user:$profile_id) and submission-specific channels (submission:$submission_id:graders, submission:$submission_id:profile_id:$profile_id).';

-- Usage Examples:
-- 
-- 1. Channel patterns:
--    Class-level (for review_assignments, etc.):
--    - Staff: class:123:staff
--    - User: class:123:user:uuid-here
--    
--    Submission-specific (for submission comments, reviews):
--    - Graders: submission:456:graders
--    - User: submission:456:profile_id:uuid-here
--
-- 2. Message payload format:
--    {
--      "type": "table_change",
--      "operation": "INSERT|UPDATE|DELETE",
--      "table": "submission_comments",
--      "row_id": 456,              // For ID-only broadcasts
--      "data": { ... },            // For full data broadcasts
--      "submission_id": 789,       // Context information (for submission channels)
--      "class_id": 123,            // Context information
--      "target_audience": "user",  // Optional, only present in user channels
--      "timestamp": "2025-01-07T..."
--    }
--
-- 3. Client-side handling:
--    - Subscribe to appropriate channels based on user role and context
--    - Submission-related data uses submission-specific channels
--    - Class and assignment-level data (like review_assignments) uses class-level channels
--    - Filter messages by table name and context (e.g., submission_id)
--    - Handle both ID-only and full data broadcasts
--    - RLS policies automatically apply when fetching additional data 