-- Fix discussion thread trigger to handle null auth.uid() (e.g., during seeding)
-- This prevents constraint violations when creating discussion threads in script contexts

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
