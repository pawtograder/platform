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

drop function if exists "public"."create_all_repos_for_assignment"(course_id integer, assignment_id integer);

drop function if exists "public"."recalculate_gradebook_columns_in_range"(start_id bigint, end_id bigint);

alter table "public"."notification_preferences" drop constraint "notification_preferences_pkey";

drop index if exists "public"."idx_rubric_checks_criteria_ordinal";

drop index if exists "public"."idx_rubric_criteria_part_ordinal";

drop index if exists "public"."idx_rubric_parts_rubric_ordinal";

drop index if exists "public"."notification_preferences_pkey";

drop table "public"."notification_preferences";

drop type "public"."email_digest_frequency";

drop type "public"."notification_type";

set check_function_bodies = off;

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
       VALUES ('office-hours','This queue is staffed by TAs', NEW.id, TRUE, 0);   
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
begin
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
      -- Enrich with subject/body for email templates and digests
      'request_subject', coalesce(
        (
          select hrt.name
          from public.help_request_templates hrt
          where hrt.id = (
            select hr.template_id from public.help_requests hr where hr.id = p_help_request_id
          )
        ),
        'General'
      ),
      'request_body', (
        select hr.request from public.help_requests hr where hr.id = p_help_request_id
      ),
      'is_private', p_is_private
    );
  end if;

  -- On creation: notify instructors and graders only (do NOT blast the entire class)
  if p_action = 'created' then
    insert into public.notifications (user_id, class_id, subject, body)
    select distinct
      ur.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.user_roles ur
    where ur.class_id = p_class_id
      and ur.role in ('instructor', 'grader');

    -- Ensure the creator is watching their own request
    insert into public.help_request_watchers (user_id, help_request_id, class_id, enabled)
    select ur.user_id, p_help_request_id, p_class_id, true
    from public.user_roles ur
    where ur.private_profile_id = p_creator_profile_id
      and ur.class_id = p_class_id
    on conflict (user_id, help_request_id) do nothing;

  else
    -- For assignment/status changes: notify watchers
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
        SELECT discussion_threads.subject INTO root_subject FROM discussion_threads WHERE id=NEW.root; 
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


