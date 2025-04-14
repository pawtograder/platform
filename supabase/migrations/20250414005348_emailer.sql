set check_function_bodies = off;

drop policy "view own, instructors and graders also view all that they instr" on "public"."users";

create table "public"."calculated_score" (
    "sum" numeric
);


alter table "public"."users" add column "email" text;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.notify_new_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
 BEGIN
PERFORM pgmq.send(
  queue_name  => 'notification_emails',
  msg => row_to_json(NEW)::jsonb
);
RETURN NEW;
END;
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
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
    -- Set root to its own ID if there is no root specified
      if NEW.root is null then
         update discussion_threads set root = id where id = NEW.id;
         NEW.root = NEW.id;
         root_subject = NEW.subject;
      else
        SELECT subject into root_subject WHERE id=NEW.root; 
      END if;
      SELECT name into reply_author_name from profiles where id=NEW.author; 

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
      INSERT INTO notifications (class_id, subject, body, style, user_id)
        SELECT class_id, subject, body, style, user_id FROM discussion_thread_watchers
          WHERE discussion_thread_root_id = NEW.root and enabled=true and user_id!=auth.uid();
   -- Set watch if there is not one already

      Select COUNT(*) into existing_watch from discussion_thread_watchers WHERE discussion_thread_root_id = NEW.root and user_id=auth.uid();
      if existing_watch =0 then
         INSERT INTO discussion_thread_watchers (class_id,discussion_thread_root_id,user_id,enabled) values
            (NEW.class_id, NEW.root, auth.uid(), true);
      end if;

      -- Mark as unread for everyone in the class except for the author
      INSERT INTO discussion_thread_read_status (user_id,discussion_thread_id,discussion_thread_root_id) select user_id, NEW.id as discussion_thread_id, NEW.root as discussion_thread_root_id from user_roles where class_id=NEW.class_id and user_id != auth.uid();
      
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.user_register_create_demo_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
   existing_profile boolean;
   existing_public_profile boolean;
   new_public_profile_id uuid;
   new_private_profile_id uuid;
   demo_class_id int8;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      SELECT EXISTS(SELECT 1 from public.users where user_id=NEW.id) INTO existing_profile;
      if not existing_profile then
         INSERT INTO public.users (user_id,email) VALUES (NEW.id,NEW.email);
      end if;
      SELECT id FROM public.classes WHERE is_demo LIMIT 1 INTO demo_class_id;
      if demo_class_id is not null then
        INSERT INTO public.profiles (name, avatar_url, class_id) VALUES
            (NEW.email, 'https://api.dicebear.com/9.x/identicon/svg?seed=' || NEW.email, demo_class_id) RETURNING id into new_private_profile_id;

        INSERT INTO public.profiles (name, avatar_url, class_id) VALUES
            (public.generate_anon_name(),'https://api.dicebear.com/9.x/identicon/svg?seed='||public.generate_anon_name(), demo_class_id) RETURNING id into new_public_profile_id; 

        IF NEW.email LIKE '%instructor%' THEN
            INSERT INTO public.user_roles (user_id, class_id, role, public_profile_id, private_profile_id) VALUES (NEW.id, demo_class_id, 'instructor', new_public_profile_id, new_private_profile_id);
        ELSE    
            INSERT INTO public.user_roles (user_id, class_id, role, public_profile_id, private_profile_id) VALUES (NEW.id, demo_class_id, 'student', new_public_profile_id, new_private_profile_id);
        END IF;
      end if;
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$function$
;

CREATE OR REPLACE TRIGGER new_notification_trigger AFTER INSERT ON public.notifications FOR EACH ROW EXECUTE FUNCTION notify_new_notification();


