drop policy "students view all non-private in their class, instructors and g" on "public"."discussion_threads";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.authorize_for_private_discussion_thread(root bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  bind_permissions int;
  jwtRoles public.user_roles;
begin
  -- check for direct ownership of assignment
    select count(*)
    into bind_permissions
    from public.discussion_threads as t
    inner join public.user_roles as r on (r.private_profile_id=t.author or r.public_profile_id=t.author)
    where r.user_id=auth.uid();

    if bind_permissions > 0 then
      return true;
    end if;

  return false;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.discussion_threads_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$declare
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
        SELECT discussion_threads.subject from discussion_threads into root_subject WHERE id=NEW.root; 
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
END$function$
;

create policy "students view all non-private in their class, instructors and g"
on "public"."discussion_threads"
as permissive
for select
to public
using (((authorizeforclass(class_id) AND (instructors_only = false)) OR authorizeforclassgrader(class_id) OR authorizeforprofile(author) OR (instructors_only AND authorize_for_private_discussion_thread(root))));



