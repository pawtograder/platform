alter table "public"."student_karma_notes" alter column "updated_at" set default now();

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.check_unified_realtime_authorization(topic_text text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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

    -- Parse topic to get the first part
    topic_parts := string_to_array(topic_text, ':');
    
    IF array_length(topic_parts, 1) < 1 THEN
        RETURN false;
    END IF;
    
    topic_type := topic_parts[1];
    
    -- Handle gradebook channels
    IF topic_type = 'gradebook' THEN
        RETURN public.check_gradebook_realtime_authorization(topic_text);
    END IF;
    
    -- Handle help_request channels (format: help_request:123 or help_request:123:staff)
    IF topic_type = 'help_request' THEN
        -- Must have at least 2 parts
        IF array_length(topic_parts, 1) < 2 THEN
            RETURN false;
        END IF;
        
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
    END IF;
    
    -- Handle help_queue channels (format: help_queue:123)
    IF topic_type = 'help_queue' THEN
        -- Must have at least 2 parts
        IF array_length(topic_parts, 1) < 2 THEN
            RETURN false;
        END IF;
        
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
    END IF;
    
    -- Fall back to original authorization logic for class and submission channels
    -- Must have at least 3 parts for these channel types
    IF array_length(topic_parts, 1) < 3 THEN
        RETURN false;
    END IF;
    
    -- Handle class-level channels (for review_assignments, etc.)
    IF topic_type = 'class' THEN
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
            FROM public.submissions s
            WHERE s.id = submission_id_bigint;
            
            IF class_id_bigint IS NULL THEN
                RETURN false;
            END IF;
            
            RETURN public.authorizeforclassgrader(class_id_bigint);
        
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
$function$
;


