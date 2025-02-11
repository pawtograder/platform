

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


CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium";






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



CREATE OR REPLACE FUNCTION "public"."custom_access_token_hook"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plv8" STABLE
    AS $_$var user_roles;

  // Fetch the current user's user_role from the public user_roles table.
  var result = plv8.execute("select role, class_id from public.user_roles where user_id = $1", [event.user_id]);
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
      WHERE  t.id = OLD.root AND OLD.draft = false;
      UPDATE discussion_threads AS t
      SET    children_count = t.children_count - 1
      WHERE  t.id = OLD.parent AND t.id != OLD.root AND OLD.draft=false;
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
    AS $$ BEGIN UPDATE public.profiles set
github_username=json_extract_path_text(to_json(NEW.identity_data),'user_name')
where id=NEW.user_id;
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

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."assignments" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "class_id" bigint,
    "title" "text",
    "release_date" timestamp with time zone,
    "due_date" timestamp with time zone,
    "latest_due_date" timestamp with time zone,
    "student_repo_prefix" "text",
    "template_repo" "json",
    "total_points" numeric,
    "has_autograder" boolean,
    "has_handgrader" boolean,
    "description" "text",
    "allow_late" boolean,
    "slug" "text",
    "submission_files" "json" DEFAULT '[]'::"json" NOT NULL
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



CREATE TABLE IF NOT EXISTS "public"."classes" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "semester" smallint,
    "canvas_id" integer,
    "time_zone" "text",
    "slug" "text"
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
    "class" bigint NOT NULL,
    "parent" bigint,
    "root" bigint,
    "draft" boolean DEFAULT false NOT NULL,
    "likes_count" bigint DEFAULT '0'::bigint NOT NULL,
    "children_count" bigint DEFAULT '0'::bigint NOT NULL,
    "root_class_id" bigint
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
    "user" "uuid" NOT NULL
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



CREATE TABLE IF NOT EXISTS "public"."discussion_topics" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "class_id" bigint,
    "topic" "text",
    "color" "text",
    "allowed_modes" "public"."allowed_modes"[]
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



CREATE TABLE IF NOT EXISTS "public"."grader_configs" (
    "assignment_id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "grader_repo" "text",
    "workflow_sha" "text",
    "config" "json" NOT NULL,
    "grader_commit_sha" "text"
);


ALTER TABLE "public"."grader_configs" OWNER TO "postgres";


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



CREATE TABLE IF NOT EXISTS "public"."grader_results" (
    "submission_id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "output" "text",
    "errors" "json",
    "grader_sha" "text",
    "feedback" "json",
    "score" smallint NOT NULL,
    "ret_code" smallint,
    "execution_time" double precision,
    "published" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."grader_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."help_queues" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "class" bigint NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "available" boolean DEFAULT false NOT NULL,
    "closing_at" timestamp without time zone
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



CREATE TABLE IF NOT EXISTS "public"."help_requests" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "help_queue" bigint NOT NULL,
    "creator" "uuid" NOT NULL,
    "request" "text" NOT NULL,
    "followup_to" bigint,
    "help_started_at" timestamp without time zone,
    "help_ended_at" timestamp without time zone,
    "helper" "uuid"
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



CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "name" "text",
    "sis_user_id" "text",
    "time_zone" "text",
    "sortable_name" "text",
    "short_name" "text",
    "avatar_url" "text",
    "github_username" "text"
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."public_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "username" "text" NOT NULL
);


ALTER TABLE "public"."public_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."repositories" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assignment_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "repository" "text" NOT NULL
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



CREATE TABLE IF NOT EXISTS "public"."submissions" (
    "id" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assignment_id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "released" timestamp without time zone,
    "sha" "text" NOT NULL,
    "repository" "text" NOT NULL,
    "run_attempt" bigint NOT NULL,
    "run_number" bigint NOT NULL,
    "class_id" bigint
);


ALTER TABLE "public"."submissions" OWNER TO "postgres";


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
    "class_id" bigint NOT NULL
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
    "s"."user_id",
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
          GROUP BY "submissions"."assignment_id", "submissions"."user_id") "c"
     JOIN "public"."submissions" "s" ON (("s"."id" = "c"."latestsubmissionid")))
     LEFT JOIN "public"."grader_results" "g" ON (("g"."submission_id" = "s"."id")));


ALTER TABLE "public"."submissions_agg" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" bigint NOT NULL,
    "user_id" "uuid" NOT NULL,
    "class_id" integer,
    "role" "public"."app_role" NOT NULL,
    "canvas_id" numeric
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



ALTER TABLE ONLY "public"."assignments"
    ADD CONSTRAINT "assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."classes"
    ADD CONSTRAINT "classes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "dicussion_threads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discussion_thread_likes"
    ADD CONSTRAINT "discussion_thread_likes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."discussion_topics"
    ADD CONSTRAINT "discussion_topics_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."grader_configs"
    ADD CONSTRAINT "grader_configs_id_key" UNIQUE ("assignment_id");



ALTER TABLE ONLY "public"."grader_configs"
    ADD CONSTRAINT "grader_configs_pkey" PRIMARY KEY ("assignment_id");



ALTER TABLE ONLY "public"."grader_keys"
    ADD CONSTRAINT "grader_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."grader_results"
    ADD CONSTRAINT "grader_results_id_key" UNIQUE ("submission_id");



ALTER TABLE ONLY "public"."grader_results"
    ADD CONSTRAINT "grader_results_pkey" PRIMARY KEY ("submission_id");



ALTER TABLE ONLY "public"."help_queues"
    ADD CONSTRAINT "help_queues_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_key" UNIQUE ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_sis_user_id_key" UNIQUE ("sis_user_id");



ALTER TABLE ONLY "public"."public_profiles"
    ADD CONSTRAINT "public_profiles_pkey" PRIMARY KEY ("id");



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
    ADD CONSTRAINT "user_roles_user_id_role_key" UNIQUE ("user_id", "role");



CREATE UNIQUE INDEX "discussion_thread_likes_discussion_thread_user_idx" ON "public"."discussion_thread_likes" USING "btree" ("discussion_thread", "user");



CREATE INDEX "discussion_threads_root_idx" ON "public"."discussion_threads" USING "hash" ("root");



CREATE INDEX "submission_files_submissions_id_idx" ON "public"."submission_files" USING "hash" ("submissions_id");



CREATE OR REPLACE TRIGGER "discussion_threads_children_ins_del" BEFORE INSERT OR DELETE OR UPDATE ON "public"."discussion_threads" FOR EACH ROW EXECUTE FUNCTION "public"."update_children_count"();



CREATE OR REPLACE TRIGGER "discussion_threads_likes_count" BEFORE INSERT OR DELETE ON "public"."discussion_thread_likes" FOR EACH ROW EXECUTE FUNCTION "public"."update_thread_likes"();



ALTER TABLE ONLY "public"."assignments"
    ADD CONSTRAINT "assignments_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "dicussion_threads_author_fkey" FOREIGN KEY ("author") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "dicussion_threads_class_fkey" FOREIGN KEY ("class") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "dicussion_threads_parent_fkey" FOREIGN KEY ("parent") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_thread_likes"
    ADD CONSTRAINT "discussion_thread_likes_discussion_thread_fkey" FOREIGN KEY ("discussion_thread") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_thread_likes"
    ADD CONSTRAINT "discussion_thread_likes_user_fkey" FOREIGN KEY ("user") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "discussion_threads_author_fkey" FOREIGN KEY ("author") REFERENCES "public"."public_profiles"("id");



ALTER TABLE ONLY "public"."discussion_threads"
    ADD CONSTRAINT "discussion_threads_root_fkey" FOREIGN KEY ("root") REFERENCES "public"."discussion_threads"("id");



ALTER TABLE ONLY "public"."discussion_topics"
    ADD CONSTRAINT "discussion_topics_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."grader_configs"
    ADD CONSTRAINT "grader_configs_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id");



ALTER TABLE ONLY "public"."grader_keys"
    ADD CONSTRAINT "grader_keys_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."help_queues"
    ADD CONSTRAINT "help_queues_class_fkey" FOREIGN KEY ("class") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_creator_fkey" FOREIGN KEY ("creator") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_help_queue_fkey" FOREIGN KEY ("help_queue") REFERENCES "public"."help_queues"("id");



ALTER TABLE ONLY "public"."help_requests"
    ADD CONSTRAINT "help_requests_helper_fkey" FOREIGN KEY ("helper") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."permissions"
    ADD CONSTRAINT "permissions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."public_profiles"
    ADD CONSTRAINT "public_profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."repositories"
    ADD CONSTRAINT "repositories_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id");



ALTER TABLE ONLY "public"."repositories"
    ADD CONSTRAINT "repositories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."repositories"
    ADD CONSTRAINT "repositories_user_id_fkey1" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissio_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "public"."assignments"("id");



ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissio_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissio_user_id_fkey1" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."submission_file_comments"
    ADD CONSTRAINT "submission_file_comments_author_fkey" FOREIGN KEY ("author") REFERENCES "public"."public_profiles"("id");



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
    ADD CONSTRAINT "submission_files_submissions_id_fkey" FOREIGN KEY ("submissions_id") REFERENCES "public"."submissions"("id");



ALTER TABLE ONLY "public"."submissions"
    ADD CONSTRAINT "submissions_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "public"."classes"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey1" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id");



CREATE POLICY "Allow auth admin to read user roles" ON "public"."user_roles" FOR SELECT TO "supabase_auth_admin" USING (true);



CREATE POLICY "Enable users to view their own data only" ON "public"."user_roles" FOR SELECT TO "authenticated" USING (((( SELECT "auth"."uid"() AS "uid") = "user_id") OR "public"."is_instructor_for_class"("auth"."uid"(), "class_id")));



CREATE POLICY "Enable users to view their own data, Instructors view students" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("public"."is_instructor_for_student"(( SELECT "auth"."uid"() AS "uid"), "id") OR ("auth"."uid"() = "id")));



CREATE POLICY "Instructors can do anything" ON "public"."help_queues" USING ("public"."is_instructor_for_class"("auth"."uid"(), "class"));



CREATE POLICY "Instructors can view all submissions in class, students can vie" ON "public"."submissions" FOR SELECT USING (("public"."is_instructor_for_student"(( SELECT "auth"."uid"() AS "uid"), "user_id") OR ("auth"."uid"() = "user_id")));



CREATE POLICY "Visible to everyone in class" ON "public"."help_queues" FOR SELECT USING (("class" IN ( SELECT "user_roles"."class_id"
   FROM "public"."user_roles"
  WHERE ("user_roles"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."assignments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "can only insert comments as self, for own files (instructors ca" ON "public"."submission_file_comments" FOR INSERT WITH CHECK ((("author" = "auth"."uid"()) AND ("submissions_id" IN ( SELECT "submissions"."id"
   FROM "public"."submissions"
  WHERE ("public"."is_instructor_for_student"(( SELECT "auth"."uid"() AS "uid"), "submissions"."user_id") OR ("auth"."uid"() = "submissions"."user_id"))))));



ALTER TABLE "public"."classes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "course members" ON "public"."classes" FOR SELECT USING (("id" IN ( SELECT "user_roles"."class_id"
   FROM "public"."user_roles"
  WHERE ("user_roles"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."discussion_thread_likes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discussion_threads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."discussion_topics" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."grader_configs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."grader_keys" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."grader_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."help_queues" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."help_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insert own only" ON "public"."discussion_threads" FOR INSERT WITH CHECK (("public"."is_in_class"("author", "class") AND ("author" = "auth"."uid"())));



CREATE POLICY "instructors and students can view" ON "public"."repositories" FOR SELECT USING (("public"."is_instructor_for_student"(( SELECT "auth"."uid"() AS "uid"), "user_id") OR ("auth"."uid"() = "user_id")));



CREATE POLICY "instructors can read and edit in class" ON "public"."assignments" USING (("class_id" IN ( SELECT "user_roles"."class_id"
   FROM "public"."user_roles"
  WHERE (("user_roles"."user_id" = "auth"."uid"()) AND ("user_roles"."role" = 'instructor'::"public"."app_role")))));



CREATE POLICY "instructors view all, students own" ON "public"."submission_files" FOR SELECT USING (("submissions_id" IN ( SELECT "submissions"."id"
   FROM "public"."submissions"
  WHERE ("public"."is_instructor_for_student"(( SELECT "auth"."uid"() AS "uid"), "submissions"."user_id") OR ("auth"."uid"() = "submissions"."user_id")))));



ALTER TABLE "public"."permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."public_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "read assignments in own class regardless of release date" ON "public"."assignments" FOR SELECT USING (("class_id" IN ( SELECT "user_roles"."class_id"
   FROM "public"."user_roles"
  WHERE ("user_roles"."user_id" = "auth"."uid"()))));



ALTER TABLE "public"."repositories" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "self updates, or instructor" ON "public"."discussion_threads" FOR UPDATE USING (("public"."is_instructor_for_class"("auth"."uid"(), "class") OR ("auth"."uid"() = "author")));



CREATE POLICY "students view all non-private in their class, instructors view " ON "public"."discussion_threads" FOR SELECT USING ((("public"."is_in_class"("auth"."uid"(), "class") AND ("instructors_only" = false)) OR ("public"."is_instructor_for_class"("auth"."uid"(), "class") OR ("auth"."uid"() = "author"))));



CREATE POLICY "students view own, instructors view all" ON "public"."submission_file_comments" FOR SELECT USING (("submissions_id" IN ( SELECT "submissions"."id"
   FROM "public"."submissions"
  WHERE ("public"."is_instructor_for_student"(( SELECT "auth"."uid"() AS "uid"), "submissions"."user_id") OR ("auth"."uid"() = "submissions"."user_id")))));



ALTER TABLE "public"."submission_file_comments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."submission_files" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."submissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "visible to instructors and self if released is true" ON "public"."grader_results" FOR SELECT USING (("submission_id" IN ( SELECT "submissions"."id"
   FROM "public"."submissions"
  WHERE ("public"."is_instructor_for_student"("auth"."uid"(), "submissions"."user_id") OR (("submissions"."user_id" = "auth"."uid"()) AND ("submissions"."released" IS NOT NULL))))));





-- ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


CREATE PUBLICATION "supabase_realtime_messages_publication" WITH (publish = 'insert, update, delete, truncate');


-- ALTER PUBLICATION "supabase_realtime_messages_publication" OWNER TO "supabase_admin";


ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."discussion_thread_likes";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."discussion_threads";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."submission_file_comments";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";
GRANT USAGE ON SCHEMA "public" TO "supabase_auth_admin";




















































































































































































REVOKE ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "supabase_auth_admin";



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



GRANT ALL ON FUNCTION "public"."update_children_count"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_children_count"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_children_count"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_github_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_github_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_github_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_thread_likes"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_thread_likes"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_thread_likes"() TO "service_role";


















GRANT ALL ON TABLE "public"."assignments" TO "anon";
GRANT ALL ON TABLE "public"."assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."assignments" TO "service_role";



GRANT ALL ON SEQUENCE "public"."assignments_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."assignments_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."assignments_id_seq" TO "service_role";



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



GRANT ALL ON TABLE "public"."discussion_topics" TO "anon";
GRANT ALL ON TABLE "public"."discussion_topics" TO "authenticated";
GRANT ALL ON TABLE "public"."discussion_topics" TO "service_role";



GRANT ALL ON SEQUENCE "public"."discussion_topics_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."discussion_topics_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."discussion_topics_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."grader_configs" TO "anon";
GRANT ALL ON TABLE "public"."grader_configs" TO "authenticated";
GRANT ALL ON TABLE "public"."grader_configs" TO "service_role";



GRANT ALL ON TABLE "public"."grader_keys" TO "anon";
GRANT ALL ON TABLE "public"."grader_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."grader_keys" TO "service_role";



GRANT ALL ON SEQUENCE "public"."grader_keys_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."grader_keys_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."grader_keys_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."grader_results" TO "anon";
GRANT ALL ON TABLE "public"."grader_results" TO "authenticated";
GRANT ALL ON TABLE "public"."grader_results" TO "service_role";



GRANT ALL ON TABLE "public"."help_queues" TO "anon";
GRANT ALL ON TABLE "public"."help_queues" TO "authenticated";
GRANT ALL ON TABLE "public"."help_queues" TO "service_role";



GRANT ALL ON SEQUENCE "public"."help_queues_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."help_queues_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."help_queues_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."help_requests" TO "anon";
GRANT ALL ON TABLE "public"."help_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."help_requests" TO "service_role";



GRANT ALL ON SEQUENCE "public"."help_requests_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."help_requests_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."help_requests_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."permissions" TO "anon";
GRANT ALL ON TABLE "public"."permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."permissions" TO "service_role";



GRANT ALL ON SEQUENCE "public"."permissions_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."permissions_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."permissions_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."public_profiles" TO "anon";
GRANT ALL ON TABLE "public"."public_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."public_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."repositories" TO "anon";
GRANT ALL ON TABLE "public"."repositories" TO "authenticated";
GRANT ALL ON TABLE "public"."repositories" TO "service_role";



GRANT ALL ON SEQUENCE "public"."repositories_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."repositories_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."repositories_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."submissions" TO "anon";
GRANT ALL ON TABLE "public"."submissions" TO "authenticated";
GRANT ALL ON TABLE "public"."submissions" TO "service_role";



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






























RESET ALL;
