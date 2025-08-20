drop policy "Users can manage their own preferences" on "public"."notification_preferences";

revoke delete on table "public"."notification_preferences" from "anon";

revoke insert on table "public"."notification_preferences" from "anon";

revoke references on table "public"."notification_preferences" from "anon";

revoke select on table "public"."notification_preferences" from "anon";

revoke trigger on table "public"."notification_preferences" from "anon";

revoke truncate on table "public"."notification_preferences" from "anon";

revoke update on table "public"."notification_preferences" from "anon";

revoke delete on table "public"."notification_preferences" from "authenticated";

revoke insert on table "public"."notification_preferences" from "authenticated";

revoke references on table "public"."notification_preferences" from "authenticated";

revoke select on table "public"."notification_preferences" from "authenticated";

revoke trigger on table "public"."notification_preferences" from "authenticated";

revoke truncate on table "public"."notification_preferences" from "authenticated";

revoke update on table "public"."notification_preferences" from "authenticated";

revoke delete on table "public"."notification_preferences" from "service_role";

revoke insert on table "public"."notification_preferences" from "service_role";

revoke references on table "public"."notification_preferences" from "service_role";

revoke select on table "public"."notification_preferences" from "service_role";

revoke trigger on table "public"."notification_preferences" from "service_role";

revoke truncate on table "public"."notification_preferences" from "service_role";

revoke update on table "public"."notification_preferences" from "service_role";

alter table "public"."notification_preferences" drop constraint "notification_preferences_class_id_fkey";

alter table "public"."notification_preferences" drop constraint "notification_preferences_user_id_fkey";

drop function if exists "public"."is_instructor_for_class"(_person_id uuid, _class_id integer);

alter table "public"."notification_preferences" drop constraint "notification_preferences_pkey";

drop index if exists "public"."notification_preferences_pkey";

drop table "public"."notification_preferences";

drop type "public"."email_digest_frequency";

drop type "public"."notification_type";

CREATE INDEX idx_rubric_checks_criteria_ordinal ON public.rubric_checks USING btree (rubric_criteria_id, ordinal);

CREATE INDEX idx_rubric_criteria_part_ordinal ON public.rubric_criteria USING btree (rubric_part_id, ordinal);

CREATE INDEX idx_rubric_parts_rubric_ordinal ON public.rubric_parts USING btree (rubric_id, ordinal);

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_all_repos_for_assignment(course_id integer, assignment_id integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Check if parameters are NULL
  IF course_id IS NULL OR assignment_id IS NULL THEN
    RAISE WARNING 'create_all_repos_for_assignment called with NULL parameters, skipping';
    RETURN;
  END IF;

  RAISE NOTICE 'Creating all repos for assignment with course_id: %, assignment_id: %', course_id, assignment_id;
  
  PERFORM public.call_edge_function_internal(
    '/functions/v1/assignment-create-all-repos', 
    'POST', 
    '{"Content-type":"application/json","x-supabase-webhook-source":"assignment-create-all-repos"}'::jsonb, 
    jsonb_build_object('courseId', course_id, 'assignmentId', assignment_id), 
    10000, -- Longer timeout since this creates multiple repos
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

END;
$function$
;

CREATE OR REPLACE FUNCTION public.recalculate_gradebook_columns_in_range(start_id bigint, end_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    messages jsonb[];
    column_record RECORD;
BEGIN
    -- Build messages for all gradebook columns in the specified range
    SELECT  array_agg(
            jsonb_build_object(
                'gradebook_column_id', gcs.gradebook_column_id,
                'student_id', gcs.student_id,
                'is_private', gcs.is_private,
                'gradebook_column_student_id', gcs.id,
                'reason', 'score_expression_change',
                'trigger_id', gcs.gradebook_column_id
            )
        )
        INTO messages
        FROM gradebook_column_students gcs
        WHERE gcs.gradebook_column_id >= start_id AND gcs.gradebook_column_id <= end_id;

    -- Send messages using the existing helper function
    IF messages IS NOT NULL THEN
        PERFORM public.send_gradebook_recalculation_messages(messages);
        
        -- Log the operation
        RAISE NOTICE 'Triggered recalculation for % gradebook columns in range % to %', 
            array_length(messages, 1), start_id, end_id;
    ELSE
        RAISE NOTICE 'No gradebook columns found in range % to %', start_id, end_id;
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.assignment_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
   CASE TG_OP
   WHEN 'UPDATE' THEN
      IF OLD.template_repo is not null and OLD.template_repo != NEW.template_repo then
         UPDATE autograder_regression_test SET repository = NEW.template_repo WHERE repository = OLD.template_repo AND autograder_id = NEW.id;
      elseif OLD.template_repo is null AND NEW.template_repo is not null then
         INSERT INTO autograder_regression_test (repository, autograder_id) VALUES (NEW.template_repo, NEW.id);
      elseif OLD.template_repo is not null and NEW.template_repo is null then
         DELETE FROM autograder_regression_test WHERE repository = NEW.template_repo and autograder_id = NEW.id;
      end if;
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$function$
;

CREATE OR REPLACE FUNCTION public.authorizeforinstructorofstudent(_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  bind_permissions int;
  jwtRoles public.user_roles;
begin

  -- Fetch user role once and store it to reduce number of calls
  select count(*)
  into bind_permissions
  from public.user_roles as ourRole
  inner join public.user_roles as studentRole on ourRole.class_id=studentRole.class_id and studentRole.user_id=_user_id
  where ourRole.user_id=auth.uid() and ourRole.role='instructor';

  return bind_permissions > 0;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.authorizeforpoll(poll__id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  poll record;
  roles record;
  jwtRoles public.user_roles;
  release__date timestamp;
begin
  select released_at, class_id into poll FROM public.polls where id=poll__id;

    SELECT COUNT(CASE WHEN role = 'student' THEN 1 END) as is_student, COUNT(CASE WHEN role = 'instructor' THEN 1 END) as is_instructor
    INTO roles
    FROM 
      public.user_roles
    WHERE 
      user_id = auth.uid() AND class_id = poll.class_id;

  if roles.is_instructor then
    return true;
  end if;

  if roles.is_student then
    return poll.released_at is null or poll.released_at <= NOW();
  end if;

  return false;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.authorizeforpoll(poll__id bigint, class__id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  roles record;
  jwtRoles public.user_roles;
  release__date timestamp;
begin

    SELECT COUNT(CASE WHEN role = 'student' THEN 1 END) as is_student, COUNT(CASE WHEN role = 'instructor' THEN 1 END) as is_instructor
    INTO roles
    FROM 
      user_roles
    WHERE 
      user_id = auth.uid() AND class_id = class__id;

  if is_instructor then
    return true;
  end if;

  if is_student then
    select release_date into release__date from polls where id=poll__id;
    return release__date is null or release__date <= NOW();
  end if;

  return false;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.authorizeforprofile(profile_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  bind_permissions int;
  jwtRoles public.user_roles;
begin

  -- Fetch user role once and store it to reduce number of calls
  select count(*)
  into bind_permissions
  from public.user_roles as r
  where (r.public_profile_id=profile_id OR r.private_profile_id=profile_id) and user_id=auth.uid();

  return bind_permissions > 0;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_help_queue_data_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_help_request_data_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
            -- For read receipts, use direct help_request_id if available, otherwise lookup via message_id
            IF TG_OP = 'INSERT' THEN
                help_request_id := COALESCE(NEW.help_request_id, (
                    SELECT hrm.help_request_id
                    FROM public.help_request_messages hrm
                    WHERE hrm.id = NEW.message_id
                ));
                class_id := NEW.class_id;
                row_id := NEW.id;
            ELSIF TG_OP = 'UPDATE' THEN
                help_request_id := COALESCE(NEW.help_request_id, (
                    SELECT hrm.help_request_id
                    FROM public.help_request_messages hrm
                    WHERE hrm.id = NEW.message_id
                ));
                class_id := NEW.class_id;
                row_id := NEW.id;
            ELSIF TG_OP = 'DELETE' THEN
                help_request_id := COALESCE(OLD.help_request_id, (
                    SELECT hrm.help_request_id
                    FROM public.help_request_messages hrm
                    WHERE hrm.id = OLD.message_id
                ));
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
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_help_request_staff_data_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
    ELSIF TG_TABLE_NAME = 'help_request_templates' THEN
        -- For template data, broadcast to class-level channels since templates are class-wide resources
        IF TG_OP = 'INSERT' THEN
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'UPDATE' THEN
            class_id := NEW.class_id;
            row_id := NEW.id;
        ELSIF TG_OP = 'DELETE' THEN
            class_id := OLD.class_id;
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

        -- For karma data and templates, also broadcast to class-level channels
        IF TG_TABLE_NAME = 'student_karma_notes' THEN
            PERFORM realtime.send(
                staff_payload,
                'broadcast',
                'class:' || class_id || ':staff',
                true
            );
        ELSIF TG_TABLE_NAME = 'help_request_templates' THEN
            -- Broadcast template changes to both staff and general class channels
            PERFORM realtime.send(
                staff_payload,
                'broadcast',
                'class:' || class_id || ':staff',
                true
            );
            PERFORM realtime.send(
                staff_payload,
                'broadcast',
                'class:' || class_id,
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
$function$
;

CREATE OR REPLACE FUNCTION public.can_access_help_request(help_request_id bigint)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    case 
      when hr.is_private = false then
        -- Public help requests: user must be authorized for the class
        public.authorizeforclass(hr.class_id)
      when hr.is_private = true then
        -- Private help requests: user must be assignee, class grader, or student member
        (auth.uid() = hr.assignee) 
        or public.authorizeforclassgrader(hr.class_id)
        or public.user_is_in_help_request(hr.id)
      else
        -- Default deny
        false
    end
  from public.help_requests hr
  where hr.id = help_request_id;
$function$
;

CREATE OR REPLACE FUNCTION public.classes_populate_default_structures()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
    insert into discussion_topics (class_id, topic,color, description, ordinal)
       VALUES (NEW.id, 'Assignments', 'red', 'Questions and notes about assignments.', 1),
       (NEW.id, 'Logistics', 'orange', 'Anything else about the class', 2),
       (NEW.id, 'Readings', 'blue', 'Follow-ups and discussion of assigned and optional readings', 3),
       (NEW.id, 'Memes', 'purple', '#random', 4);
    insert into help_queues (name, description, class_id, available, depth)
       VALUES ('office-hours','This queue is staffed by tutors', NEW.id, TRUE, 0);   
    insert into gradebooks (name, class_id)
       VALUES ('Gradebook', NEW.id);
  UPDATE public.classes set gradebook_id=gradebooks.id from public.gradebooks where classes.id=gradebooks.class_id;
   RETURN NEW;
end$function$
;

CREATE OR REPLACE FUNCTION public.create_help_queue_channels()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.create_help_request_channels()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.create_help_request_message_notification(p_class_id bigint, p_help_request_id bigint, p_help_queue_id bigint, p_help_queue_name text, p_message_id bigint, p_author_profile_id uuid, p_author_name text, p_message_preview text, p_help_request_creator_profile_id uuid, p_help_request_creator_name text, p_is_private boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  notification_body jsonb;
  target_user_id uuid;
  user_role text;
begin
  -- Build notification body
  notification_body := jsonb_build_object(
    'type', 'help_request_message',
    'help_request_id', p_help_request_id,
    'help_queue_id', p_help_queue_id,
    'help_queue_name', p_help_queue_name,
    'message_id', p_message_id,
    'author_profile_id', p_author_profile_id,
    'author_name', p_author_name,
    'message_preview', p_message_preview,
    'help_request_creator_profile_id', p_help_request_creator_profile_id,
    'help_request_creator_name', p_help_request_creator_name,
    'is_private', p_is_private
  );

  -- Send notifications only to users who are watching this help request
  insert into public.notifications (user_id, class_id, subject, body)
  select 
    hrw.user_id,
    p_class_id,
    jsonb_build_object('text', 'New message in help request'),
    notification_body
  from public.help_request_watchers hrw
  join public.user_roles ur on ur.user_id = hrw.user_id and ur.class_id = p_class_id
  left join public.help_queue_assignments hqa on hqa.ta_profile_id = ur.private_profile_id 
    and hqa.help_queue_id = p_help_queue_id 
    and hqa.is_active = true
  where hrw.help_request_id = p_help_request_id
    and hrw.enabled = true
    and hrw.user_id != p_author_profile_id -- Don't notify the message author
    and (
      -- Always notify instructors and graders who are watching
      ur.role in ('instructor', 'grader')
      -- Always notify the help request creator if they're watching
      or ur.private_profile_id = p_help_request_creator_profile_id
      -- For public requests, notify students who are watching (unless private)
      or (not p_is_private and ur.role = 'student')
      -- Notify TAs who are actively working this queue and watching
      or hqa.id is not null
    );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.discussion_thread_root_patch()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      if NEW.root is null then
         update discussion_threads set root = id where id = NEW.id;
      END if;
      RETURN NULL;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$function$
;

CREATE OR REPLACE FUNCTION public.discussion_thread_set_ordinal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      NEW.ordinal = (select COUNT(*)+1 from discussion_threads where class_id = NEW.class_id);
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$function$
;

CREATE OR REPLACE FUNCTION public.discussion_threads_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
   body jsonb;
   subject jsonb;
   style text;
   existing_watch int;
   root_subject text;
   reply_author_name text;
   current_user_id uuid;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
    -- Set root to its own ID if there is no root specified
      if NEW.root is null then
         update discussion_threads set root = id where id = NEW.id;
         NEW.root = NEW.id;
         root_subject = NEW.subject;
      else
        SELECT discussion_threads.subject from discussion_threads into root_subject WHERE id=NEW.root; 
      END if;
      SELECT name into reply_author_name from profiles where id=NEW.author; 

   -- Get current user ID, handling null case
      current_user_id := auth.uid();

   -- TODO: make this work for "draft" (ignore trigger on insert, catch on update)
      body := jsonb_build_object(
         'type', 'discussion_thread',
         'action', 'reply',
         'new_comment_number',NEW.ordinal,
         'new_comment_id',NEW.id,
         'root_thread_id',NEW.root,
         'reply_author_profile_id',NEW.author,
         'teaser', left(NEW.body, 40),
         'thread_name',root_subject,
         'reply_author_name',reply_author_name
      );
      subject := '{}';
      style := 'info';
      
      -- Only send notifications if we have a current user
      if current_user_id is not null then
        INSERT INTO notifications (class_id, subject, body, style, user_id)
          SELECT class_id, subject, body, style, user_id FROM discussion_thread_watchers
            WHERE discussion_thread_root_id = NEW.root and enabled=true and user_id!=current_user_id;
      end if;

   -- Set watch if there is not one already and we have a current user
      if current_user_id is not null then
        Select COUNT(*) into existing_watch from discussion_thread_watchers WHERE discussion_thread_root_id = NEW.root and user_id=current_user_id;
        if existing_watch = 0 then
           INSERT INTO discussion_thread_watchers (class_id,discussion_thread_root_id,user_id,enabled) values
              (NEW.class_id, NEW.root, current_user_id, true);
        end if;
      end if;

      -- Mark as unread for everyone in the class, excluding the current user if one exists
      if current_user_id is not null then
        INSERT INTO discussion_thread_read_status (user_id,discussion_thread_id,discussion_thread_root_id) 
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id 
        from user_roles 
        where class_id=NEW.class_id and user_id != current_user_id;
      else
        -- If no current user (seeding context), mark as unread for all users in the class
        INSERT INTO discussion_thread_read_status (user_id,discussion_thread_id,discussion_thread_root_id) 
        select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id 
        from user_roles 
        where class_id=NEW.class_id;
      end if;
      
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.generate_anon_name()
 RETURNS text
 LANGUAGE plpgsql
AS $function$declare
adj text;
noun text;
begin

select into noun word from public.name_generation_words where is_noun order by random() limit 1;
select into adj word from public.name_generation_words where is_adjective order by random() limit 1;

return adj || '-' || noun || '-' || (floor(random() * 9999));
end;$function$
;

CREATE OR REPLACE FUNCTION public.get_user_id_by_email(email text)
 RETURNS TABLE(id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY SELECT au.id FROM auth.users au WHERE au.email = $1;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.help_request_is_private(p_help_request_id bigint)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select hr.is_private
  from public.help_requests hr
  where hr.id = p_help_request_id;
$function$
;

CREATE OR REPLACE FUNCTION public.intval(character varying)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE STRICT
AS $function$

SELECT
CASE
    WHEN length(btrim(regexp_replace($1, '[^0-9]', '','g')))>0 THEN btrim(regexp_replace($1, '[^0-9]', '','g'))::integer
    ELSE 0
END AS intval;

$function$
;

CREATE OR REPLACE FUNCTION public.is_allowed_grader_key(graderkey text, class bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
Begin
  RETURN (SELECT EXISTS (SELECT 1
  FROM grader_keys
  WHERE key=graderKey
  AND class_id=class));
End;  
$function$
;

CREATE OR REPLACE FUNCTION public.is_in_class(userid uuid, classid bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
Begin
  RETURN (SELECT EXISTS (SELECT 1
  FROM user_roles
  WHERE user_id=userid
  AND class_id=classid));
End;  
$function$
;

CREATE OR REPLACE FUNCTION public.is_instructor_for_class(_person_id uuid, _class_id integer)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
SELECT EXISTS (
  SELECT 1
  FROM user_roles ur
  WHERE (ur.class_id = _class_id or ur.role='admin')
  AND ur.user_id = _person_id
  AND (ur.role='instructor' or ur.role='grader'));
$function$
;

CREATE OR REPLACE FUNCTION public.is_instructor_for_class(_person_id uuid, classid bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$DECLARE
ret int4;
BEGIN
  SELECT 1
  INTO ret
  FROM user_roles ur
  WHERE (ur.class_id = classid or ur.role='admin')
  AND ur.user_id = _person_id
  AND (ur.role='instructor' or ur.role='grader');
  RETURN ret;
  END;$function$
;

CREATE OR REPLACE FUNCTION public.is_instructor_for_student(_person_id uuid, _student_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
AS $function$
SELECT EXISTS (
  SELECT 1
  FROM user_roles instr, user_roles stud
  WHERE (stud.class_id=instr.class_id or instr.role='admin')
  AND stud.user_id= _student_id
  AND instr.user_id = _person_id
  AND (instr.role='instructor' or instr.role='grader'));
$function$
;

CREATE OR REPLACE FUNCTION public.poll_question_answer_ins_del()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      INSERT INTO poll_question_results (poll_question,poll_question_answer,poll) values (NEW.poll_question,NEW.id,NEW.poll);
      RETURN NEW;
   WHEN 'DELETE' THEN
      DELETE FROM poll_question_results where poll_question_answer=OLD.id;
      RETURN OLD; -- must be non-null, NEW is null!
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.poll_response_answers_ins_del_upd()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      UPDATE poll_question_results AS r
      SET    count = r.count + 1
      WHERE  r.poll_question_answer = NEW.poll_question_answer;
      RETURN NEW;
   WHEN 'DELETE' THEN
      UPDATE poll_question_results AS r
      SET    count = r.count - 1
      WHERE  r.poll_question_answer = NEW.poll_question_answer;
      RETURN OLD; -- must be non-null, NEW is null!
  WHEN 'UPDATE' then
      UPDATE poll_question_results AS r
      SET    count = r.count + 1
      WHERE  r.poll_question_answer = NEW.poll_question_answer;
      UPDATE poll_question_results AS r
      SET    count = r.count - 1
      WHERE  r.poll_question_answer = OLD.poll_question_answer;
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.remove_github_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$ BEGIN UPDATE public.users set
github_username=null
where user_id=OLD.user_id AND OLD.provider='github';
RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trigger_help_request_message_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  help_request_row public.help_requests%ROWTYPE;
  queue_name text;
  author_name text;
  creator_profile_id uuid;
  creator_name text;
  message_preview text;
BEGIN
  -- Get help request details
  SELECT * INTO help_request_row FROM public.help_requests WHERE id = NEW.help_request_id;
  
  -- Get one student from the group to represent the "creator" for the notification
  SELECT profile_id INTO creator_profile_id FROM public.help_request_students WHERE help_request_id = NEW.help_request_id LIMIT 1;
  
  -- Get related data
  SELECT name INTO queue_name FROM public.help_queues WHERE id = help_request_row.help_queue;
  SELECT name INTO author_name FROM public.profiles WHERE id = NEW.author;
  SELECT name INTO creator_name FROM public.profiles WHERE id = creator_profile_id;
  
  -- Create message preview
  message_preview := LEFT(NEW.message, 100);
  IF LENGTH(NEW.message) > 100 THEN
    message_preview := message_preview || '...';
  END IF;
  
  -- Create notification
  PERFORM public.create_help_request_message_notification(
    NEW.class_id,
    NEW.help_request_id,
    help_request_row.help_queue,
    COALESCE(queue_name, 'Unknown Queue'),
    NEW.id,
    NEW.author,
    COALESCE(author_name, 'Unknown User'),
    message_preview,
    creator_profile_id,
    COALESCE(creator_name, 'Unknown User'),
    help_request_row.is_private
  );
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trigger_help_request_student_added()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  student_count int;
  queue_name text;
  creator_name text;
  request_preview text;
  help_request public.help_requests%ROWTYPE;
BEGIN
  -- Check if this is the first student being added to this help request
  SELECT count(*) INTO student_count FROM public.help_request_students WHERE help_request_id = NEW.help_request_id;
  
  IF student_count = 1 THEN
    -- This is the "creation" event from a notification perspective
    SELECT * INTO help_request FROM public.help_requests WHERE id = NEW.help_request_id;
    
    SELECT name INTO queue_name FROM public.help_queues WHERE id = help_request.help_queue;
    SELECT name INTO creator_name FROM public.profiles WHERE id = NEW.profile_id;
    
    request_preview := LEFT(help_request.request, 100);
    IF LENGTH(help_request.request) > 100 THEN
      request_preview := request_preview || '...';
    END IF;
    
    PERFORM public.create_help_request_notification(
      help_request.class_id,
      'help_request',
      help_request.id,
      help_request.help_queue,
      COALESCE(queue_name, 'Unknown Queue'),
      NEW.profile_id, -- The first student is the "creator"
      COALESCE(creator_name, 'Unknown User'),
      NULL,
      NULL,
      help_request.status,
      request_preview,
      help_request.is_private,
      'created'
    );
  END IF;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trigger_help_request_updated()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  queue_name text;
  creator_profile_id uuid;
  creator_name text;
  assignee_name text;
  request_preview text;
BEGIN
  -- Only proceed if status or assignee changed
  IF OLD.status IS NOT DISTINCT FROM NEW.status AND OLD.assignee IS NOT DISTINCT FROM NEW.assignee THEN
    RETURN NEW;
  END IF;
  
  SELECT name INTO queue_name FROM public.help_queues WHERE id = NEW.help_queue;
  
  -- Get one student from the group to represent the "creator" for the notification
  SELECT profile_id INTO creator_profile_id FROM public.help_request_students WHERE help_request_id = NEW.id LIMIT 1;
  SELECT name INTO creator_name FROM public.profiles WHERE id = creator_profile_id;
  
  request_preview := LEFT(NEW.request, 100);
  IF LENGTH(NEW.request) > 100 THEN
    request_preview := request_preview || '...';
  END IF;
  
  -- Handle assignment changes
  IF OLD.assignee IS DISTINCT FROM NEW.assignee AND NEW.assignee IS NOT NULL THEN
    SELECT name INTO assignee_name FROM public.profiles WHERE id = NEW.assignee;
    
    PERFORM public.create_help_request_notification(
      NEW.class_id, 'help_request', NEW.id, NEW.help_queue,
      COALESCE(queue_name, 'Unknown Queue'), creator_profile_id,
      COALESCE(creator_name, 'Unknown User'), NEW.assignee,
      COALESCE(assignee_name, 'Unknown User'), NEW.status, request_preview,
      NEW.is_private, 'assigned'
    );
  END IF;
  
  -- Handle status changes  
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.assignee IS NOT NULL THEN
      SELECT name INTO assignee_name FROM public.profiles WHERE id = NEW.assignee;
    END IF;
    
    PERFORM public.create_help_request_notification(
      NEW.class_id, 'help_request', NEW.id, NEW.help_queue,
      COALESCE(queue_name, 'Unknown Queue'), creator_profile_id,
      COALESCE(creator_name, 'Unknown User'), NEW.assignee,
      assignee_name, NEW.status, request_preview,
      NEW.is_private, 'status_changed'
    );
  END IF;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_children_count()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      UPDATE discussion_threads AS t
      SET    children_count = t.children_count + 1
      WHERE  t.id = NEW.root AND NEW.draft = false;
      UPDATE discussion_threads AS t
      SET    children_count = t.children_count + 1
      WHERE  t.id = NEW.parent AND t.id != NEW.root AND NEW.draft=false;
   WHEN 'DELETE' THEN
      UPDATE discussion_threads AS t
      SET    children_count = t.children_count - 1
      WHERE  t.id = OLD.root AND OLD.draft = false AND t.id != OLD.id;
      UPDATE discussion_threads AS t
      SET    children_count = t.children_count - 1
      WHERE  t.id = OLD.parent AND t.id != OLD.root AND OLD.draft=false AND t.id != OLD.id;
      RETURN OLD; -- must be non-null, NEW is null!
  WHEN 'UPDATE' then
       if new.draft = false and old.draft = true then
             UPDATE discussion_threads AS t
            SET    children_count = t.children_count + 1
            WHERE  t.id = NEW.root;
            UPDATE discussion_threads AS t
            SET    children_count = t.children_count + 1
            WHERE  t.id = NEW.parent AND t.id != NEW.root;
       end if;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.update_github_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$ BEGIN UPDATE public.users set
github_username=json_extract_path_text(to_json(NEW.identity_data),'user_name')
where user_id=NEW.user_id;
RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_thread_likes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      UPDATE discussion_threads AS t
      SET    likes_count = t.likes_count + 1
      WHERE  t.id = NEW.discussion_thread;
      RETURN NEW;
   WHEN 'DELETE' THEN
      UPDATE discussion_threads AS t
      SET    likes_count = t.likes_count - 1
      WHERE  t.id = OLD.discussion_thread;
      RETURN OLD;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$function$
;

CREATE OR REPLACE FUNCTION public.user_is_in_help_request(p_help_request_id bigint, p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select exists (
    select 1
    from public.help_request_students hrs
    where hrs.help_request_id = p_help_request_id
    and hrs.profile_id in (
      select ur.private_profile_id
      from public.user_roles ur
      where ur.user_id = p_user_id
    )
  ) OR exists (
    select 1
    from public.help_requests hr
    join public.user_roles ur on ur.private_profile_id = hr.created_by
    where hr.id = p_help_request_id
    and ur.user_id = p_user_id
  );
$function$
;


