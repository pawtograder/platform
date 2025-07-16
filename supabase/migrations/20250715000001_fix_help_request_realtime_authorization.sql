-- Migration: Add help_request_ channel authorization to unified realtime system
-- Purpose: Fix issue where students can't connect to help request chat channels
-- because the authorization function doesn't recognize help_request_ channels

-- Update the unified realtime authorization function to handle help_request_ channels
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
    class_id_bigint bigint;
    submission_id_bigint bigint;
    profile_id_uuid uuid;
    help_request_id_bigint bigint;
    is_class_grader boolean;
    is_submission_authorized boolean;
    is_profile_owner boolean;
    channel_type text;
BEGIN
    -- Parse topic - can be class:123:staff, class:123:user:profile_uid, submission:123:graders, submission:123:profile_id:uuid, or help_request_123
    topic_parts := string_to_array(topic_text, ':');
    RAISE WARNING 'authorize: %', topic_text;
    RAISE WARNING 'topic_parts: %', topic_parts;
    
    -- Handle help_request_ channels (format: help_request_123)
    IF topic_text ~ '^help_request_[0-9]+$' THEN
        -- Extract help request ID from topic (format: help_request_123)
        help_request_id_text := substring(topic_text from '^help_request_([0-9]+)$');
        
        -- Convert to bigint
        BEGIN
            help_request_id_bigint := help_request_id_text::bigint;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'check_unified_realtime_authorization: failed to convert help_request_id: %', help_request_id_text;
            RETURN false;
        END;
        
        -- Use existing help request access function
        RETURN public.can_access_help_request(help_request_id_bigint);
    END IF;
    
    -- Must have at least 3 parts for other channel types
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
            FROM submissions s
            WHERE s.id = submission_id_bigint;
            
            IF class_id_bigint IS NOT NULL THEN
                RETURN authorizeforclassgrader(class_id_bigint);
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

-- Update the RLS policy to use the updated authorization function
DROP POLICY IF EXISTS "authenticated can read realtime messages" ON "realtime"."messages";
CREATE POLICY "authenticated can read realtime messages"
ON "realtime"."messages"
FOR SELECT
TO authenticated
USING (check_unified_realtime_authorization(realtime.topic()));

-- Add comment for documentation
COMMENT ON FUNCTION check_unified_realtime_authorization(text) IS 
'Authorizes access to unified broadcast channels. Supports class-level channels (class:$class_id:staff, class:$class_id:user:$profile_id), submission-specific channels (submission:$submission_id:graders, submission:$submission_id:profile_id:$profile_id), and help request channels (help_request_$help_request_id).'; 