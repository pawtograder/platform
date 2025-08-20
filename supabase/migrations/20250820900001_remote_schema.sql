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

CREATE OR REPLACE FUNCTION public.create_help_request_notification(p_class_id bigint, p_notification_type text, p_help_request_id bigint, p_help_queue_id bigint, p_help_queue_name text, p_creator_profile_id uuid, p_creator_name text, p_assignee_profile_id uuid DEFAULT NULL::uuid, p_assignee_name text DEFAULT NULL::text, p_status help_request_status DEFAULT NULL::help_request_status, p_request_preview text DEFAULT ''::text, p_is_private boolean DEFAULT false, p_action text DEFAULT 'created'::text)
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
  -- Build notification body based on type
  if p_notification_type = 'help_request' then
    notification_body := jsonb_build_object(
      'type', 'help_request',
      'action', p_action,
      'help_request_id', p_help_request_id,
      'help_queue_id', p_help_queue_id,
      'help_queue_name', p_help_queue_name,
      'creator_profile_id', p_creator_profile_id,
      'creator_name', p_creator_name,
      'assignee_profile_id', p_assignee_profile_id,
      'assignee_name', p_assignee_name,
      'status', p_status,
      'request_preview', p_request_preview,
      'is_private', p_is_private
    );
  end if;

  -- For 'created' action, notify all eligible users and auto-create watchers
  if p_action = 'created' then
    -- Send notifications to eligible users (not restricted to watchers for creation)
    for target_user_id, user_role in
      select distinct ur.user_id, ur.role
      from public.user_roles ur
      where ur.class_id = p_class_id
        and (
          -- For private requests, only notify instructors, graders, creator, and assignee
          (p_is_private and ur.role in ('instructor', 'grader'))
          or (p_is_private and ur.private_profile_id = p_creator_profile_id)
          or (p_is_private and ur.private_profile_id = p_assignee_profile_id)
          -- For public requests, notify everyone except the creator
          or (not p_is_private and ur.private_profile_id != p_creator_profile_id)
        )
    loop
      insert into public.notifications (user_id, class_id, subject, body)
      values (
        target_user_id,
        p_class_id,
        jsonb_build_object('text', 'Help Request ' || p_action),
        notification_body
      );
    end loop;

    -- Auto-create watcher for the creator (enabled by default)
    insert into public.help_request_watchers (user_id, help_request_id, class_id, enabled)
    select ur.user_id, p_help_request_id, p_class_id, true
    from public.user_roles ur
    where ur.private_profile_id = p_creator_profile_id 
      and ur.class_id = p_class_id
    on conflict (user_id, help_request_id) do nothing;

  else
    -- For other actions (assigned, status_changed), only notify watchers
    insert into public.notifications (user_id, class_id, subject, body)
    select 
      hrw.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.help_request_watchers hrw
    join public.user_roles ur on ur.user_id = hrw.user_id and ur.class_id = p_class_id
    where hrw.help_request_id = p_help_request_id
      and hrw.enabled = true
      and (
        -- For private requests, only notify instructors, graders, creator, and assignee
        (p_is_private and ur.role in ('instructor', 'grader'))
        or (p_is_private and ur.private_profile_id = p_creator_profile_id)
        or (p_is_private and ur.private_profile_id = p_assignee_profile_id)
        -- For public requests, notify all watching users
        or not p_is_private
      );
  end if;
end;
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