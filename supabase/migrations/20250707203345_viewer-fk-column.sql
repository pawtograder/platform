alter table "public"."help_request_message_read_receipts" drop constraint "help_request_message_read_receipts_viewer_id_fkey";

drop function if exists "public"."is_instructor_for_class"(_person_id uuid, _class_id integer);

alter table "public"."help_request_message_read_receipts" add constraint "help_request_message_read_receipts_viewer_id_fkey" FOREIGN KEY (viewer_id) REFERENCES profiles(id) ON UPDATE CASCADE ON DELETE CASCADE not valid;

alter table "public"."help_request_message_read_receipts" validate constraint "help_request_message_read_receipts_viewer_id_fkey";

set check_function_bodies = off;

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

CREATE OR REPLACE FUNCTION public.authorizeforclass(class__id bigint)
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
  where class_id=class__id and user_id=auth.uid();

  return bind_permissions > 0;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.authorizeforclassinstructor(class__id bigint)
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
  where class_id=class__id and user_id=auth.uid() and role='instructor';

  return bind_permissions > 0;
end;
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

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
 RETURNS jsonb
 LANGUAGE plv8
 STABLE
AS $function$var user_roles;

  // Fetch the current user's user_role from the public user_roles table.
  var result = plv8.execute("select role, class_id,public_profile_id,private_profile_id from public.user_roles where user_id = $1", [event.user_id]);
  // Check if 'claims' exists in the event object; if not, initialize it
  if (!event.claims) {
    event.claims = {};
  }

  //Find ther user's github identity, if one exists
  var ghResult = plv8.execute("select identity_data from identities where provider='github' and user_id=$1",[event.user_id]);
  event.claims.github = ghResult;
  // Update the level in the claims
  event.claims.user_roles = result;
  return event;$function$
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


