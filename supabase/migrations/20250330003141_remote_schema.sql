

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pgsodium";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "plv8" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_graphql" WITH SCHEMA "graphql";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgjwt" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE TYPE "public"."allowed_modes" AS ENUM (
    'private',
    'public',
    'question',
    'note'
);


ALTER TYPE "public"."allowed_modes" OWNER TO "postgres";


CREATE TYPE "public"."app_role" AS ENUM (
    'admin',
    'instructor',
    'grader',
    'student'
);


ALTER TYPE "public"."app_role" OWNER TO "postgres";


CREATE TYPE "public"."feedback_visibility" AS ENUM (
    'visible',
    'hidden',
    'after_due_date',
    'after_published'
);


ALTER TYPE "public"."feedback_visibility" OWNER TO "postgres";


COMMENT ON TYPE "public"."feedback_visibility" IS 'Visibility mode for feedback';



CREATE OR REPLACE FUNCTION "public"."assignment_before_update"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
$$;


ALTER FUNCTION "public"."assignment_before_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assignments_grader_config_auto_populate"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$begin
  INSERT INTO autograder (id) VALUES (NEW.id);
  INSERT INTO autograder_regression_test (autograder_id,repository) VALUES (NEW.id, NEW.template_repo);
  RETURN NULL;
end;$$;


ALTER FUNCTION "public"."assignments_grader_config_auto_populate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."authorizeforclass"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "public"."authorizeforclass"("class__id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."authorizeforinstructorofstudent"("user_id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare
  bind_permissions int;
  jwtRoles public.user_roles;
begin

  -- Fetch user role once and store it to reduce number of calls
  select count(*)
  into bind_permissions
  from public.user_roles as ourRole
  inner join public.user_roles as studentRole on ourRole.class_id=studentRole.class_id and studentRole.user_id=user_id
  where ourRole.user_id=auth.uid() and ourRole.role='instructor';

  return bind_permissions > 0;
end;
$$;


ALTER FUNCTION "public"."authorizeforinstructorofstudent"("user_id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."authorizeforinstructorofstudent"("_user_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "public"."authorizeforinstructorofstudent"("_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."authorizeforpoll"("poll__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "public"."authorizeforpoll"("poll__id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."authorizeforpoll"("poll__id" bigint, "class__id" bigint) RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "public"."authorizeforpoll"("poll__id" bigint, "class__id" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."authorizeforprofile"("profile_id" "uuid") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
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
$$;


ALTER FUNCTION "public"."authorizeforprofile"("profile_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."custom_access_token_hook"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plv8" STABLE
    AS $_$var user_roles;

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
  return event;$_$;


ALTER FUNCTION "public"."custom_access_token_hook"("event" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."discussion_thread_root_patch"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
$$;


ALTER FUNCTION "public"."discussion_thread_root_patch"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."discussion_thread_set_ordinal"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      NEW.ordinal = (select COUNT(*)+1 from discussion_threads where class_id = NEW.class_id);
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$$;


ALTER FUNCTION "public"."discussion_thread_set_ordinal"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."discussion_threads_notification"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
   body jsonb;
   subject jsonb;
   style text;
   existing_watch int;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
    -- Set root to its own ID if there is no root specified
      if NEW.root is null then
         update discussion_threads set root = id where id = NEW.id;
         NEW.root = NEW.id;
      END if;

   -- TODO: make this work for "draft" (ignore trigger on insert, catch on update)
      body := jsonb_build_object(
         'type', 'discussion_thread',
         'action', 'reply',
         'new_comment_number',NEW.ordinal,
         'new_comment_id',NEW.id,
         'root_thread_id',NEW.root,
         'reply_author_profile_id',NEW.author,
         'teaser', left(NEW.body, 40)
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
$$;


ALTER FUNCTION "public"."discussion_threads_notification"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_anon_name"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$declare
adj text;
noun text;
begin

select into noun word from public.name_generation_words where is_noun order by random() limit 1;
select into adj word from public.name_generation_words where is_adjective order by random() limit 1;

return adj || '-' || noun || '-' || (floor(random() * 9999));
end;$$;


ALTER FUNCTION "public"."generate_anon_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_user_id_by_email"("email" "text") RETURNS TABLE("id" "uuid")
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $_$
BEGIN
  RETURN QUERY SELECT au.id FROM auth.users au WHERE au.email = $1;
END;
$_$;


ALTER FUNCTION "public"."get_user_id_by_email"("email" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."intval"(character varying) RETURNS integer
    LANGUAGE "sql" IMMUTABLE STRICT
    AS $_$

SELECT
CASE
    WHEN length(btrim(regexp_replace($1, '[^0-9]', '','g')))>0 THEN btrim(regexp_replace($1, '[^0-9]', '','g'))::integer
    ELSE 0
END AS intval;

$_$;


ALTER FUNCTION "public"."intval"(character varying) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_allowed_grader_key"("graderkey" "text", "class" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
Begin
  RETURN (SELECT EXISTS (SELECT 1
  FROM grader_keys
  WHERE key=graderKey
  AND class_id=class));
End;  
$$;


ALTER FUNCTION "public"."is_allowed_grader_key"("graderkey" "text", "class" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_in_class"("userid" "uuid", "classid" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
Begin
  RETURN (SELECT EXISTS (SELECT 1
  FROM user_roles
  WHERE user_id=userid
  AND class_id=classid));
End;  
$$;


ALTER FUNCTION "public"."is_in_class"("userid" "uuid", "classid" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "_class_id" integer) RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
SELECT EXISTS (
  SELECT 1
  FROM user_roles ur
  WHERE (ur.class_id = _class_id or ur.role='admin')
  AND ur.user_id = _person_id
  AND (ur.role='instructor' or ur.role='grader'));
$$;


ALTER FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "_class_id" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "classid" bigint) RETURNS boolean
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$DECLARE
ret int4;
BEGIN
  SELECT 1
  INTO ret
  FROM user_roles ur
  WHERE (ur.class_id = classid or ur.role='admin')
  AND ur.user_id = _person_id
  AND (ur.role='instructor' or ur.role='grader');
  RETURN ret;
  END;$$;


ALTER FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "classid" bigint) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_instructor_for_student"("_person_id" "uuid", "_student_id" "uuid") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    AS $$
SELECT EXISTS (
  SELECT 1
  FROM user_roles instr, user_roles stud
  WHERE (stud.class_id=instr.class_id or instr.role='admin')
  AND stud.user_id= _student_id
  AND instr.user_id = _person_id
  AND (instr.role='instructor' or instr.role='grader'));
$$;


ALTER FUNCTION "public"."is_instructor_for_student"("_person_id" "uuid", "_student_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_question_answer_ins_del"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
$$;


ALTER FUNCTION "public"."poll_question_answer_ins_del"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."poll_response_answers_ins_del_upd"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
$$;


ALTER FUNCTION "public"."poll_response_answers_ins_del_upd"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."remove_github_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ BEGIN UPDATE public.users set
github_username=null
where user_id=OLD.user_id AND OLD.provider='github';
RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."remove_github_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."submissions_insert_hook"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      SELECT count(*) FROM submissions where profile_id=NEW.profile_id and assignment_id=NEW.assignment_id INTO NEW.ordinal;
      NEW.ordinal = NEW.ordinal + 1;
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$$;


ALTER FUNCTION "public"."submissions_insert_hook"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_children_count"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
$$;


ALTER FUNCTION "public"."update_children_count"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_github_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$ BEGIN UPDATE public.users set
github_username=json_extract_path_text(to_json(NEW.identity_data),'user_name')
where user_id=NEW.user_id;
RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_github_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_thread_likes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
$$;


ALTER FUNCTION "public"."update_thread_likes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."user_register_create_demo_account"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
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
$$;


ALTER FUNCTION "public"."user_register_create_demo_account"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."rubrics" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ordinal" smallint NOT NULL,
    "name" "text",
    "deduction" smallint NOT NULL,
    "class_id" bigint
);


ALTER TABLE "public"."rubrics" OWNER TO "postgres";


ALTER TABLE "public"."rubrics" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."assignment_rubric_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."assignments" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "class_id" bigint,
    "title" "text",
    "release_date" timestamp with time zone,
    "due_date" timestamp with time zone,
    "latest_due_date" timestamp with time zone,
    "student_repo_prefix" "text",
    "total_points" numeric,
    "has_autograder" boolean,
    "has_handgrader" boolean,
    "description" "text",
    "allow_late" boolean,
    "slug" "text",
    "submission_files" "json" DEFAULT '[]'::"json" NOT NULL,
    "template_repo" "text"
);


ALTER TABLE "public"."assignments" OWNER TO "postgres";


ALTER TABLE "public"."assignments" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."assignments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."autograder" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "grader_repo" "text",
    "workflow_sha" "text",
    "grader_commit_sha" "text"
);


ALTER TABLE "public"."autograder" OWNER TO "postgres";


COMMENT ON COLUMN "public"."autograder"."id" IS 'Assignment ID';



CREATE TABLE IF NOT EXISTS "public"."autograder_regression_test" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "repository" "text" NOT NULL,
    "autograder_id" bigint NOT NULL
);


ALTER TABLE "public"."autograder_regression_test" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."grader_results" (
    "submission_id" bigint,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "errors" "json",
    "grader_sha" "text",
    "score" smallint NOT NULL,
    "ret_code" smallint,
    "execution_time" double precision,
    "class_id" bigint NOT NULL,
    "profile_id" "uuid",
    "lint_passed" boolean NOT NULL,
    "lint_output" "text" NOT NULL,
    "lint_output_format" "text" NOT NULL,
    "max_score" smallint DEFAULT '100'::smallint NOT NULL,
    "autograder_regression_test" bigint,
    "id" bigint NOT NULL,
    "grader_action_sha" "text"
);


ALTER TABLE "public"."grader_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."submissions" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assignment_id" bigint NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "released" timestamp without time zone,
    "sha" "text" NOT NULL,
    "repository" "text" NOT NULL,
    "run_attempt" bigint NOT NULL,
    "run_number" bigint NOT NULL,
    "class_id" bigint NOT NULL,
    "check_run_id" bigint,
    "ordinal" integer DEFAULT 1 NOT NULL
);


ALTER TABLE "public"."submissions" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."autograder_regression_test_by_grader" WITH ("security_invoker"='true') AS
 SELECT "a"."grader_repo",
    "t"."repository",
    "s"."sha",
    "t"."id",
    "s"."class_id"
   FROM ((("public"."autograder_regression_test" "t"
     JOIN "public"."autograder" "a" ON (("a"."id" = "t"."autograder_id")))
     JOIN "public"."submissions" "s" ON (("s"."repository" = "t"."repository")))
     JOIN "public"."grader_results" "g" ON (("g"."submission_id" = "s"."id")))
  GROUP BY "s"."sha", "a"."grader_repo", "t"."repository", "s"."created_at", "t"."id", "s"."class_id"
 HAVING ("s"."created_at" = "max"("s"."created_at"));


ALTER TABLE "public"."autograder_regression_test_by_grader" OWNER TO "postgres";


ALTER TABLE "public"."autograder_regression_test" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."autograder_regression_test_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."classes" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "semester" smallint,
    "canvas_id" integer,
    "time_zone" "text",
    "slug" "text",
    "is_demo" boolean DEFAULT false NOT NULL,
    "github_org" "text"
);


ALTER TABLE "public"."classes" OWNER TO "postgres";


ALTER TABLE "public"."classes" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."classes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."discussion_threads" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "author" "uuid" NOT NULL,
    "subject" "text" NOT NULL,
    "body" "text" NOT NULL,
    "instructors_only" boolean DEFAULT false NOT NULL,
    "is_question" boolean DEFAULT false NOT NULL,
    "answer" bigint,
    "edited_at" timestamp without time zone,
    "class_id" bigint NOT NULL,
    "parent" bigint,
    "root" bigint,
    "draft" boolean DEFAULT false NOT NULL,
    "likes_count" bigint DEFAULT '0'::bigint NOT NULL,
    "children_count" bigint DEFAULT '0'::bigint NOT NULL,
    "root_class_id" bigint,
    "topic_id" bigint NOT NULL,
    "ordinal" bigint
);


ALTER TABLE "public"."discussion_threads" OWNER TO "postgres";


COMMENT ON COLUMN "public"."discussion_threads"."root_class_id" IS 'Supabase realtime workaround: set to class_id if it''s a root thread, otherwise null';



ALTER TABLE "public"."discussion_threads" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."dicussion_threads_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."discussion_thread_likes" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "discussion_thread" bigint NOT NULL,
    "creator" "uuid" NOT NULL,
    "emoji" "text" NOT NULL
);


ALTER TABLE "public"."discussion_thread_likes" OWNER TO "postgres";


ALTER TABLE "public"."discussion_thread_likes" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."discussion_thread_likes_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."discussion_thread_read_status" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "discussion_thread_id" bigint NOT NULL,
    "read_at" timestamp with time zone,
    "discussion_thread_root_id" bigint NOT NULL
);


ALTER TABLE "public"."discussion_thread_read_status" OWNER TO "postgres";


ALTER TABLE "public"."discussion_thread_read_status" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."discussion_thread_read_status_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."discussion_thread_watchers" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "discussion_thread_root_id" bigint NOT NULL,
    "class_id" bigint NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL
);


ALTER TABLE "public"."discussion_thread_watchers" OWNER TO "postgres";


ALTER TABLE "public"."discussion_thread_watchers" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."discussion_thread_watchers_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."discussion_topics" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "class_id" bigint NOT NULL,
    "topic" "text" NOT NULL,
    "color" "text" NOT NULL,
    "description" "text" NOT NULL,
    "ordinal" smallint DEFAULT '0'::smallint NOT NULL
);


ALTER TABLE "public"."discussion_topics" OWNER TO "postgres";


ALTER TABLE "public"."discussion_topics" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."discussion_topics_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."grader_keys" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "class_id" bigint NOT NULL,
    "key" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "note" "text"
);


ALTER TABLE "public"."grader_keys" OWNER TO "postgres";


ALTER TABLE "public"."grader_keys" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."grader_keys_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."grader_result_output" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "output" "text" NOT NULL,
    "format" "text" NOT NULL,
    "visibility" "public"."feedback_visibility" NOT NULL,
    "class_id" bigint NOT NULL,
    "student_id" "uuid",
    "grader_result_id" bigint NOT NULL
);


ALTER TABLE "public"."grader_result_output" OWNER TO "postgres";


ALTER TABLE "public"."grader_result_output" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."grader_result_output_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."grader_result_tests" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "score" numeric,
    "max_score" numeric,
    "name" "text" NOT NULL,
    "name_format" "text" DEFAULT 'text'::"text" NOT NULL,
    "extra_data" "json",
    "output" "text",
    "output_format" "text",
    "class_id" bigint NOT NULL,
    "student_id" "uuid",
    "part" "text",
    "grader_result_id" bigint NOT NULL
);


ALTER TABLE "public"."grader_result_tests" OWNER TO "postgres";


COMMENT ON COLUMN "public"."grader_result_tests"."class_id" IS 'For RTS...';



ALTER TABLE "public"."grader_results" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."grader_results_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE "public"."grader_result_tests" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."grader_test_results_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."help_queues" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "class_id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "description" "text" NOT NULL,
    "available" boolean DEFAULT false NOT NULL,
    "closing_at" timestamp without time zone,
    "depth" bigint NOT NULL,
    "color" "text"
);


ALTER TABLE "public"."help_queues" OWNER TO "postgres";


ALTER TABLE "public"."help_queues" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."help_queues_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."help_request_messages" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "class_id" bigint NOT NULL,
    "author" "uuid" NOT NULL,
    "message" "text" NOT NULL,
    "instructors_only" boolean DEFAULT false NOT NULL,
    "help_request_id" bigint NOT NULL,
    "requestor" "uuid"
);


ALTER TABLE "public"."help_request_messages" OWNER TO "postgres";


ALTER TABLE "public"."help_request_messages" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."help_request_messages_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."help_requests" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "help_queue" bigint NOT NULL,
    "creator" "uuid" NOT NULL,
    "request" "text" NOT NULL,
    "followup_to" bigint,
    "assignee" "uuid",
    "class_id" bigint NOT NULL,
    "is_video_live" boolean DEFAULT false NOT NULL,
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone
);


ALTER TABLE "public"."help_requests" OWNER TO "postgres";


ALTER TABLE "public"."help_requests" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."help_requests_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."name_generation_words" (
    "id" bigint NOT NULL,
    "word" "text" NOT NULL,
    "is_noun" boolean NOT NULL,
    "is_adjective" boolean NOT NULL
);


ALTER TABLE "public"."name_generation_words" OWNER TO "postgres";


ALTER TABLE "public"."name_generation_words" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."name_generation_words_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "class_id" bigint NOT NULL,
    "viewed_at" timestamp without time zone,
    "subject" "jsonb" NOT NULL,
    "body" "jsonb" NOT NULL,
    "style" "text"
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


ALTER TABLE "public"."notifications" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."notifications_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."permissions" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid",
    "permission" "text"
);


ALTER TABLE "public"."permissions" OWNER TO "postgres";


ALTER TABLE "public"."permissions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."permissions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."poll_question_answers" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "poll_question" bigint NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "poll" bigint NOT NULL,
    "class_id" bigint NOT NULL,
    "ordinal" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."poll_question_answers" OWNER TO "postgres";


ALTER TABLE "public"."poll_question_answers" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."poll_question_answers_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."poll_question_results" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "poll_question" bigint NOT NULL,
    "poll_question_answer" bigint NOT NULL,
    "count" integer DEFAULT 0 NOT NULL,
    "poll" bigint NOT NULL
);


ALTER TABLE "public"."poll_question_results" OWNER TO "postgres";


ALTER TABLE "public"."poll_question_results" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."poll_question_results_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."poll_questions" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "poll" bigint NOT NULL,
    "question_type" "text" DEFAULT 'multiple-choice'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "class_id" bigint NOT NULL
);


ALTER TABLE "public"."poll_questions" OWNER TO "postgres";


ALTER TABLE "public"."poll_questions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."poll_questions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."poll_response_answers" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "poll_response" bigint NOT NULL,
    "poll" bigint NOT NULL,
    "poll_question" bigint NOT NULL,
    "poll_question_answer" bigint NOT NULL,
    "profile_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL
);


ALTER TABLE "public"."poll_response_answers" OWNER TO "postgres";


ALTER TABLE "public"."poll_response_answers" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."poll_response_answers_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."poll_responses" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp without time zone,
    "profile_id" "uuid" NOT NULL,
    "class_id" bigint NOT NULL,
    "poll" bigint NOT NULL
);


ALTER TABLE "public"."poll_responses" OWNER TO "postgres";


ALTER TABLE "public"."poll_responses" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."poll_responses_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."polls" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text" NOT NULL,
    "released_at" timestamp without time zone,
    "due_date" timestamp without time zone,
    "flair" "jsonb",
    "class_id" bigint NOT NULL,
    "description" "text"
);


ALTER TABLE "public"."polls" OWNER TO "postgres";


ALTER TABLE "public"."polls" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."polls_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "sis_user_id" "text",
    "time_zone" "text",
    "sortable_name" "text",
    "short_name" "text",
    "avatar_url" "text",
    "class_id" bigint NOT NULL,
    "flair" "text",
    "flair_color" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."repositories" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assignment_id" bigint NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "repository" "text" NOT NULL,
    "class_id" bigint NOT NULL
);


ALTER TABLE "public"."repositories" OWNER TO "postgres";


ALTER TABLE "public"."repositories" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."repositories_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE "public"."submissions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."submissio_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."submission_file_comments" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "submission_files_id" bigint NOT NULL,
    "submissions_id" bigint NOT NULL,
    "author" "uuid" NOT NULL,
    "comment" "text" NOT NULL,
    "deduction" integer,
    "line" integer NOT NULL,
    "class_id" bigint NOT NULL
);


ALTER TABLE "public"."submission_file_comments" OWNER TO "postgres";


ALTER TABLE "public"."submission_file_comments" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."submission_file_lcomments_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."submission_files" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "submissions_id" bigint NOT NULL,
    "name" "text" NOT NULL,
    "contents" "text" NOT NULL,
    "class_id" bigint NOT NULL,
    "profile_id" "uuid" NOT NULL
);


ALTER TABLE "public"."submission_files" OWNER TO "postgres";


ALTER TABLE "public"."submission_files" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."submission_files_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE OR REPLACE VIEW "public"."submissions_agg" WITH ("security_invoker"='true') AS
 SELECT "c"."submissioncount",
    "c"."latestsubmissionid",
    "s"."id",
    "s"."created_at",
    "s"."assignment_id",
    "s"."profile_id" AS "user_id",
    "s"."released",
    "s"."sha",
    "s"."repository",
    "s"."run_attempt",
    "s"."run_number",
    "g"."score",
    "g"."ret_code",
    "g"."execution_time"
   FROM ((( SELECT "count"("submissions"."id") AS "submissioncount",
            "max"("submissions"."id") AS "latestsubmissionid"
           FROM "public"."submissions"
          GROUP BY "submissions"."assignment_id", "submissions"."profile_id") "c"
     JOIN "public"."submissions" "s" ON (("s"."id" = "c"."latestsubmissionid")))
     LEFT JOIN "public"."grader_results" "g" ON (("g"."submission_id" = "s"."id")));


ALTER TABLE "public"."submissions_agg" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "class_id" integer NOT NULL,
    "role" "public"."app_role" NOT NULL,
    "canvas_id" numeric,
    "public_profile_id" "uuid" NOT NULL,
    "private_profile_id" "uuid" NOT NULL
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


COMMENT ON TABLE "public"."user_roles" IS 'Application roles for each user.';



ALTER TABLE "public"."user_roles" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."user_roles_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."users" (
    "user_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "github_username" "text",
    "name" "text",
    "avatar_url" "text"
);


ALTER TABLE "public"."users" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."video_meeting_sessions" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "help_request_id" bigint NOT NULL,
    "chime_meeting_id" "text",
    "started" timestamp with time zone,
    "ended" timestamp with time zone,
    "class_id" bigint NOT NULL
);


ALTER TABLE "public"."video_meeting_sessions" OWNER TO "postgres";


ALTER TABLE "public"."video_meeting_sessions" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."video_meeting_sessions_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



ALTER TABLE ONLY "public"."rubrics"
    ADD CONSTRAINT "assignment_rubric_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."assignments"
    ADD CONSTRAINT "assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."autograder_regression_test"
    ADD CONSTRAINT "autograder_regression_test_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "dicussion_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discussion_thread_likes"
    ADD CONSTRAINT "discussion_thread_likes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discussion_thread_read_status"
    ADD CONSTRAINT "discussion_thread_read_status_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discussion_thread_read_status"
    ADD CONSTRAINT "discussion_thread_read_status_user_id_discussion_thread_id_key" UNIQUE ("user_id", "discussion_thread_id");



ALTER TABLE ONLY "public"."discussion_thread_watchers"
    ADD CONSTRAINT "discussion_thread_watchers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discussion_topics"
    ADD CONSTRAINT "discussion_topics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."autograder"
    ADD CONSTRAINT "grader_configs_id_key" UNIQUE ("id");



ALTER TABLE ONLY "public"."autograder"
    ADD CONSTRAINT "grader_configs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."grader_keys"
    ADD CONSTRAINT "grader_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."grader_result_output"
    ADD CONSTRAINT "grader_result_output_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."grader_results"
    ADD CONSTRAINT "grader_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."grader_results"
    ADD CONSTRAINT "grader_results_submission_id_key" UNIQUE ("submission_id");



ALTER TABLE ONLY "public"."grader_result_tests"
    ADD CONSTRAINT "grader_test_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."help_queues"
    ADD CONSTRAINT "help_queues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."help_request_messages"
    ADD CONSTRAINT "help_request_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."name_generation_words"
    ADD CONSTRAINT "name_generation_words_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_question_answers"
    ADD CONSTRAINT "poll_question_answers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_question_results"
    ADD CONSTRAINT "poll_question_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_questions"
    ADD CONSTRAINT "poll_questions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_response_answers"
    ADD CONSTRAINT "poll_response_answers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."poll_responses"
    ADD CONSTRAINT "poll_responses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_key" UNIQUE ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_sis_user_id_key" UNIQUE ("sis_user_id");



ALTER TABLE ONLY "public"."repositories"
    ADD CONSTRAINT "repositories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissio_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."submission_file_comments"
    ADD CONSTRAINT "submission_file_lcomments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."submission_files"
    ADD CONSTRAINT "submission_files_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_private_profile_id_key" UNIQUE ("private_profile_id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_public_profile_id_key" UNIQUE ("public_profile_id");



ALTER TABLE ONLY "public"."users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."video_meeting_sessions"
    ADD CONSTRAINT "video_meeting_sessions_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "discussion_thread_likes_discussion_thread_user_idx" ON "public"."discussion_thread_likes" USING "btree" ("discussion_thread", "creator");



CREATE INDEX "discussion_threads_root_idx" ON "public"."discussion_threads" USING "hash" ("root");



CREATE INDEX "notifications_profile_id_idx" ON "public"."notifications" USING "btree" ("user_id");



CREATE UNIQUE INDEX "poll_response_answers_uniq" ON "public"."poll_response_answers" USING "btree" ("profile_id", "poll_question_answer", "poll_question");



CREATE INDEX "submission_files_submissions_id_idx" ON "public"."submission_files" USING "hash" ("submissions_id");



CREATE UNIQUE INDEX "thread_watch_uniq" ON "public"."discussion_thread_watchers" USING "btree" ("user_id", "discussion_thread_root_id");



CREATE INDEX "user_roles_private_profile_id_idx" ON "public"."user_roles" USING "btree" ("private_profile_id");



CREATE UNIQUE INDEX "user_roles_user_id_role_key" ON "public"."user_roles" USING "btree" ("user_id", "role", "class_id");



CREATE OR REPLACE TRIGGER "assignment_before_update" BEFORE UPDATE ON "public"."assignments" FOR EACH ROW EXECUTE FUNCTION "public"."assignment_before_update"();



CREATE OR REPLACE TRIGGER "assignments_grader_config_auto_create" AFTER INSERT ON "public"."assignments" FOR EACH ROW EXECUTE FUNCTION "public"."assignments_grader_config_auto_populate"();



CREATE OR REPLACE TRIGGER "discussion_thread_notifications" AFTER INSERT ON "public"."discussion_threads" FOR EACH ROW EXECUTE FUNCTION "public"."discussion_threads_notification"();



CREATE OR REPLACE TRIGGER "discussion_threads_children_ins_del" BEFORE INSERT OR DELETE OR UPDATE ON "public"."discussion_threads" FOR EACH ROW EXECUTE FUNCTION "public"."update_children_count"();



CREATE OR REPLACE TRIGGER "discussion_threads_likes_count" BEFORE INSERT OR DELETE ON "public"."discussion_thread_likes" FOR EACH ROW EXECUTE FUNCTION "public"."update_thread_likes"();



CREATE OR REPLACE TRIGGER "discussion_threads_set_ordinal" BEFORE INSERT ON "public"."discussion_threads" FOR EACH ROW EXECUTE FUNCTION "public"."discussion_thread_set_ordinal"();



CREATE OR REPLACE TRIGGER "poll_question_answer_ins_del" AFTER INSERT OR DELETE ON "public"."poll_question_answers" FOR EACH ROW EXECUTE FUNCTION "public"."poll_question_answer_ins_del"();



CREATE OR REPLACE TRIGGER "poll_response_answers_ins_del_upd" BEFORE INSERT OR DELETE OR UPDATE ON "public"."poll_response_answers" FOR EACH ROW EXECUTE FUNCTION "public"."poll_response_answers_ins_del_upd"();



CREATE OR REPLACE TRIGGER "submissions_insert_hook" BEFORE INSERT ON "public"."submissions" FOR EACH ROW EXECUTE FUNCTION "public"."submissions_insert_hook"();



ALTER TABLE ONLY "public"."rubrics"
    ADD CONSTRAINT "assignment_rubric_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."assignments"
    ADD CONSTRAINT "assignments_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."autograder_regression_test"
    ADD CONSTRAINT "autograder_regression_test_autograder_id_fkey" FOREIGN KEY ("autograder_id") REFERENCES "public"."autograder"("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "dicussion_threads_author_fkey" FOREIGN KEY ("author") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "dicussion_threads_class_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "dicussion_threads_parent_fkey" FOREIGN KEY ("parent") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_thread_likes"
    ADD CONSTRAINT "discussion_thread_likes_discussion_thread_fkey" FOREIGN KEY ("discussion_thread") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_thread_likes"
    ADD CONSTRAINT "discussion_thread_likes_user_fkey" FOREIGN KEY ("creator") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."discussion_thread_read_status"
    ADD CONSTRAINT "discussion_thread_read_status_discussion_thread_id_fkey" FOREIGN KEY ("discussion_thread_id") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_thread_read_status"
    ADD CONSTRAINT "discussion_thread_read_status_discussion_thread_root_id_fkey" FOREIGN KEY ("discussion_thread_root_id") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_thread_read_status"
    ADD CONSTRAINT "discussion_thread_read_status_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id");



ALTER TABLE ONLY "public"."discussion_thread_watchers"
    ADD CONSTRAINT "discussion_thread_watchers_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."discussion_thread_watchers"
    ADD CONSTRAINT "discussion_thread_watchers_discussion_thread_root_id_fkey" FOREIGN KEY ("discussion_thread_root_id") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_thread_watchers"
    ADD CONSTRAINT "discussion_thread_watchers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "discussion_threads_answer_fkey" FOREIGN KEY ("answer") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "discussion_threads_root_fkey" FOREIGN KEY ("root") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "discussion_threads_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."discussion_topics"("id");



ALTER TABLE ONLY "public"."discussion_topics"
    ADD CONSTRAINT "discussion_topics_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."autograder"
    ADD CONSTRAINT "grader_configs_id_fkey" FOREIGN KEY ("id") REFERENCES "public"."assignments"("id");



ALTER TABLE ONLY "public"."grader_keys"
    ADD CONSTRAINT "grader_keys_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."grader_result_output"
    ADD CONSTRAINT "grader_result_output_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."grader_result_output"
    ADD CONSTRAINT "grader_result_output_grader_result_id_fkey" FOREIGN KEY ("grader_result_id") REFERENCES "public"."grader_results"("id");



ALTER TABLE ONLY "public"."grader_result_output"
    ADD CONSTRAINT "grader_result_output_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."grader_result_tests"
    ADD CONSTRAINT "grader_result_tests_grader_result_id_fkey" FOREIGN KEY ("grader_result_id") REFERENCES "public"."grader_results"("id");



ALTER TABLE ONLY "public"."grader_result_tests"
    ADD CONSTRAINT "grader_result_tests_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."grader_results"
    ADD CONSTRAINT "grader_results_autograder_regression_test_fkey" FOREIGN KEY ("autograder_regression_test") REFERENCES "public"."autograder_regression_test"("id");



ALTER TABLE ONLY "public"."grader_results"
    ADD CONSTRAINT "grader_results_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."grader_results"
    ADD CONSTRAINT "grader_results_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id");



ALTER TABLE ONLY "public"."grader_results"
    ADD CONSTRAINT "grader_results_user_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."grader_result_tests"
    ADD CONSTRAINT "grader_test_results_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."help_queues"
    ADD CONSTRAINT "help_queues_class_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."help_request_messages"
    ADD CONSTRAINT "help_request_messages_author_fkey1" FOREIGN KEY ("author") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."help_request_messages"
    ADD CONSTRAINT "help_request_messages_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."help_request_messages"
    ADD CONSTRAINT "help_request_messages_help_request_id_fkey" FOREIGN KEY ("help_request_id") REFERENCES "public"."help_requests"("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_assignee_fkey" FOREIGN KEY ("assignee") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_creator_fkey" FOREIGN KEY ("creator") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_help_queue_fkey" FOREIGN KEY ("help_queue") REFERENCES "public"."help_queues"("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."poll_question_answers"
    ADD CONSTRAINT "poll_question_answers_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."poll_question_answers"
    ADD CONSTRAINT "poll_question_answers_poll_fkey" FOREIGN KEY ("poll") REFERENCES "public"."polls"("id");



ALTER TABLE ONLY "public"."poll_question_answers"
    ADD CONSTRAINT "poll_question_answers_poll_question_fkey" FOREIGN KEY ("poll_question") REFERENCES "public"."poll_questions"("id");



ALTER TABLE ONLY "public"."poll_question_results"
    ADD CONSTRAINT "poll_question_results_poll_fkey" FOREIGN KEY ("poll") REFERENCES "public"."polls"("id");



ALTER TABLE ONLY "public"."poll_question_results"
    ADD CONSTRAINT "poll_question_results_poll_question_answer_fkey" FOREIGN KEY ("poll_question_answer") REFERENCES "public"."poll_question_answers"("id");



ALTER TABLE ONLY "public"."poll_question_results"
    ADD CONSTRAINT "poll_question_results_poll_question_fkey" FOREIGN KEY ("poll_question") REFERENCES "public"."poll_questions"("id");



ALTER TABLE ONLY "public"."poll_questions"
    ADD CONSTRAINT "poll_questions_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."poll_questions"
    ADD CONSTRAINT "poll_questions_poll_fkey" FOREIGN KEY ("poll") REFERENCES "public"."polls"("id");



ALTER TABLE ONLY "public"."poll_response_answers"
    ADD CONSTRAINT "poll_response_answers_poll_fkey" FOREIGN KEY ("poll") REFERENCES "public"."polls"("id");



ALTER TABLE ONLY "public"."poll_response_answers"
    ADD CONSTRAINT "poll_response_answers_poll_question_answer_fkey" FOREIGN KEY ("poll_question_answer") REFERENCES "public"."poll_question_answers"("id");



ALTER TABLE ONLY "public"."poll_response_answers"
    ADD CONSTRAINT "poll_response_answers_poll_question_fkey" FOREIGN KEY ("poll_question") REFERENCES "public"."poll_questions"("id");



ALTER TABLE ONLY "public"."poll_response_answers"
    ADD CONSTRAINT "poll_response_answers_poll_response_fkey" FOREIGN KEY ("poll_response") REFERENCES "public"."poll_responses"("id");



ALTER TABLE ONLY "public"."poll_response_answers"
    ADD CONSTRAINT "poll_response_answers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."poll_responses"
    ADD CONSTRAINT "poll_responses_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."poll_responses"
    ADD CONSTRAINT "poll_responses_poll_fkey" FOREIGN KEY ("poll") REFERENCES "public"."polls"("id");



ALTER TABLE ONLY "public"."poll_responses"
    ADD CONSTRAINT "poll_responses_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."polls"
    ADD CONSTRAINT "polls_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."repositories"
    ADD CONSTRAINT "repositories_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id");



ALTER TABLE ONLY "public"."repositories"
    ADD CONSTRAINT "repositories_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."repositories"
    ADD CONSTRAINT "repositories_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."user_roles"("private_profile_id");



ALTER TABLE ONLY "public"."repositories"
    ADD CONSTRAINT "repositories_user_id_fkey1" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissio_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id");



ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissio_user_id_fkey1" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."submission_file_comments"
    ADD CONSTRAINT "submission_file_comments_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."submission_file_comments"
    ADD CONSTRAINT "submission_file_lcomments_author_fkey" FOREIGN KEY ("author") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."submission_file_comments"
    ADD CONSTRAINT "submission_file_lcomments_submission_files_id_fkey" FOREIGN KEY ("submission_files_id") REFERENCES "public"."submission_files"("id");



ALTER TABLE ONLY "public"."submission_file_comments"
    ADD CONSTRAINT "submission_file_lcomments_submissions_id_fkey" FOREIGN KEY ("submissions_id") REFERENCES "public"."submissions"("id");



ALTER TABLE ONLY "public"."submission_files"
    ADD CONSTRAINT "submission_files_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."submission_files"
    ADD CONSTRAINT "submission_files_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."user_roles"("private_profile_id");



ALTER TABLE ONLY "public"."submission_files"
    ADD CONSTRAINT "submission_files_submissions_id_fkey" FOREIGN KEY ("submissions_id") REFERENCES "public"."submissions"("id");



ALTER TABLE ONLY "public"."submission_files"
    ADD CONSTRAINT "submission_files_user_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissions_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."user_roles"("private_profile_id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_private_profile_id_fkey" FOREIGN KEY ("private_profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_public_profile_id_fkey" FOREIGN KEY ("public_profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey1" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id");



ALTER TABLE ONLY "public"."video_meeting_sessions"
    ADD CONSTRAINT "video_meeting_sessions_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."video_meeting_sessions"
    ADD CONSTRAINT "video_meeting_sessions_help_request_id_fkey" FOREIGN KEY ("help_request_id") REFERENCES "public"."help_requests"("id");



CREATE POLICY "Allow auth admin to read user roles" ON "public"."user_roles" FOR SELECT TO "supabase_auth_admin" USING (true);



CREATE POLICY "CRUD by uid" ON "public"."discussion_thread_read_status" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "CRUD for own only" ON "public"."discussion_thread_likes" USING ("public"."authorizeforprofile"("creator"));



CREATE POLICY "CRUD for self" ON "public"."discussion_thread_watchers" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "CRUD for self" ON "public"."notifications" USING ((( SELECT "auth"."uid"() AS "uid") = "user_id"));



CREATE POLICY "Enable users to view their own data only" ON "public"."user_roles" FOR SELECT TO "authenticated" USING (((( SELECT "auth"."uid"() AS "uid") = "user_id") OR "public"."authorizeforclassinstructor"(("class_id")::bigint)));



CREATE POLICY "Instructors can do anything" ON "public"."help_queues" USING ("public"."authorizeforclassinstructor"("class_id"));



CREATE POLICY "Instructors can view all submissions in class, students can vie" ON "public"."submissions" FOR SELECT USING (("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"("profile_id")));



CREATE POLICY "Read if in in class" ON "public"."classes" FOR SELECT USING (( SELECT "public"."authorizeforclass"("classes"."id") AS "authorizeforclass"));



CREATE POLICY "View in same class" ON "public"."profiles" FOR SELECT TO "authenticated" USING ("public"."authorizeforclass"("class_id"));



CREATE POLICY "Visible to everyone in class" ON "public"."help_queues" FOR SELECT USING ("public"."authorizeforclass"("class_id"));



ALTER TABLE "public"."assignments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "authorizeForPoll" ON "public"."poll_question_answers" FOR SELECT USING ("public"."authorizeforpoll"("poll"));



CREATE POLICY "authorizeForPoll" ON "public"."poll_question_results" FOR SELECT USING ("public"."authorizeforpoll"("poll"));



CREATE POLICY "authorizeForPoll" ON "public"."poll_questions" FOR SELECT USING ("public"."authorizeforpoll"("poll"));



CREATE POLICY "authorizeForPoll" ON "public"."polls" FOR SELECT USING ("public"."authorizeforpoll"("id"));



CREATE POLICY "authorizeForProfile" ON "public"."poll_responses" FOR SELECT USING ("public"."authorizeforprofile"("profile_id"));



CREATE POLICY "authorizeForProfile insert" ON "public"."poll_response_answers" FOR INSERT WITH CHECK ("public"."authorizeforprofile"("profile_id"));



CREATE POLICY "authorizeForProfile insert" ON "public"."poll_responses" FOR INSERT WITH CHECK ("public"."authorizeforprofile"("profile_id"));



CREATE POLICY "authorizeForProfile select" ON "public"."poll_response_answers" FOR SELECT USING ("public"."authorizeforprofile"("profile_id"));



ALTER TABLE "public"."autograder" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."autograder_regression_test" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "can only insert comments as self, for own files (instructors ca" ON "public"."submission_file_comments" FOR INSERT WITH CHECK (("public"."authorizeforprofile"("author") AND ("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"(( SELECT "submissions"."profile_id"
   FROM "public"."submissions"
  WHERE ("submissions"."id" = "submission_file_comments"."submissions_id"))))));



ALTER TABLE "public"."classes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discussion_thread_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discussion_thread_read_status" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discussion_thread_watchers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discussion_threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discussion_topics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."grader_keys" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."grader_result_output" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."grader_result_tests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."grader_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."help_queues" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."help_request_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."help_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insert authorizeForClassInstructor" ON "public"."polls" FOR INSERT WITH CHECK ("public"."authorizeforclassinstructor"("class_id"));



CREATE POLICY "insert for own class" ON "public"."help_requests" FOR INSERT WITH CHECK (("public"."authorizeforclass"("class_id") AND "public"."authorizeforprofile"("creator") AND ("assignee" IS NULL)));



CREATE POLICY "insert for self in class" ON "public"."help_request_messages" FOR INSERT WITH CHECK (("public"."authorizeforclass"("class_id") AND "public"."authorizeforprofile"("author")));



CREATE POLICY "insert own only" ON "public"."discussion_threads" FOR INSERT WITH CHECK (("public"."authorizeforclass"("class_id") AND "public"."authorizeforprofile"("author")));



CREATE POLICY "instructors CRUD" ON "public"."rubrics" USING ("public"."authorizeforclassinstructor"("class_id"));



CREATE POLICY "instructors and students can view" ON "public"."repositories" FOR SELECT USING (("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"("profile_id")));



CREATE POLICY "instructors can read and edit in class" ON "public"."assignments" USING (( SELECT "public"."authorizeforclassinstructor"("assignments"."class_id") AS "authorizeforclass"));



CREATE POLICY "instructors can update" ON "public"."help_requests" FOR UPDATE USING ("public"."authorizeforclassinstructor"("class_id"));



CREATE POLICY "instructors insert" ON "public"."poll_question_answers" FOR INSERT WITH CHECK ("public"."authorizeforclassinstructor"("class_id"));



CREATE POLICY "instructors insert" ON "public"."poll_questions" FOR INSERT WITH CHECK ("public"."authorizeforclassinstructor"("class_id"));



CREATE POLICY "instructors rw" ON "public"."autograder" USING ("public"."authorizeforclassinstructor"(( SELECT "assignments"."class_id"
   FROM "public"."assignments"
  WHERE ("assignments"."id" = "autograder"."id"))));



CREATE POLICY "instructors rw" ON "public"."autograder_regression_test" USING ("public"."authorizeforclassinstructor"(( SELECT "assignments"."class_id"
   FROM "public"."assignments"
  WHERE ("assignments"."id" = "autograder_regression_test"."autograder_id"))));



CREATE POLICY "instructors view all, students own" ON "public"."submission_files" FOR SELECT USING (("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"("profile_id")));



CREATE POLICY "instructors view all, students view own" ON "public"."help_request_messages" FOR SELECT USING (("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"("author") OR "public"."authorizeforprofile"("requestor")));



ALTER TABLE "public"."name_generation_words" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."poll_question_answers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."poll_question_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."poll_questions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."poll_response_answers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."poll_responses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."polls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "read assignments in own class regardless of release date" ON "public"."assignments" FOR SELECT USING ("public"."authorizeforclass"("class_id"));



ALTER TABLE "public"."repositories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."rubrics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "self updates, or instructor" ON "public"."discussion_threads" FOR UPDATE USING (("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"("author")));



CREATE POLICY "students can set resolved" ON "public"."help_requests" FOR UPDATE USING (("public"."authorizeforprofile"("creator") AND ("resolved_by" IS NULL)));



CREATE POLICY "students view all non-private in their class, instructors view " ON "public"."discussion_threads" FOR SELECT USING ((("public"."authorizeforclass"("class_id") AND ("instructors_only" = false)) OR "public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"("author")));



CREATE POLICY "students view own, instructors view all" ON "public"."help_requests" FOR SELECT USING (("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"("creator")));



CREATE POLICY "students view own, instructors view all" ON "public"."submission_file_comments" FOR SELECT USING (("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"(( SELECT "submissions"."profile_id"
   FROM "public"."submissions"
  WHERE ("submissions"."id" = "submission_file_comments"."submissions_id")))));



ALTER TABLE "public"."submission_file_comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."submission_files" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."submissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."users" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."video_meeting_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "view in class" ON "public"."discussion_topics" FOR SELECT USING ("public"."authorizeforclass"("class_id"));



CREATE POLICY "view in class" ON "public"."video_meeting_sessions" FOR SELECT USING ("public"."authorizeforclass"("class_id"));



CREATE POLICY "view own, instructors also view all that they instruct" ON "public"."users" FOR SELECT USING ((("user_id" = "auth"."uid"()) OR "public"."authorizeforinstructorofstudent"("user_id")));



CREATE POLICY "visible to instructors always, and self conditionally" ON "public"."grader_result_output" FOR SELECT USING (("public"."authorizeforclassinstructor"("class_id") OR ("public"."authorizeforprofile"("student_id") AND ("visibility" = 'visible'::"public"."feedback_visibility"))));



CREATE POLICY "visible to instructors and self" ON "public"."grader_result_tests" FOR SELECT USING (("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"("student_id")));



CREATE POLICY "visible to instructors and self" ON "public"."grader_results" FOR SELECT USING (("public"."authorizeforclassinstructor"("class_id") OR "public"."authorizeforprofile"("profile_id")));





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."autograder_regression_test";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."discussion_thread_likes";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."discussion_thread_read_status";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."discussion_thread_watchers";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."discussion_threads";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."help_queues";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."help_request_messages";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."help_requests";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."notifications";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."poll_question_answers";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."poll_question_results";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."poll_questions";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."submission_file_comments";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";




















































































































































































GRANT ALL ON FUNCTION "public"."assignment_before_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."assignment_before_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assignment_before_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."assignments_grader_config_auto_populate"() TO "anon";
GRANT ALL ON FUNCTION "public"."assignments_grader_config_auto_populate"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assignments_grader_config_auto_populate"() TO "service_role";



GRANT ALL ON FUNCTION "public"."authorizeforclass"("class__id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."authorizeforclass"("class__id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorizeforclass"("class__id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."authorizeforinstructorofstudent"("user_id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."authorizeforinstructorofstudent"("user_id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorizeforinstructorofstudent"("user_id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."authorizeforinstructorofstudent"("_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."authorizeforinstructorofstudent"("_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorizeforinstructorofstudent"("_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."authorizeforpoll"("poll__id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."authorizeforpoll"("poll__id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorizeforpoll"("poll__id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."authorizeforpoll"("poll__id" bigint, "class__id" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."authorizeforpoll"("poll__id" bigint, "class__id" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorizeforpoll"("poll__id" bigint, "class__id" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."authorizeforprofile"("profile_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."authorizeforprofile"("profile_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."authorizeforprofile"("profile_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "supabase_auth_admin";



GRANT ALL ON FUNCTION "public"."discussion_thread_root_patch"() TO "anon";
GRANT ALL ON FUNCTION "public"."discussion_thread_root_patch"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."discussion_thread_root_patch"() TO "service_role";



GRANT ALL ON FUNCTION "public"."discussion_thread_set_ordinal"() TO "anon";
GRANT ALL ON FUNCTION "public"."discussion_thread_set_ordinal"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."discussion_thread_set_ordinal"() TO "service_role";



GRANT ALL ON FUNCTION "public"."discussion_threads_notification"() TO "anon";
GRANT ALL ON FUNCTION "public"."discussion_threads_notification"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."discussion_threads_notification"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_anon_name"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_anon_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_anon_name"() TO "service_role";



GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("email" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("email" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_user_id_by_email"("email" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."intval"(character varying) TO "anon";
GRANT ALL ON FUNCTION "public"."intval"(character varying) TO "authenticated";
GRANT ALL ON FUNCTION "public"."intval"(character varying) TO "service_role";



GRANT ALL ON FUNCTION "public"."is_allowed_grader_key"("graderkey" "text", "class" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."is_allowed_grader_key"("graderkey" "text", "class" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_allowed_grader_key"("graderkey" "text", "class" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."is_in_class"("userid" "uuid", "classid" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."is_in_class"("userid" "uuid", "classid" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_in_class"("userid" "uuid", "classid" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "_class_id" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "_class_id" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "_class_id" integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "classid" bigint) TO "anon";
GRANT ALL ON FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "classid" bigint) TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_instructor_for_class"("_person_id" "uuid", "classid" bigint) TO "service_role";



GRANT ALL ON FUNCTION "public"."is_instructor_for_student"("_person_id" "uuid", "_student_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_instructor_for_student"("_person_id" "uuid", "_student_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_instructor_for_student"("_person_id" "uuid", "_student_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."poll_question_answer_ins_del"() TO "anon";
GRANT ALL ON FUNCTION "public"."poll_question_answer_ins_del"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."poll_question_answer_ins_del"() TO "service_role";



GRANT ALL ON FUNCTION "public"."poll_response_answers_ins_del_upd"() TO "anon";
GRANT ALL ON FUNCTION "public"."poll_response_answers_ins_del_upd"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."poll_response_answers_ins_del_upd"() TO "service_role";



GRANT ALL ON FUNCTION "public"."remove_github_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."remove_github_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."remove_github_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."submissions_insert_hook"() TO "anon";
GRANT ALL ON FUNCTION "public"."submissions_insert_hook"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."submissions_insert_hook"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_children_count"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_children_count"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_children_count"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_github_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_github_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_github_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_thread_likes"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_thread_likes"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_thread_likes"() TO "service_role";



GRANT ALL ON FUNCTION "public"."user_register_create_demo_account"() TO "anon";
GRANT ALL ON FUNCTION "public"."user_register_create_demo_account"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."user_register_create_demo_account"() TO "service_role";


















GRANT ALL ON TABLE "public"."rubrics" TO "anon";
GRANT ALL ON TABLE "public"."rubrics" TO "authenticated";
GRANT ALL ON TABLE "public"."rubrics" TO "service_role";



GRANT ALL ON SEQUENCE "public"."assignment_rubric_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."assignment_rubric_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."assignment_rubric_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."assignments" TO "anon";
GRANT ALL ON TABLE "public"."assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."assignments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."assignments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."assignments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."assignments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."autograder" TO "anon";
GRANT ALL ON TABLE "public"."autograder" TO "authenticated";
GRANT ALL ON TABLE "public"."autograder" TO "service_role";



GRANT ALL ON TABLE "public"."autograder_regression_test" TO "anon";
GRANT ALL ON TABLE "public"."autograder_regression_test" TO "authenticated";
GRANT ALL ON TABLE "public"."autograder_regression_test" TO "service_role";



GRANT ALL ON TABLE "public"."grader_results" TO "anon";
GRANT ALL ON TABLE "public"."grader_results" TO "authenticated";
GRANT ALL ON TABLE "public"."grader_results" TO "service_role";



GRANT ALL ON TABLE "public"."submissions" TO "anon";
GRANT ALL ON TABLE "public"."submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."submissions" TO "service_role";



GRANT ALL ON TABLE "public"."autograder_regression_test_by_grader" TO "anon";
GRANT ALL ON TABLE "public"."autograder_regression_test_by_grader" TO "authenticated";
GRANT ALL ON TABLE "public"."autograder_regression_test_by_grader" TO "service_role";



GRANT ALL ON SEQUENCE "public"."autograder_regression_test_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."autograder_regression_test_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."autograder_regression_test_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."classes" TO "anon";
GRANT ALL ON TABLE "public"."classes" TO "authenticated";
GRANT ALL ON TABLE "public"."classes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."classes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."classes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."classes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."discussion_threads" TO "anon";
GRANT ALL ON TABLE "public"."discussion_threads" TO "authenticated";
GRANT ALL ON TABLE "public"."discussion_threads" TO "service_role";



GRANT ALL ON SEQUENCE "public"."dicussion_threads_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."dicussion_threads_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."dicussion_threads_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."discussion_thread_likes" TO "anon";
GRANT ALL ON TABLE "public"."discussion_thread_likes" TO "authenticated";
GRANT ALL ON TABLE "public"."discussion_thread_likes" TO "service_role";



GRANT ALL ON SEQUENCE "public"."discussion_thread_likes_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."discussion_thread_likes_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."discussion_thread_likes_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."discussion_thread_read_status" TO "anon";
GRANT ALL ON TABLE "public"."discussion_thread_read_status" TO "authenticated";
GRANT ALL ON TABLE "public"."discussion_thread_read_status" TO "service_role";



GRANT ALL ON SEQUENCE "public"."discussion_thread_read_status_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."discussion_thread_read_status_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."discussion_thread_read_status_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."discussion_thread_watchers" TO "anon";
GRANT ALL ON TABLE "public"."discussion_thread_watchers" TO "authenticated";
GRANT ALL ON TABLE "public"."discussion_thread_watchers" TO "service_role";



GRANT ALL ON SEQUENCE "public"."discussion_thread_watchers_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."discussion_thread_watchers_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."discussion_thread_watchers_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."discussion_topics" TO "anon";
GRANT ALL ON TABLE "public"."discussion_topics" TO "authenticated";
GRANT ALL ON TABLE "public"."discussion_topics" TO "service_role";



GRANT ALL ON SEQUENCE "public"."discussion_topics_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."discussion_topics_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."discussion_topics_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."grader_keys" TO "anon";
GRANT ALL ON TABLE "public"."grader_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."grader_keys" TO "service_role";



GRANT ALL ON SEQUENCE "public"."grader_keys_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."grader_keys_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."grader_keys_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."grader_result_output" TO "anon";
GRANT ALL ON TABLE "public"."grader_result_output" TO "authenticated";
GRANT ALL ON TABLE "public"."grader_result_output" TO "service_role";



GRANT ALL ON SEQUENCE "public"."grader_result_output_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."grader_result_output_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."grader_result_output_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."grader_result_tests" TO "anon";
GRANT ALL ON TABLE "public"."grader_result_tests" TO "authenticated";
GRANT ALL ON TABLE "public"."grader_result_tests" TO "service_role";



GRANT ALL ON SEQUENCE "public"."grader_results_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."grader_results_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."grader_results_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."grader_test_results_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."grader_test_results_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."grader_test_results_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."help_queues" TO "anon";
GRANT ALL ON TABLE "public"."help_queues" TO "authenticated";
GRANT ALL ON TABLE "public"."help_queues" TO "service_role";



GRANT ALL ON SEQUENCE "public"."help_queues_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."help_queues_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."help_queues_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."help_request_messages" TO "anon";
GRANT ALL ON TABLE "public"."help_request_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."help_request_messages" TO "service_role";



GRANT ALL ON SEQUENCE "public"."help_request_messages_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."help_request_messages_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."help_request_messages_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."help_requests" TO "anon";
GRANT ALL ON TABLE "public"."help_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."help_requests" TO "service_role";



GRANT ALL ON SEQUENCE "public"."help_requests_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."help_requests_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."help_requests_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."name_generation_words" TO "anon";
GRANT ALL ON TABLE "public"."name_generation_words" TO "authenticated";
GRANT ALL ON TABLE "public"."name_generation_words" TO "service_role";



GRANT ALL ON SEQUENCE "public"."name_generation_words_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."name_generation_words_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."name_generation_words_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."notifications_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."permissions" TO "anon";
GRANT ALL ON TABLE "public"."permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."permissions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."permissions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."permissions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."permissions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."poll_question_answers" TO "anon";
GRANT ALL ON TABLE "public"."poll_question_answers" TO "authenticated";
GRANT ALL ON TABLE "public"."poll_question_answers" TO "service_role";



GRANT ALL ON SEQUENCE "public"."poll_question_answers_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."poll_question_answers_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."poll_question_answers_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."poll_question_results" TO "anon";
GRANT ALL ON TABLE "public"."poll_question_results" TO "authenticated";
GRANT ALL ON TABLE "public"."poll_question_results" TO "service_role";



GRANT ALL ON SEQUENCE "public"."poll_question_results_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."poll_question_results_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."poll_question_results_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."poll_questions" TO "anon";
GRANT ALL ON TABLE "public"."poll_questions" TO "authenticated";
GRANT ALL ON TABLE "public"."poll_questions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."poll_questions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."poll_questions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."poll_questions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."poll_response_answers" TO "anon";
GRANT ALL ON TABLE "public"."poll_response_answers" TO "authenticated";
GRANT ALL ON TABLE "public"."poll_response_answers" TO "service_role";



GRANT ALL ON SEQUENCE "public"."poll_response_answers_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."poll_response_answers_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."poll_response_answers_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."poll_responses" TO "anon";
GRANT ALL ON TABLE "public"."poll_responses" TO "authenticated";
GRANT ALL ON TABLE "public"."poll_responses" TO "service_role";



GRANT ALL ON SEQUENCE "public"."poll_responses_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."poll_responses_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."poll_responses_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."polls" TO "anon";
GRANT ALL ON TABLE "public"."polls" TO "authenticated";
GRANT ALL ON TABLE "public"."polls" TO "service_role";



GRANT ALL ON SEQUENCE "public"."polls_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."polls_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."polls_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."repositories" TO "anon";
GRANT ALL ON TABLE "public"."repositories" TO "authenticated";
GRANT ALL ON TABLE "public"."repositories" TO "service_role";



GRANT ALL ON SEQUENCE "public"."repositories_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."repositories_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."repositories_id_seq" TO "service_role";



GRANT ALL ON SEQUENCE "public"."submissio_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."submissio_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."submissio_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."submission_file_comments" TO "anon";
GRANT ALL ON TABLE "public"."submission_file_comments" TO "authenticated";
GRANT ALL ON TABLE "public"."submission_file_comments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."submission_file_lcomments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."submission_file_lcomments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."submission_file_lcomments_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."submission_files" TO "anon";
GRANT ALL ON TABLE "public"."submission_files" TO "authenticated";
GRANT ALL ON TABLE "public"."submission_files" TO "service_role";



GRANT ALL ON SEQUENCE "public"."submission_files_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."submission_files_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."submission_files_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."submissions_agg" TO "anon";
GRANT ALL ON TABLE "public"."submissions_agg" TO "authenticated";
GRANT ALL ON TABLE "public"."submissions_agg" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "service_role";
GRANT ALL ON TABLE "public"."user_roles" TO "supabase_auth_admin";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";



GRANT ALL ON SEQUENCE "public"."user_roles_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."user_roles_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."user_roles_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."users" TO "anon";
GRANT ALL ON TABLE "public"."users" TO "authenticated";
GRANT ALL ON TABLE "public"."users" TO "service_role";



GRANT ALL ON TABLE "public"."video_meeting_sessions" TO "anon";
GRANT ALL ON TABLE "public"."video_meeting_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."video_meeting_sessions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."video_meeting_sessions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."video_meeting_sessions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."video_meeting_sessions_id_seq" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS  TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES  TO "service_role";




























CREATE TRIGGER create_user_ensure_profiles_and_demo AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.user_register_create_demo_account();

CREATE OR REPLACE TRIGGER update_github_profile_trigger
AFTER INSERT ON auth.identities
FOR EACH ROW
EXECUTE FUNCTION public.update_github_profile();


RESET ALL;
