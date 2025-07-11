-- Migration: Set up broadcast functions and triggers for submission comment tables
-- This migration creates shared functions and triggers to broadcast changes to
-- submission_file_comments, submission_comments, and submission_artifact_comments tables
-- to the channel "tablename:class_id:$CLASS_ID$:submission_id:$SUBMISSION_ID$"


-- Remove the tables from realtime publications since we're using custom broadcast channels
ALTER PUBLICATION "supabase_realtime" DROP TABLE "public"."submission_file_comments";
ALTER PUBLICATION "supabase_realtime" DROP TABLE "public"."submission_comments";
ALTER PUBLICATION "supabase_realtime" DROP TABLE "public"."submission_artifact_comments";
ALTER PUBLICATION "supabase_realtime" DROP TABLE "public"."submission_reviews";
ALTER PUBLICATION "supabase_realtime" DROP TABLE "public"."review_assignments";


-- Create a shared function to broadcast changes to submission comment tables
CREATE OR REPLACE FUNCTION broadcast_submission_comment_change()
RETURNS TRIGGER AS $$
DECLARE
    channel_name TEXT;
    submission_id BIGINT;
    comment_id BIGINT;
    class_id BIGINT;
BEGIN
    -- Get the comment ID, submission_id, and class_id
    IF TG_OP = 'INSERT' THEN
        comment_id := NEW.id;
        submission_id := NEW.submission_id;
        class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        comment_id := NEW.id;
        submission_id := OLD.submission_id;
        class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        comment_id := OLD.id;
        submission_id := OLD.submission_id;
        class_id := OLD.class_id;
    END IF;

    -- Only broadcast if there's a submission_id and class_id
    IF submission_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Construct the channel name based on table name, class_id, and submission_id
        channel_name := TG_TABLE_NAME || ':class_id:' || class_id || ':submission_id:' || submission_id;

        -- Broadcast just the operation and ID - clients will fetch the data themselves
        PERFORM realtime.send(
            jsonb_build_object(
                'operation', TG_OP,
                'table', TG_TABLE_NAME,
                'row_id', comment_id
            ),
            'data-change-by-id',
            channel_name,
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

-- Create triggers for submission_file_comments table
CREATE OR REPLACE TRIGGER broadcast_submission_file_comments_changes
    AFTER INSERT OR UPDATE OR DELETE ON "public"."submission_file_comments"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."broadcast_submission_comment_change"();

-- Create triggers for submission_comments table
CREATE OR REPLACE TRIGGER broadcast_submission_comments_changes
    AFTER INSERT OR UPDATE OR DELETE ON "public"."submission_comments"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."broadcast_submission_comment_change"();



-- Create triggers for submission_artifact_comments table
CREATE OR REPLACE  TRIGGER broadcast_submission_artifact_comments_changes
    AFTER INSERT OR UPDATE OR DELETE ON "public"."submission_artifact_comments"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."broadcast_submission_comment_change"();

-- Create trigger for submission_reviews table
CREATE OR REPLACE TRIGGER broadcast_submission_reviews_changes
    AFTER INSERT OR UPDATE OR DELETE ON "public"."submission_reviews"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."broadcast_submission_comment_change"();

-- Create a function to broadcast review_assignments changes to user-specific channels
CREATE OR REPLACE FUNCTION "public"."broadcast_review_assignment_change"()
RETURNS TRIGGER AS $$
DECLARE
    channel_name TEXT;
    assignee_profile_id UUID;
    class_id BIGINT;
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
        PERFORM realtime.send(
        jsonb_build_object(
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END
        ),
        'data-change',
        'review_assignments:class_id:' || class_id,
        true
    );
    END IF;
    -- Only broadcast if there's an assignee_profile_id and class_id
    IF assignee_profile_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Construct the channel name: course_data:class_id:123:user_id:uuid
        channel_name := 'review_assignments:class_id:' || class_id || ':profile_id:' || assignee_profile_id;

        -- Broadcast the full JSON object
         PERFORM realtime.send(
            jsonb_build_object(
                'operation', TG_OP,
                'table', TG_TABLE_NAME,
                'data', CASE 
                    WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                    ELSE to_jsonb(NEW)
                END
            ),
            'data-change',
            channel_name,
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

-- Create trigger for review_assignments table
CREATE OR REPLACE TRIGGER broadcast_review_assignments_changes
    AFTER INSERT OR UPDATE OR DELETE ON "public"."review_assignments"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."broadcast_review_assignment_change"();

-- Create a function to broadcast review_assignment_rubric_parts changes to user-specific channels
CREATE OR REPLACE FUNCTION "public"."broadcast_review_assignment_rubric_part_change"()
RETURNS TRIGGER AS $$
DECLARE
    channel_name TEXT;
    assignee_profile_id UUID;
    class_id BIGINT;
BEGIN
    -- Get the assignee_profile_id and class_id from the review_assignment
    IF TG_OP = 'INSERT' THEN
        -- Join with review_assignments to get the assignee_profile_id and class_id
        SELECT ra.assignee_profile_id, ra.class_id 
        INTO assignee_profile_id, class_id
        FROM "public"."review_assignments" ra
        WHERE ra.id = NEW.review_assignment_id;
    ELSIF TG_OP = 'UPDATE' THEN
        -- Join with review_assignments to get the assignee_profile_id and class_id
        SELECT ra.assignee_profile_id, ra.class_id 
        INTO assignee_profile_id, class_id
        FROM "public"."review_assignments" ra
        WHERE ra.id = COALESCE(NEW.review_assignment_id, OLD.review_assignment_id);
    ELSIF TG_OP = 'DELETE' THEN
        -- Join with review_assignments to get the assignee_profile_id and class_id
        SELECT ra.assignee_profile_id, ra.class_id 
        INTO assignee_profile_id, class_id
        FROM "public"."review_assignments" ra
        WHERE ra.id = OLD.review_assignment_id;
    END IF;

    -- Only broadcast if there's an assignee_profile_id and class_id
    IF assignee_profile_id IS NOT NULL AND class_id IS NOT NULL THEN
        -- Construct the channel name: review_assignment_rubric_parts:class_id:123:profile_id:uuid
        channel_name := 'review_assignment_rubric_parts:class_id:' || class_id || ':profile_id:' || assignee_profile_id;

        -- Broadcast the full JSON object
        PERFORM realtime.send(
            jsonb_build_object(
                'operation', TG_OP,
                'table', TG_TABLE_NAME,
                'data', CASE 
                    WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                    ELSE to_jsonb(NEW)
                END
            ),
            'data-change',
            channel_name,
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

-- Create trigger for review_assignment_rubric_parts table
CREATE OR REPLACE TRIGGER broadcast_review_assignment_rubric_parts_changes
    AFTER INSERT OR UPDATE OR DELETE ON "public"."review_assignment_rubric_parts"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."broadcast_review_assignment_rubric_part_change"();

-- Add comments for documentation
COMMENT ON FUNCTION broadcast_submission_comment_change() IS 
'Broadcasts changes to submission comment tables (submission_file_comments, submission_comments, submission_artifact_comments) to the channel "tablename:class_id:$CLASS_ID$:submission_id:$SUBMISSION_ID$". Only broadcasts the operation type, table name, and row_id. Clients should fetch the actual data themselves to ensure RLS policies are applied. Only broadcasts when submission_id and class_id are not null.';



COMMENT ON TRIGGER broadcast_submission_file_comments_changes ON "public"."submission_file_comments" IS 
'Broadcasts changes to submission_file_comments table to the channel "submission_file_comments:class_id:$CLASS_ID$:submission_id:$SUBMISSION_ID$"';

COMMENT ON TRIGGER broadcast_submission_comments_changes ON "public"."submission_comments" IS 
'Broadcasts changes to submission_comments table to the channel "submission_comments:class_id:$CLASS_ID$:submission_id:$SUBMISSION_ID$"';

COMMENT ON TRIGGER broadcast_submission_artifact_comments_changes ON "public"."submission_artifact_comments" IS 
'Broadcasts changes to submission_artifact_comments table to the channel "submission_artifact_comments:class_id:$CLASS_ID$:submission_id:$SUBMISSION_ID$"';

COMMENT ON TRIGGER broadcast_submission_reviews_changes ON "public"."submission_reviews" IS 
'Broadcasts changes to submission_reviews table to the channel "submission_reviews:class_id:$CLASS_ID$:submission_id:$SUBMISSION_ID$"';

COMMENT ON FUNCTION broadcast_review_assignment_change() IS 
'Broadcasts changes to review_assignments table to user-specific channels "course_data:class_id:$CLASS_ID$:user_id:$USER_ID$". Broadcasts the full JSON object for INSERT/UPDATE operations and the deleted object for DELETE operations. Only broadcasts when assignee_profile_id and class_id are not null.';

COMMENT ON TRIGGER broadcast_review_assignments_changes ON "public"."review_assignments" IS 
'Broadcasts changes to review_assignments table to the channel "course_data:class_id:$CLASS_ID$:user_id:$USER_ID$"';

COMMENT ON FUNCTION broadcast_review_assignment_rubric_part_change() IS 
'Broadcasts changes to review_assignment_rubric_parts table to user-specific channels "review_assignment_rubric_parts:class_id:$CLASS_ID$:profile_id:$PROFILE_ID$". Broadcasts the full JSON object for INSERT/UPDATE operations and the deleted object for DELETE operations. Gets assignee_profile_id and class_id by joining with review_assignments table.';

COMMENT ON TRIGGER broadcast_review_assignment_rubric_parts_changes ON "public"."review_assignment_rubric_parts" IS 
'Broadcasts changes to review_assignment_rubric_parts table to the channel "review_assignment_rubric_parts:class_id:$CLASS_ID$:profile_id:$PROFILE_ID$"';

-- Set up RLS policies for realtime messages to control access to broadcast channels
-- Enable RLS on the realtime.messages table
ALTER TABLE "realtime"."messages" ENABLE ROW LEVEL SECURITY;

-- Create comprehensive function to handle all realtime authorization with debugging
CREATE OR REPLACE FUNCTION check_realtime_authorization(topic_text text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    topic_parts text[];
    channel_type text;
    class_id_part text;
    submission_id_part text;
    profile_id_part text;
    class_id_bigint bigint;
    submission_id_bigint bigint;
    profile_id_uuid uuid;
    is_class_grader boolean;
    is_submission_authorized boolean;
    is_profile_owner boolean;
    result boolean;
BEGIN
    RAISE NOTICE 'check_realtime_authorization: topic = %', topic_text;
    
    -- Split topic into parts
    topic_parts := string_to_array(topic_text, ':');
    channel_type := topic_parts[1];
    
    RAISE NOTICE 'check_realtime_authorization: channel_type = %', channel_type;
    
    -- Handle different channel types
    CASE channel_type
        WHEN 'review_assignments' THEN
            -- Format: review_assignments:class_id:123:profile_id:uuid
            IF array_length(topic_parts, 1) < 5 THEN
                RAISE NOTICE 'check_realtime_authorization: review_assignments topic has insufficient parts';
                RETURN false;
            END IF;
            
            class_id_part := topic_parts[3];
            profile_id_part := topic_parts[5];
            
            RAISE NOTICE 'check_realtime_authorization: class_id_part = %, profile_id_part = %', class_id_part, profile_id_part;
            
            -- Convert to proper types
            BEGIN
                class_id_bigint := class_id_part::bigint;
                profile_id_uuid := profile_id_part::uuid;
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE 'check_realtime_authorization: failed to convert review_assignments types: %', SQLERRM;
                RETURN false;
            END;
            
            -- Check authorization
            is_class_grader := authorizeforclassgrader(class_id_bigint);
            is_profile_owner := authorizeforprofile(profile_id_uuid);
            
            RAISE NOTICE 'check_realtime_authorization: review_assignments - is_class_grader = %, is_profile_owner = %', is_class_grader, is_profile_owner;
            
            result := is_class_grader OR is_profile_owner;
            
        WHEN 'review_assignment_rubric_parts' THEN
            -- Format: review_assignment_rubric_parts:class_id:123:profile_id:uuid
            IF array_length(topic_parts, 1) < 5 THEN
                RAISE NOTICE 'check_realtime_authorization: review_assignment_rubric_parts topic has insufficient parts';
                RETURN false;
            END IF;
            
            class_id_part := topic_parts[3];
            profile_id_part := topic_parts[5];
            
            RAISE NOTICE 'check_realtime_authorization: class_id_part = %, profile_id_part = %', class_id_part, profile_id_part;
            
            -- Convert to proper types
            BEGIN
                class_id_bigint := class_id_part::bigint;
                profile_id_uuid := profile_id_part::uuid;
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE 'check_realtime_authorization: failed to convert review_assignment_rubric_parts types: %', SQLERRM;
                RETURN false;
            END;
            
            -- Check authorization
            is_class_grader := authorizeforclassgrader(class_id_bigint);
            is_profile_owner := authorizeforprofile(profile_id_uuid);
            
            RAISE NOTICE 'check_realtime_authorization: review_assignment_rubric_parts - is_class_grader = %, is_profile_owner = %', is_class_grader, is_profile_owner;
            
            result := is_class_grader OR is_profile_owner;
            
        WHEN 'submission_file_comments', 'submission_comments', 'submission_artifact_comments', 'submission_reviews' THEN
            -- Format: channel_type:class_id:123:submission_id:456
            IF array_length(topic_parts, 1) < 5 THEN
                RAISE NOTICE 'check_realtime_authorization: % topic has insufficient parts', channel_type;
                RETURN false;
            END IF;
            
            class_id_part := topic_parts[3];
            submission_id_part := topic_parts[5];
            
            RAISE NOTICE 'check_realtime_authorization: class_id_part = %, submission_id_part = %', class_id_part, submission_id_part;
            
            -- Convert to proper types
            BEGIN
                class_id_bigint := class_id_part::bigint;
                submission_id_bigint := submission_id_part::bigint;
            EXCEPTION WHEN OTHERS THEN
                RAISE NOTICE 'check_realtime_authorization: failed to convert % types: %', channel_type, SQLERRM;
                RETURN false;
            END;
            
            -- Check authorization
            is_class_grader := authorizeforclassgrader(class_id_bigint);
            is_submission_authorized := authorize_for_submission(submission_id_bigint);
            
            RAISE NOTICE 'check_realtime_authorization: % - is_class_grader = %, is_submission_authorized = %', channel_type, is_class_grader, is_submission_authorized;
            
            result := is_class_grader OR is_submission_authorized;
            
        ELSE
            RAISE NOTICE 'check_realtime_authorization: unknown channel type = %', channel_type;
            RETURN false;
    END CASE;
    
    RAISE NOTICE 'check_realtime_authorization for topic % final result = %', topic_text, result;
    RETURN result;
END;
$$;

DROP POLICY IF EXISTS "authenticated can read realtime messages" ON "realtime"."messages";
-- Create single comprehensive policy using the unified function
CREATE POLICY "authenticated can read realtime messages"
ON "realtime"."messages"
FOR SELECT
TO authenticated
USING (check_realtime_authorization(realtime.topic()));

-- Usage Examples:
-- 
-- 1. RLS policies automatically control access to broadcast channels
--
-- 2. Channel naming convention:
--    - submission_file_comments:class_id:456:submission_id:123
--    - submission_comments:class_id:456:submission_id:123
--    - submission_artifact_comments:class_id:456:submission_id:123
--    - submission_reviews:class_id:456:submission_id:123
--    - review_assignments:class_id:456:profile_id:uuid
--    - review_assignment_rubric_parts:class_id:456:profile_id:uuid
--
-- 3. Broadcast payload format:
--    For comment tables (ID only):
--    {
--      "operation": "INSERT|UPDATE|DELETE",
--      "table": "submission_comments",
--      "row_id": 456
--    }
--    
--    For review_assignments (full JSON):
--    {
--      "operation": "INSERT|UPDATE|DELETE",
--      "table": "review_assignments",
--      "data": { full JSON object }
--    }
--    
--    For review_assignment_rubric_parts (full JSON):
--    {
--      "operation": "INSERT|UPDATE|DELETE",
--      "table": "review_assignment_rubric_parts",
--      "data": { full JSON object }
--    }
--
-- 4. Client-side handling:
--    - RLS policies automatically control access to broadcast channels
--    - For comment tables: When receiving a broadcast, fetch the comment data using the row_id
--    - For review_assignments: The full JSON object is included in the broadcast
--    - For review_assignment_rubric_parts: The full JSON object is included in the broadcast
--    - RLS policies will automatically apply when fetching the data
--    - If the user doesn't have access, the fetch will fail gracefully
--
-- 5. RLS Policy Behavior:
--    - For comment tables: Users can only subscribe to channels for submissions they have access to
--    - For review_assignments: Users can only subscribe to channels for their own assignments or if they're a grader/instructor
--    - For review_assignment_rubric_parts: Users can only subscribe to channels for their own assignments or if they're a grader/instructor
--    - First checks if user is a grader/instructor for the class (authorizeforclassgrader)
--    - Then checks if user has access to the submission (authorize_for_submission) or is the assignee (auth.uid())
--    - No additional client-side authorization checks needed
