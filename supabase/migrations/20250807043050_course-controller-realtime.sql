set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.broadcast_course_table_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    class_id_value bigint;
    row_id text;
    main_payload jsonb;
begin
    -- Get the class_id and row_id from the record
    if tg_op = 'insert' then
        class_id_value := new.class_id;
        row_id := new.id;
    elsif tg_op = 'update' then
        class_id_value := coalesce(new.class_id, old.class_id);
        row_id := coalesce(new.id, old.id);
    elsif tg_op = 'delete' then
        class_id_value := old.class_id;
        row_id := old.id;
    end if;

    -- Only broadcast if we have valid class_id
    if class_id_value is not null then
        -- Create payload with table-specific information
        main_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', tg_op,
            'table', tg_table_name,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', case 
                when tg_op = 'delete' then to_jsonb(old)
                else to_jsonb(new)
            end,
            'timestamp', now()
        );

        -- Broadcast to table-specific channel that TableController listens to
        perform realtime.send(
            main_payload,
            'broadcast',
            tg_table_name,
            true
        );
    end if;

    -- Return the appropriate record
    if tg_op = 'delete' then
        return old;
    else
        return new;
    end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_course_table_change_unified()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    class_id_value bigint;
    row_id text;
    staff_payload jsonb;
    user_payload jsonb;
    affected_profile_ids uuid[];
    profile_id uuid;
BEGIN
    -- Get the class_id and row_id from the record
    IF TG_OP = 'INSERT' THEN
        class_id_value := NEW.class_id;
        row_id := NEW.id;
    ELSIF TG_OP = 'UPDATE' THEN
        class_id_value := COALESCE(NEW.class_id, OLD.class_id);
        row_id := COALESCE(NEW.id, OLD.id);
    ELSIF TG_OP = 'DELETE' THEN
        class_id_value := OLD.class_id;
        row_id := OLD.id;
    END IF;

    -- Only broadcast if we have valid class_id
    IF class_id_value IS NOT NULL THEN
        -- Create payload with table-specific information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'target_audience', 'staff',
            'timestamp', NOW()
        );

        -- Broadcast to staff channel
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || class_id_value || ':staff',
            true
        );

        -- For non-sensitive tables, also broadcast to all student user channels
        -- (You may want to add logic here to filter sensitive data)
        
        -- Get all students in the class for user channels
        SELECT ARRAY(
            SELECT ur.private_profile_id
            FROM public.user_roles ur
            WHERE ur.class_id = class_id_value AND ur.role = 'student'
        ) INTO affected_profile_ids;

        -- Create user payload
        user_payload := staff_payload || jsonb_build_object('target_audience', 'user');

        -- Broadcast to all student user channels
        FOREACH profile_id IN ARRAY affected_profile_ids
        LOOP
            PERFORM realtime.send(
                user_payload,
                'broadcast',
                'class:' || class_id_value || ':user:' || profile_id,
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
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_discussion_thread_read_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    class_id_value bigint;
    row_id text;
    main_payload jsonb;
begin
    -- Get class_id from the discussion thread and row_id
    if tg_op = 'insert' then
        select dt.class_id into class_id_value
        from public.discussion_threads dt
        where dt.id = new.discussion_thread_id;
        row_id := new.id;
    elsif tg_op = 'update' then
        select dt.class_id into class_id_value
        from public.discussion_threads dt
        where dt.id = coalesce(new.discussion_thread_id, old.discussion_thread_id);
        row_id := coalesce(new.id, old.id);
    elsif tg_op = 'delete' then
        select dt.class_id into class_id_value
        from public.discussion_threads dt
        where dt.id = old.discussion_thread_id;
        row_id := old.id;
    end if;

    -- Only broadcast if we have valid class_id
    if class_id_value is not null then
        -- Create payload with table-specific information
        main_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', tg_op,
            'table', tg_table_name,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', case 
                when tg_op = 'delete' then to_jsonb(old)
                else to_jsonb(new)
            end,
            'timestamp', now()
        );

        -- Broadcast to table-specific channel that TableController listens to
        perform realtime.send(
            main_payload,
            'broadcast',
            tg_table_name,
            true
        );
    end if;

    -- Return the appropriate record
    if tg_op = 'delete' then
        return old;
    else
        return new;
    end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_discussion_thread_read_status_unified()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
    class_id_value bigint;
    row_id text;
    staff_payload jsonb;
    user_payload jsonb;
    affected_profile_ids uuid[];
    profile_id uuid;
BEGIN
    -- Get class_id from the discussion thread and row_id
    IF TG_OP = 'INSERT' THEN
        SELECT dt.class_id INTO class_id_value
        FROM public.discussion_threads dt
        WHERE dt.id = NEW.discussion_thread_id;
        row_id := NEW.id;
    ELSIF TG_OP = 'UPDATE' THEN
        SELECT dt.class_id INTO class_id_value
        FROM public.discussion_threads dt
        WHERE dt.id = COALESCE(NEW.discussion_thread_id, OLD.discussion_thread_id);
        row_id := COALESCE(NEW.id, OLD.id);
    ELSIF TG_OP = 'DELETE' THEN
        SELECT dt.class_id INTO class_id_value
        FROM public.discussion_threads dt
        WHERE dt.id = OLD.discussion_thread_id;
        row_id := OLD.id;
    END IF;

    -- Only broadcast if we have valid class_id
    IF class_id_value IS NOT NULL THEN
        -- Create payload with table-specific information
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', row_id,
            'class_id', class_id_value,
            'data', CASE 
                WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD)
                ELSE to_jsonb(NEW)
            END,
            'target_audience', 'staff',
            'timestamp', NOW()
        );

        -- Broadcast to staff channel
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || class_id_value || ':staff',
            true
        );

        -- Get all students in the class for user channels
        SELECT ARRAY(
            SELECT ur.private_profile_id
            FROM public.user_roles ur
            WHERE ur.class_id = class_id_value AND ur.role = 'student'
        ) INTO affected_profile_ids;

        -- Create user payload
        user_payload := staff_payload || jsonb_build_object('target_audience', 'user');

        -- Broadcast to all student user channels
        FOREACH profile_id IN ARRAY affected_profile_ids
        LOOP
            PERFORM realtime.send(
                user_payload,
                'broadcast',
                'class:' || class_id_value || ':user:' || profile_id,
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
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_discussion_threads_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    target_class_id bigint;
    staff_payload jsonb;
    user_payload jsonb;
    affected_profile_ids uuid[];
    profile_id uuid;
begin
    -- Get the class_id from the record
    if tg_op = 'insert' then
        target_class_id := new.class_id;
    elsif tg_op = 'update' then
        target_class_id := coalesce(new.class_id, old.class_id);
    elsif tg_op = 'delete' then
        target_class_id := old.class_id;
    end if;

    if target_class_id is not null then
        -- Create payload for discussion_threads changes
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', tg_op,
            'table', tg_table_name,
            'row_id', case
                when tg_op = 'delete' then old.id
                else new.id
            end,
            'data', case
                when tg_op = 'delete' then to_jsonb(old)
                else to_jsonb(new)
            end,
            'class_id', target_class_id,
            'target_audience', 'staff',
            'timestamp', now()
        );

        -- Broadcast to staff channel (instructors and graders see all discussion threads)
        perform realtime.send(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- Get all students in the class for user channels
        select array(
            select ur.private_profile_id
            from user_roles ur
            where ur.class_id = target_class_id and ur.role = 'student'
        ) into affected_profile_ids;

        -- Create user payload (same as staff but marked for users)
        user_payload := staff_payload || jsonb_build_object('target_audience', 'user');

        -- Broadcast to all student user channels (students see discussion threads)
        foreach profile_id in array affected_profile_ids
        loop
            perform realtime.send(
                user_payload,
                'broadcast',
                'class:' || target_class_id || ':user:' || profile_id,
                true
            );
        end loop;
    end if;

    -- Return the appropriate record
    if tg_op = 'delete' then
        return old;
    else
        return new;
    end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.check_unified_realtime_authorization(topic_text text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
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
begin
    -- Handle course data table channels (table-specific channels for course controller)
    -- These are simple table names that broadcast course data changes
    if topic_text in ('profiles', 'user_roles', 'discussion_thread_read_status', 'tags', 'lab_sections', 'lab_section_meetings') then
        -- Allow authenticated users to subscribe to course data table channels
        -- Client-side filtering by class_id in broadcast payload provides actual access control
        -- Combined with RLS policies on the underlying tables
        return auth.role() = 'authenticated';
    end if;

    -- Handle special case for help_queues (global channel)
    if topic_text = 'help_queues' then
        -- Allow authenticated users to subscribe to global help queues channel
        -- Individual queue access will be checked by RLS policies
        return auth.role() = 'authenticated';
    end if;
    
    -- Handle help_request_ channels (legacy format: help_request_123)
    if topic_text ~ '^help_request_[0-9]+$' then
        -- Extract help request ID from topic (format: help_request_123)
        help_request_id_text := substring(topic_text from '^help_request_([0-9]+)$');
        
        -- Convert to bigint
        begin
            help_request_id_bigint := help_request_id_text::bigint;
        exception when others then
            return false;
        end;
        
        -- Use existing help request access function
        return public.can_access_help_request(help_request_id_bigint);
    end if;

    -- Parse topic to get the first part
    topic_parts := string_to_array(topic_text, ':');
    
    if array_length(topic_parts, 1) < 1 then
        return false;
    end if;
    
    topic_type := topic_parts[1];
    
    -- Handle gradebook channels
    if topic_type = 'gradebook' then
        return public.check_gradebook_realtime_authorization(topic_text);
    end if;
    
    -- Handle help_request channels (format: help_request:123 or help_request:123:staff)
    if topic_type = 'help_request' then
        -- Must have at least 2 parts
        if array_length(topic_parts, 1) < 2 then
            return false;
        end if;
        
        help_request_id_text := topic_parts[2];
        
        -- Convert help_request_id to bigint
        begin
            help_request_id_bigint := help_request_id_text::bigint;
        exception when others then
            return false;
        end;
        
        -- Check if this is the staff channel
        if array_length(topic_parts, 1) = 3 and topic_parts[3] = 'staff' then
            -- Staff channel: check if user is staff or can access help request
            select hr.class_id into class_id_bigint
            from public.help_requests hr
            where hr.id = help_request_id_bigint;
            
            if class_id_bigint is null then
                return false;
            end if;
            
            -- Staff can see all moderation data, students can see their own
            return public.authorizeforclassgrader(class_id_bigint) 
                   or public.can_access_help_request(help_request_id_bigint);
        else
            -- Main help request channel
            return public.can_access_help_request(help_request_id_bigint);
        end if;
    end if;
    
    -- Handle help_queue channels (format: help_queue:123)
    if topic_type = 'help_queue' then
        -- Must have at least 2 parts
        if array_length(topic_parts, 1) < 2 then
            return false;
        end if;
        
        help_queue_id_text := topic_parts[2];
        
        -- Convert help_queue_id to bigint
        begin
            help_queue_id_bigint := help_queue_id_text::bigint;
        exception when others then
            return false;
        end;
        
        -- Check access to help queue by checking class access
        select hq.class_id into class_id_bigint
        from public.help_queues hq
        where hq.id = help_queue_id_bigint;
        
        if class_id_bigint is not null then
            return public.authorizeforclass(class_id_bigint);
        else
            return false;
        end if;
    end if;
    
    -- Fall back to original authorization logic for class and submission channels
    -- Must have at least 3 parts for these channel types
    if array_length(topic_parts, 1) < 3 then
        return false;
    end if;
    
    -- Handle class-level channels (for review_assignments, etc.)
    if topic_type = 'class' then
        class_id_text := topic_parts[2];
        channel_type := topic_parts[3];
        
        -- Convert class_id to bigint
        begin
            class_id_bigint := class_id_text::bigint;
        exception when others then
            return false;
        end;
        
        -- Handle staff channel
        if channel_type = 'staff' then
            return public.authorizeforclassgrader(class_id_bigint);
        
        -- Handle user channel
        elsif channel_type = 'user' then
            -- Must have 4 parts for user channel
            if array_length(topic_parts, 1) != 4 then
                return false;
            end if;
            
            profile_id_text := topic_parts[4];
            
            -- Convert profile_id to uuid
            begin
                profile_id_uuid := profile_id_text::uuid;
            exception when others then
                return false;
            end;
            
            -- Check if user is grader/instructor OR is the profile owner
            is_class_grader := public.authorizeforclassgrader(class_id_bigint);
            is_profile_owner := public.authorizeforprofile(profile_id_uuid);
            
            return is_class_grader or is_profile_owner;
        
        else
            return false;
        end if;
    
    -- Handle submission-level channels (for submission comments, etc.)
    elsif topic_type = 'submission' then
        submission_id_text := topic_parts[2];
        channel_type := topic_parts[3];
        
        -- Convert submission_id to bigint
        begin
            submission_id_bigint := submission_id_text::bigint;
        exception when others then
            return false;
        end;
        
        -- Handle graders channel
        if channel_type = 'graders' then
            -- Get class_id from submission to check grader authorization
            select s.class_id into class_id_bigint
            from public.submissions s
            where s.id = submission_id_bigint;
            
            if class_id_bigint is null then
                return false;
            end if;
            
            return public.authorizeforclassgrader(class_id_bigint);
        
        -- Handle profile_id channel
        elsif channel_type = 'profile_id' then
            -- Must have 4 parts for profile_id channel
            if array_length(topic_parts, 1) != 4 then
                return false;
            end if;
            
            profile_id_text := topic_parts[4];
            
            -- Convert profile_id to uuid
            begin
                profile_id_uuid := profile_id_text::uuid;
            exception when others then
                return false;
            end;
            
            -- Check if user has access to the submission OR is the profile owner
            is_submission_authorized := public.authorize_for_submission(submission_id_bigint);
            is_profile_owner := public.authorizeforprofile(profile_id_uuid);
            
            -- Also check if user is a grader for the class (for extra access)
            select s.class_id into class_id_bigint
            from public.submissions s
            where s.id = submission_id_bigint;
            
            if class_id_bigint is not null then
                is_class_grader := public.authorizeforclassgrader(class_id_bigint);
            else
                is_class_grader := false;
            end if;
            
            return is_class_grader or is_submission_authorized or is_profile_owner;
        
        else
            return false;
        end if;
    
    else
        return false;
    end if;
end;
$function$
;

CREATE TRIGGER broadcast_discussion_thread_read_status_realtime AFTER INSERT OR DELETE OR UPDATE ON public.discussion_thread_read_status FOR EACH ROW EXECUTE FUNCTION broadcast_discussion_thread_read_status_unified();

CREATE TRIGGER broadcast_discussion_threads_realtime AFTER INSERT OR DELETE OR UPDATE ON public.discussion_threads FOR EACH ROW EXECUTE FUNCTION broadcast_discussion_threads_change();

CREATE TRIGGER broadcast_lab_section_meetings_realtime AFTER INSERT OR DELETE OR UPDATE ON public.lab_section_meetings FOR EACH ROW EXECUTE FUNCTION broadcast_course_table_change_unified();

CREATE TRIGGER broadcast_lab_sections_realtime AFTER INSERT OR DELETE OR UPDATE ON public.lab_sections FOR EACH ROW EXECUTE FUNCTION broadcast_course_table_change_unified();

CREATE TRIGGER broadcast_profiles_realtime AFTER INSERT OR DELETE OR UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION broadcast_course_table_change_unified();

CREATE TRIGGER broadcast_tags_realtime AFTER INSERT OR DELETE OR UPDATE ON public.tags FOR EACH ROW EXECUTE FUNCTION broadcast_course_table_change_unified();

CREATE TRIGGER broadcast_user_roles_realtime AFTER INSERT OR DELETE OR UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION broadcast_course_table_change_unified();


