drop trigger if exists "discussion_threads_patch_root" on "public"."discussion_threads";

drop policy "course members" on "public"."classes";

drop policy "Enable users to view their own data, Instructors view students" on "public"."profiles";

drop policy "update self" on "public"."profiles";

drop policy "view everyone" on "public"."public_profiles";

drop policy "instructors can read and edit in class" on "public"."assignments";

drop policy "read assignments in own class regardless of release date" on "public"."assignments";

drop policy "instructors rw" on "public"."autograder";

drop policy "instructors rw" on "public"."autograder_regression_test";

drop policy "CRUD for own only" on "public"."discussion_thread_likes";

drop policy "insert own only" on "public"."discussion_threads";

drop policy "self updates, or instructor" on "public"."discussion_threads";

drop policy "students view all non-private in their class, instructors view " on "public"."discussion_threads";

drop policy "view in class" on "public"."discussion_topics";

drop policy "visible to instructors always, and self conditionally" on "public"."grader_result_output";

drop policy "visible to instructors and self" on "public"."grader_result_tests";

drop policy "visible to instructors and self" on "public"."grader_results";

drop policy "Instructors can do anything" on "public"."help_queues";

drop policy "Visible to everyone in class" on "public"."help_queues";

drop policy "insert for self in class" on "public"."help_request_messages";

drop policy "instructors view all, students view own" on "public"."help_request_messages";

drop policy "insert for own class" on "public"."help_requests";

drop policy "instructors can update" on "public"."help_requests";

drop policy "students can set resolved" on "public"."help_requests";

drop policy "students view own, instructors view all" on "public"."help_requests";

drop policy "instructors and students can view" on "public"."repositories";

drop policy "instructors CRUD" on "public"."rubrics";

drop policy "can only insert comments as self, for own files (instructors ca" on "public"."submission_file_comments";

drop policy "students view own, instructors view all" on "public"."submission_file_comments";

drop policy "instructors view all, students own" on "public"."submission_files";

drop policy "Instructors can view all submissions in class, students can vie" on "public"."submissions";

drop policy "Enable users to view their own data only" on "public"."user_roles";

drop policy "view in class" on "public"."video_meeting_sessions";

revoke delete on table "public"."public_profiles" from "anon";

revoke insert on table "public"."public_profiles" from "anon";

revoke references on table "public"."public_profiles" from "anon";

revoke select on table "public"."public_profiles" from "anon";

revoke trigger on table "public"."public_profiles" from "anon";

revoke truncate on table "public"."public_profiles" from "anon";

revoke update on table "public"."public_profiles" from "anon";

revoke delete on table "public"."public_profiles" from "authenticated";

revoke insert on table "public"."public_profiles" from "authenticated";

revoke references on table "public"."public_profiles" from "authenticated";

revoke select on table "public"."public_profiles" from "authenticated";

revoke trigger on table "public"."public_profiles" from "authenticated";

revoke truncate on table "public"."public_profiles" from "authenticated";

revoke update on table "public"."public_profiles" from "authenticated";

revoke delete on table "public"."public_profiles" from "service_role";

revoke insert on table "public"."public_profiles" from "service_role";

revoke references on table "public"."public_profiles" from "service_role";

revoke select on table "public"."public_profiles" from "service_role";

revoke trigger on table "public"."public_profiles" from "service_role";

revoke truncate on table "public"."public_profiles" from "service_role";

revoke update on table "public"."public_profiles" from "service_role";

alter table "public"."discussion_threads" drop constraint "discussion_threads_author_fkey";

alter table "public"."help_request_messages" drop constraint "help_request_messages_author_fkey";

alter table "public"."help_request_messages" drop constraint "help_request_messages_requestor_fkey";

alter table "public"."profiles" drop constraint "profiles_id_fkey";

alter table "public"."public_profiles" drop constraint "public_profiles_id_fkey";

alter table "public"."repositories" drop constraint "repositories_user_id_fkey";

alter table "public"."submission_file_comments" drop constraint "submission_file_comments_author_fkey";

alter table "public"."submissions" drop constraint "submissio_user_id_fkey";

alter table "public"."discussion_threads" drop constraint "dicussion_threads_class_fkey";

alter table "public"."grader_results" drop constraint "grader_results_user_id_fkey";

alter table "public"."help_queues" drop constraint "help_queues_class_fkey";

alter table "public"."repositories" drop constraint "repositories_user_id_fkey1";

alter table "public"."submission_files" drop constraint "submission_files_user_id_fkey";

alter table "public"."submissions" drop constraint "submissio_user_id_fkey1";

alter table "public"."user_roles" drop constraint "user_roles_user_id_fkey1";

drop view if exists "public"."autograder_regression_test_by_grader";

drop view if exists "public"."submissions_agg";

alter table "public"."public_profiles" drop constraint "public_profiles_pkey";

drop index if exists "public"."public_profiles_pkey";

drop table "public"."public_profiles";

create table "public"."discussion_thread_read_status" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "user_id" uuid not null default gen_random_uuid(),
    "discussion_thread_id" bigint not null,
    "read_at" timestamp with time zone,
    "discussion_thread_root_id" bigint not null
);


alter table "public"."discussion_thread_read_status" enable row level security;

create table "public"."discussion_thread_watchers" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "user_id" uuid not null,
    "discussion_thread_root_id" bigint not null,
    "class_id" bigint not null,
    "enabled" boolean not null default true
);


alter table "public"."discussion_thread_watchers" enable row level security;

create table "public"."notifications" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "user_id" uuid not null,
    "class_id" bigint not null,
    "viewed_at" timestamp without time zone,
    "subject" jsonb not null,
    "body" jsonb not null,
    "style" text
);


alter table "public"."notifications" enable row level security;

create table "public"."poll_question_answers" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "poll_question" bigint not null,
    "title" text not null,
    "description" text,
    "poll" bigint not null,
    "class_id" bigint not null,
    "ordinal" integer not null default 0
);


alter table "public"."poll_question_answers" enable row level security;

create table "public"."poll_question_results" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "poll_question" bigint not null,
    "poll_question_answer" bigint not null,
    "count" integer not null default 0,
    "poll" bigint not null
);


alter table "public"."poll_question_results" enable row level security;

create table "public"."poll_questions" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "poll" bigint not null,
    "question_type" text not null default 'multiple-choice'::text,
    "title" text not null,
    "description" text,
    "class_id" bigint not null
);


alter table "public"."poll_questions" enable row level security;

create table "public"."poll_response_answers" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "poll_response" bigint not null,
    "poll" bigint not null,
    "poll_question" bigint not null,
    "poll_question_answer" bigint not null,
    "profile_id" uuid not null default gen_random_uuid()
);


alter table "public"."poll_response_answers" enable row level security;

create table "public"."poll_responses" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "ended_at" timestamp without time zone,
    "profile_id" uuid not null,
    "class_id" bigint not null,
    "poll" bigint not null
);


alter table "public"."poll_responses" enable row level security;

create table "public"."polls" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "name" text not null,
    "released_at" timestamp without time zone,
    "due_date" timestamp without time zone,
    "flair" jsonb,
    "class_id" bigint not null,
    "description" text
);


alter table "public"."polls" enable row level security;

create table "public"."users" (
    "user_id" uuid not null default gen_random_uuid(),
    "created_at" timestamp with time zone not null default now(),
    "github_username" text,
    "name" text,
    "avatar_url" text
);


alter table "public"."users" enable row level security;

alter table "public"."discussion_threads" drop column "class";

alter table "public"."discussion_threads" add column "class_id" bigint not null;

alter table "public"."grader_results" drop column "user_id";

alter table "public"."grader_results" add column "profile_id" uuid;

alter table "public"."help_queues" drop column "class";

alter table "public"."help_queues" add column "class_id" bigint not null;

alter table "public"."profiles" drop column "github_username";

alter table "public"."profiles" add column "class_id" bigint not null;

alter table "public"."profiles" add column "flair" text;

alter table "public"."profiles" add column "flair_color" text;

alter table "public"."profiles" alter column "id" set default gen_random_uuid();

alter table "public"."repositories" drop column "user_id";

alter table "public"."repositories" add column "class_id" bigint not null;

alter table "public"."repositories" add column "profile_id" uuid not null;

alter table "public"."submission_files" drop column "user_id";

alter table "public"."submission_files" add column "profile_id" uuid not null;

alter table "public"."submissions" drop column "user_id";

alter table "public"."submissions" add column "profile_id" uuid not null;

alter table "public"."user_roles" add column "private_profile_id" uuid not null;

alter table "public"."user_roles" add column "public_profile_id" uuid not null;

alter table "public"."user_roles" alter column "class_id" set not null;

CREATE UNIQUE INDEX discussion_thread_read_status_pkey ON public.discussion_thread_read_status USING btree (id);

CREATE UNIQUE INDEX discussion_thread_read_status_user_id_discussion_thread_id_key ON public.discussion_thread_read_status USING btree (user_id, discussion_thread_id);

CREATE UNIQUE INDEX discussion_thread_watchers_pkey ON public.discussion_thread_watchers USING btree (id);

CREATE UNIQUE INDEX notifications_pkey ON public.notifications USING btree (id);

CREATE INDEX notifications_profile_id_idx ON public.notifications USING btree (user_id);

CREATE UNIQUE INDEX poll_question_answers_pkey ON public.poll_question_answers USING btree (id);

CREATE UNIQUE INDEX poll_question_results_pkey ON public.poll_question_results USING btree (id);

CREATE UNIQUE INDEX poll_questions_pkey ON public.poll_questions USING btree (id);

CREATE UNIQUE INDEX poll_response_answers_pkey ON public.poll_response_answers USING btree (id);

CREATE UNIQUE INDEX poll_response_answers_uniq ON public.poll_response_answers USING btree (profile_id, poll_question_answer, poll_question);

CREATE UNIQUE INDEX poll_responses_pkey ON public.poll_responses USING btree (id);

CREATE UNIQUE INDEX polls_pkey ON public.polls USING btree (id);

CREATE UNIQUE INDEX thread_watch_uniq ON public.discussion_thread_watchers USING btree (user_id, discussion_thread_root_id);

CREATE INDEX user_roles_private_profile_id_idx ON public.user_roles USING btree (private_profile_id);

CREATE UNIQUE INDEX user_roles_private_profile_id_key ON public.user_roles USING btree (private_profile_id);

CREATE UNIQUE INDEX user_roles_public_profile_id_key ON public.user_roles USING btree (public_profile_id);

CREATE UNIQUE INDEX users_pkey ON public.users USING btree (user_id);

alter table "public"."discussion_thread_read_status" add constraint "discussion_thread_read_status_pkey" PRIMARY KEY using index "discussion_thread_read_status_pkey";

alter table "public"."discussion_thread_watchers" add constraint "discussion_thread_watchers_pkey" PRIMARY KEY using index "discussion_thread_watchers_pkey";

alter table "public"."notifications" add constraint "notifications_pkey" PRIMARY KEY using index "notifications_pkey";

alter table "public"."poll_question_answers" add constraint "poll_question_answers_pkey" PRIMARY KEY using index "poll_question_answers_pkey";

alter table "public"."poll_question_results" add constraint "poll_question_results_pkey" PRIMARY KEY using index "poll_question_results_pkey";

alter table "public"."poll_questions" add constraint "poll_questions_pkey" PRIMARY KEY using index "poll_questions_pkey";

alter table "public"."poll_response_answers" add constraint "poll_response_answers_pkey" PRIMARY KEY using index "poll_response_answers_pkey";

alter table "public"."poll_responses" add constraint "poll_responses_pkey" PRIMARY KEY using index "poll_responses_pkey";

alter table "public"."polls" add constraint "polls_pkey" PRIMARY KEY using index "polls_pkey";

alter table "public"."users" add constraint "users_pkey" PRIMARY KEY using index "users_pkey";

alter table "public"."discussion_thread_read_status" add constraint "discussion_thread_read_status_discussion_thread_id_fkey" FOREIGN KEY (discussion_thread_id) REFERENCES discussion_threads(id) not valid;

alter table "public"."discussion_thread_read_status" validate constraint "discussion_thread_read_status_discussion_thread_id_fkey";

alter table "public"."discussion_thread_read_status" add constraint "discussion_thread_read_status_discussion_thread_root_id_fkey" FOREIGN KEY (discussion_thread_root_id) REFERENCES discussion_threads(id) not valid;

alter table "public"."discussion_thread_read_status" validate constraint "discussion_thread_read_status_discussion_thread_root_id_fkey";

alter table "public"."discussion_thread_read_status" add constraint "discussion_thread_read_status_user_id_discussion_thread_id_key" UNIQUE using index "discussion_thread_read_status_user_id_discussion_thread_id_key";

alter table "public"."discussion_thread_read_status" add constraint "discussion_thread_read_status_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(user_id) not valid;

alter table "public"."discussion_thread_read_status" validate constraint "discussion_thread_read_status_user_id_fkey";

alter table "public"."discussion_thread_watchers" add constraint "discussion_thread_watchers_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."discussion_thread_watchers" validate constraint "discussion_thread_watchers_class_id_fkey";

alter table "public"."discussion_thread_watchers" add constraint "discussion_thread_watchers_discussion_thread_root_id_fkey" FOREIGN KEY (discussion_thread_root_id) REFERENCES discussion_threads(id) not valid;

alter table "public"."discussion_thread_watchers" validate constraint "discussion_thread_watchers_discussion_thread_root_id_fkey";

alter table "public"."discussion_thread_watchers" add constraint "discussion_thread_watchers_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(user_id) not valid;

alter table "public"."discussion_thread_watchers" validate constraint "discussion_thread_watchers_user_id_fkey";

alter table "public"."notifications" add constraint "notifications_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."notifications" validate constraint "notifications_class_id_fkey";

alter table "public"."notifications" add constraint "notifications_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(user_id) not valid;

alter table "public"."notifications" validate constraint "notifications_user_id_fkey";

alter table "public"."poll_question_answers" add constraint "poll_question_answers_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."poll_question_answers" validate constraint "poll_question_answers_class_id_fkey";

alter table "public"."poll_question_answers" add constraint "poll_question_answers_poll_fkey" FOREIGN KEY (poll) REFERENCES polls(id) not valid;

alter table "public"."poll_question_answers" validate constraint "poll_question_answers_poll_fkey";

alter table "public"."poll_question_answers" add constraint "poll_question_answers_poll_question_fkey" FOREIGN KEY (poll_question) REFERENCES poll_questions(id) not valid;

alter table "public"."poll_question_answers" validate constraint "poll_question_answers_poll_question_fkey";

alter table "public"."poll_question_results" add constraint "poll_question_results_poll_fkey" FOREIGN KEY (poll) REFERENCES polls(id) not valid;

alter table "public"."poll_question_results" validate constraint "poll_question_results_poll_fkey";

alter table "public"."poll_question_results" add constraint "poll_question_results_poll_question_answer_fkey" FOREIGN KEY (poll_question_answer) REFERENCES poll_question_answers(id) not valid;

alter table "public"."poll_question_results" validate constraint "poll_question_results_poll_question_answer_fkey";

alter table "public"."poll_question_results" add constraint "poll_question_results_poll_question_fkey" FOREIGN KEY (poll_question) REFERENCES poll_questions(id) not valid;

alter table "public"."poll_question_results" validate constraint "poll_question_results_poll_question_fkey";

alter table "public"."poll_questions" add constraint "poll_questions_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."poll_questions" validate constraint "poll_questions_class_id_fkey";

alter table "public"."poll_questions" add constraint "poll_questions_poll_fkey" FOREIGN KEY (poll) REFERENCES polls(id) not valid;

alter table "public"."poll_questions" validate constraint "poll_questions_poll_fkey";

alter table "public"."poll_response_answers" add constraint "poll_response_answers_poll_fkey" FOREIGN KEY (poll) REFERENCES polls(id) not valid;

alter table "public"."poll_response_answers" validate constraint "poll_response_answers_poll_fkey";

alter table "public"."poll_response_answers" add constraint "poll_response_answers_poll_question_answer_fkey" FOREIGN KEY (poll_question_answer) REFERENCES poll_question_answers(id) not valid;

alter table "public"."poll_response_answers" validate constraint "poll_response_answers_poll_question_answer_fkey";

alter table "public"."poll_response_answers" add constraint "poll_response_answers_poll_question_fkey" FOREIGN KEY (poll_question) REFERENCES poll_questions(id) not valid;

alter table "public"."poll_response_answers" validate constraint "poll_response_answers_poll_question_fkey";

alter table "public"."poll_response_answers" add constraint "poll_response_answers_poll_response_fkey" FOREIGN KEY (poll_response) REFERENCES poll_responses(id) not valid;

alter table "public"."poll_response_answers" validate constraint "poll_response_answers_poll_response_fkey";

alter table "public"."poll_response_answers" add constraint "poll_response_answers_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) not valid;

alter table "public"."poll_response_answers" validate constraint "poll_response_answers_profile_id_fkey";

alter table "public"."poll_responses" add constraint "poll_responses_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."poll_responses" validate constraint "poll_responses_class_id_fkey";

alter table "public"."poll_responses" add constraint "poll_responses_poll_fkey" FOREIGN KEY (poll) REFERENCES polls(id) not valid;

alter table "public"."poll_responses" validate constraint "poll_responses_poll_fkey";

alter table "public"."poll_responses" add constraint "poll_responses_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) not valid;

alter table "public"."poll_responses" validate constraint "poll_responses_profile_id_fkey";

alter table "public"."polls" add constraint "polls_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."polls" validate constraint "polls_class_id_fkey";

alter table "public"."repositories" add constraint "repositories_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."repositories" validate constraint "repositories_class_id_fkey";

alter table "public"."repositories" add constraint "repositories_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES user_roles(private_profile_id) not valid;

alter table "public"."repositories" validate constraint "repositories_profile_id_fkey";

alter table "public"."submission_files" add constraint "submission_files_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES user_roles(private_profile_id) not valid;

alter table "public"."submission_files" validate constraint "submission_files_profile_id_fkey";

alter table "public"."submissions" add constraint "submissions_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES user_roles(private_profile_id) not valid;

alter table "public"."submissions" validate constraint "submissions_profile_id_fkey";

alter table "public"."user_roles" add constraint "user_roles_private_profile_id_fkey" FOREIGN KEY (private_profile_id) REFERENCES profiles(id) not valid;

alter table "public"."user_roles" validate constraint "user_roles_private_profile_id_fkey";

alter table "public"."user_roles" add constraint "user_roles_private_profile_id_key" UNIQUE using index "user_roles_private_profile_id_key";

alter table "public"."user_roles" add constraint "user_roles_public_profile_id_fkey" FOREIGN KEY (public_profile_id) REFERENCES profiles(id) not valid;

alter table "public"."user_roles" validate constraint "user_roles_public_profile_id_fkey";

alter table "public"."user_roles" add constraint "user_roles_public_profile_id_key" UNIQUE using index "user_roles_public_profile_id_key";

alter table "public"."discussion_threads" add constraint "dicussion_threads_class_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."discussion_threads" validate constraint "dicussion_threads_class_fkey";

alter table "public"."grader_results" add constraint "grader_results_user_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) not valid;

alter table "public"."grader_results" validate constraint "grader_results_user_id_fkey";

alter table "public"."help_queues" add constraint "help_queues_class_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."help_queues" validate constraint "help_queues_class_fkey";

alter table "public"."repositories" add constraint "repositories_user_id_fkey1" FOREIGN KEY (profile_id) REFERENCES profiles(id) not valid;

alter table "public"."repositories" validate constraint "repositories_user_id_fkey1";

alter table "public"."submission_files" add constraint "submission_files_user_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) not valid;

alter table "public"."submission_files" validate constraint "submission_files_user_id_fkey";

alter table "public"."submissions" add constraint "submissio_user_id_fkey1" FOREIGN KEY (profile_id) REFERENCES profiles(id) not valid;

alter table "public"."submissions" validate constraint "submissio_user_id_fkey1";

alter table "public"."user_roles" add constraint "user_roles_user_id_fkey1" FOREIGN KEY (user_id) REFERENCES users(user_id) not valid;

alter table "public"."user_roles" validate constraint "user_roles_user_id_fkey1";

set check_function_bodies = off;

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

CREATE OR REPLACE FUNCTION public.authorizeforinstructorofstudent(user_id bigint)
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
  inner join public.user_roles as studentRole on ourRole.class_id=studentRole.class_id and studentRole.user_id=user_id
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
$function$
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

create or replace view "public"."autograder_regression_test_by_grader" as  SELECT a.grader_repo,
    t.repository,
    s.sha,
    t.id,
    s.class_id
   FROM (((autograder_regression_test t
     JOIN autograder a ON ((a.id = t.autograder_id)))
     JOIN submissions s ON ((s.repository = t.repository)))
     JOIN grader_results g ON ((g.submission_id = s.id)))
  GROUP BY s.sha, a.grader_repo, t.repository, s.created_at, t.id, s.class_id
 HAVING (s.created_at = max(s.created_at));


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

create or replace view "public"."submissions_agg" as  SELECT c.submissioncount,
    c.latestsubmissionid,
    s.id,
    s.created_at,
    s.assignment_id,
    s.profile_id AS user_id,
    s.released,
    s.sha,
    s.repository,
    s.run_attempt,
    s.run_number,
    g.score,
    g.ret_code,
    g.execution_time
   FROM ((( SELECT count(submissions.id) AS submissioncount,
            max(submissions.id) AS latestsubmissionid
           FROM submissions
          GROUP BY submissions.assignment_id, submissions.profile_id) c
     JOIN submissions s ON ((s.id = c.latestsubmissionid)))
     LEFT JOIN grader_results g ON ((g.submission_id = s.id)));


CREATE OR REPLACE FUNCTION public.submissions_insert_hook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      SELECT EXISTS(SELECT 1 from public.users where user_id=NEW.id) INTO existing_profile;
      if not existing_profile then
         INSERT INTO public.users (user_id) VALUES (NEW.id);
      end if;

      INSERT INTO public.profiles (name, avatar_url, class_id) VALUES
      (NEW.email, 'https://api.dicebear.com/9.x/identicon/svg?seed=' || NEW.email, 6) RETURNING id into new_private_profile_id;

      INSERT INTO public.profiles (name, avatar_url, class_id) VALUES
      (public.generate_anon_name(),'https://api.dicebear.com/9.x/identicon/svg?seed='||public.generate_anon_name(), 6) RETURNING id into new_public_profile_id; 

      INSERT INTO public.user_roles (user_id, class_id,role, public_profile_id, private_profile_id) VALUES (NEW.id, 6, 'student', new_public_profile_id, new_private_profile_id);

      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$function$
;

grant delete on table "public"."discussion_thread_read_status" to "anon";

grant insert on table "public"."discussion_thread_read_status" to "anon";

grant references on table "public"."discussion_thread_read_status" to "anon";

grant select on table "public"."discussion_thread_read_status" to "anon";

grant trigger on table "public"."discussion_thread_read_status" to "anon";

grant truncate on table "public"."discussion_thread_read_status" to "anon";

grant update on table "public"."discussion_thread_read_status" to "anon";

grant delete on table "public"."discussion_thread_read_status" to "authenticated";

grant insert on table "public"."discussion_thread_read_status" to "authenticated";

grant references on table "public"."discussion_thread_read_status" to "authenticated";

grant select on table "public"."discussion_thread_read_status" to "authenticated";

grant trigger on table "public"."discussion_thread_read_status" to "authenticated";

grant truncate on table "public"."discussion_thread_read_status" to "authenticated";

grant update on table "public"."discussion_thread_read_status" to "authenticated";

grant delete on table "public"."discussion_thread_read_status" to "service_role";

grant insert on table "public"."discussion_thread_read_status" to "service_role";

grant references on table "public"."discussion_thread_read_status" to "service_role";

grant select on table "public"."discussion_thread_read_status" to "service_role";

grant trigger on table "public"."discussion_thread_read_status" to "service_role";

grant truncate on table "public"."discussion_thread_read_status" to "service_role";

grant update on table "public"."discussion_thread_read_status" to "service_role";

grant delete on table "public"."discussion_thread_watchers" to "anon";

grant insert on table "public"."discussion_thread_watchers" to "anon";

grant references on table "public"."discussion_thread_watchers" to "anon";

grant select on table "public"."discussion_thread_watchers" to "anon";

grant trigger on table "public"."discussion_thread_watchers" to "anon";

grant truncate on table "public"."discussion_thread_watchers" to "anon";

grant update on table "public"."discussion_thread_watchers" to "anon";

grant delete on table "public"."discussion_thread_watchers" to "authenticated";

grant insert on table "public"."discussion_thread_watchers" to "authenticated";

grant references on table "public"."discussion_thread_watchers" to "authenticated";

grant select on table "public"."discussion_thread_watchers" to "authenticated";

grant trigger on table "public"."discussion_thread_watchers" to "authenticated";

grant truncate on table "public"."discussion_thread_watchers" to "authenticated";

grant update on table "public"."discussion_thread_watchers" to "authenticated";

grant delete on table "public"."discussion_thread_watchers" to "service_role";

grant insert on table "public"."discussion_thread_watchers" to "service_role";

grant references on table "public"."discussion_thread_watchers" to "service_role";

grant select on table "public"."discussion_thread_watchers" to "service_role";

grant trigger on table "public"."discussion_thread_watchers" to "service_role";

grant truncate on table "public"."discussion_thread_watchers" to "service_role";

grant update on table "public"."discussion_thread_watchers" to "service_role";

grant delete on table "public"."notifications" to "anon";

grant insert on table "public"."notifications" to "anon";

grant references on table "public"."notifications" to "anon";

grant select on table "public"."notifications" to "anon";

grant trigger on table "public"."notifications" to "anon";

grant truncate on table "public"."notifications" to "anon";

grant update on table "public"."notifications" to "anon";

grant delete on table "public"."notifications" to "authenticated";

grant insert on table "public"."notifications" to "authenticated";

grant references on table "public"."notifications" to "authenticated";

grant select on table "public"."notifications" to "authenticated";

grant trigger on table "public"."notifications" to "authenticated";

grant truncate on table "public"."notifications" to "authenticated";

grant update on table "public"."notifications" to "authenticated";

grant delete on table "public"."notifications" to "service_role";

grant insert on table "public"."notifications" to "service_role";

grant references on table "public"."notifications" to "service_role";

grant select on table "public"."notifications" to "service_role";

grant trigger on table "public"."notifications" to "service_role";

grant truncate on table "public"."notifications" to "service_role";

grant update on table "public"."notifications" to "service_role";

grant delete on table "public"."poll_question_answers" to "anon";

grant insert on table "public"."poll_question_answers" to "anon";

grant references on table "public"."poll_question_answers" to "anon";

grant select on table "public"."poll_question_answers" to "anon";

grant trigger on table "public"."poll_question_answers" to "anon";

grant truncate on table "public"."poll_question_answers" to "anon";

grant update on table "public"."poll_question_answers" to "anon";

grant delete on table "public"."poll_question_answers" to "authenticated";

grant insert on table "public"."poll_question_answers" to "authenticated";

grant references on table "public"."poll_question_answers" to "authenticated";

grant select on table "public"."poll_question_answers" to "authenticated";

grant trigger on table "public"."poll_question_answers" to "authenticated";

grant truncate on table "public"."poll_question_answers" to "authenticated";

grant update on table "public"."poll_question_answers" to "authenticated";

grant delete on table "public"."poll_question_answers" to "service_role";

grant insert on table "public"."poll_question_answers" to "service_role";

grant references on table "public"."poll_question_answers" to "service_role";

grant select on table "public"."poll_question_answers" to "service_role";

grant trigger on table "public"."poll_question_answers" to "service_role";

grant truncate on table "public"."poll_question_answers" to "service_role";

grant update on table "public"."poll_question_answers" to "service_role";

grant delete on table "public"."poll_question_results" to "anon";

grant insert on table "public"."poll_question_results" to "anon";

grant references on table "public"."poll_question_results" to "anon";

grant select on table "public"."poll_question_results" to "anon";

grant trigger on table "public"."poll_question_results" to "anon";

grant truncate on table "public"."poll_question_results" to "anon";

grant update on table "public"."poll_question_results" to "anon";

grant delete on table "public"."poll_question_results" to "authenticated";

grant insert on table "public"."poll_question_results" to "authenticated";

grant references on table "public"."poll_question_results" to "authenticated";

grant select on table "public"."poll_question_results" to "authenticated";

grant trigger on table "public"."poll_question_results" to "authenticated";

grant truncate on table "public"."poll_question_results" to "authenticated";

grant update on table "public"."poll_question_results" to "authenticated";

grant delete on table "public"."poll_question_results" to "service_role";

grant insert on table "public"."poll_question_results" to "service_role";

grant references on table "public"."poll_question_results" to "service_role";

grant select on table "public"."poll_question_results" to "service_role";

grant trigger on table "public"."poll_question_results" to "service_role";

grant truncate on table "public"."poll_question_results" to "service_role";

grant update on table "public"."poll_question_results" to "service_role";

grant delete on table "public"."poll_questions" to "anon";

grant insert on table "public"."poll_questions" to "anon";

grant references on table "public"."poll_questions" to "anon";

grant select on table "public"."poll_questions" to "anon";

grant trigger on table "public"."poll_questions" to "anon";

grant truncate on table "public"."poll_questions" to "anon";

grant update on table "public"."poll_questions" to "anon";

grant delete on table "public"."poll_questions" to "authenticated";

grant insert on table "public"."poll_questions" to "authenticated";

grant references on table "public"."poll_questions" to "authenticated";

grant select on table "public"."poll_questions" to "authenticated";

grant trigger on table "public"."poll_questions" to "authenticated";

grant truncate on table "public"."poll_questions" to "authenticated";

grant update on table "public"."poll_questions" to "authenticated";

grant delete on table "public"."poll_questions" to "service_role";

grant insert on table "public"."poll_questions" to "service_role";

grant references on table "public"."poll_questions" to "service_role";

grant select on table "public"."poll_questions" to "service_role";

grant trigger on table "public"."poll_questions" to "service_role";

grant truncate on table "public"."poll_questions" to "service_role";

grant update on table "public"."poll_questions" to "service_role";

grant delete on table "public"."poll_response_answers" to "anon";

grant insert on table "public"."poll_response_answers" to "anon";

grant references on table "public"."poll_response_answers" to "anon";

grant select on table "public"."poll_response_answers" to "anon";

grant trigger on table "public"."poll_response_answers" to "anon";

grant truncate on table "public"."poll_response_answers" to "anon";

grant update on table "public"."poll_response_answers" to "anon";

grant delete on table "public"."poll_response_answers" to "authenticated";

grant insert on table "public"."poll_response_answers" to "authenticated";

grant references on table "public"."poll_response_answers" to "authenticated";

grant select on table "public"."poll_response_answers" to "authenticated";

grant trigger on table "public"."poll_response_answers" to "authenticated";

grant truncate on table "public"."poll_response_answers" to "authenticated";

grant update on table "public"."poll_response_answers" to "authenticated";

grant delete on table "public"."poll_response_answers" to "service_role";

grant insert on table "public"."poll_response_answers" to "service_role";

grant references on table "public"."poll_response_answers" to "service_role";

grant select on table "public"."poll_response_answers" to "service_role";

grant trigger on table "public"."poll_response_answers" to "service_role";

grant truncate on table "public"."poll_response_answers" to "service_role";

grant update on table "public"."poll_response_answers" to "service_role";

grant delete on table "public"."poll_responses" to "anon";

grant insert on table "public"."poll_responses" to "anon";

grant references on table "public"."poll_responses" to "anon";

grant select on table "public"."poll_responses" to "anon";

grant trigger on table "public"."poll_responses" to "anon";

grant truncate on table "public"."poll_responses" to "anon";

grant update on table "public"."poll_responses" to "anon";

grant delete on table "public"."poll_responses" to "authenticated";

grant insert on table "public"."poll_responses" to "authenticated";

grant references on table "public"."poll_responses" to "authenticated";

grant select on table "public"."poll_responses" to "authenticated";

grant trigger on table "public"."poll_responses" to "authenticated";

grant truncate on table "public"."poll_responses" to "authenticated";

grant update on table "public"."poll_responses" to "authenticated";

grant delete on table "public"."poll_responses" to "service_role";

grant insert on table "public"."poll_responses" to "service_role";

grant references on table "public"."poll_responses" to "service_role";

grant select on table "public"."poll_responses" to "service_role";

grant trigger on table "public"."poll_responses" to "service_role";

grant truncate on table "public"."poll_responses" to "service_role";

grant update on table "public"."poll_responses" to "service_role";

grant delete on table "public"."polls" to "anon";

grant insert on table "public"."polls" to "anon";

grant references on table "public"."polls" to "anon";

grant select on table "public"."polls" to "anon";

grant trigger on table "public"."polls" to "anon";

grant truncate on table "public"."polls" to "anon";

grant update on table "public"."polls" to "anon";

grant delete on table "public"."polls" to "authenticated";

grant insert on table "public"."polls" to "authenticated";

grant references on table "public"."polls" to "authenticated";

grant select on table "public"."polls" to "authenticated";

grant trigger on table "public"."polls" to "authenticated";

grant truncate on table "public"."polls" to "authenticated";

grant update on table "public"."polls" to "authenticated";

grant delete on table "public"."polls" to "service_role";

grant insert on table "public"."polls" to "service_role";

grant references on table "public"."polls" to "service_role";

grant select on table "public"."polls" to "service_role";

grant trigger on table "public"."polls" to "service_role";

grant truncate on table "public"."polls" to "service_role";

grant update on table "public"."polls" to "service_role";

grant delete on table "public"."users" to "anon";

grant insert on table "public"."users" to "anon";

grant references on table "public"."users" to "anon";

grant select on table "public"."users" to "anon";

grant trigger on table "public"."users" to "anon";

grant truncate on table "public"."users" to "anon";

grant update on table "public"."users" to "anon";

grant delete on table "public"."users" to "authenticated";

grant insert on table "public"."users" to "authenticated";

grant references on table "public"."users" to "authenticated";

grant select on table "public"."users" to "authenticated";

grant trigger on table "public"."users" to "authenticated";

grant truncate on table "public"."users" to "authenticated";

grant update on table "public"."users" to "authenticated";

grant delete on table "public"."users" to "service_role";

grant insert on table "public"."users" to "service_role";

grant references on table "public"."users" to "service_role";

grant select on table "public"."users" to "service_role";

grant trigger on table "public"."users" to "service_role";

grant truncate on table "public"."users" to "service_role";

grant update on table "public"."users" to "service_role";

create policy "Read if in in class"
on "public"."classes"
as permissive
for select
to public
using (( SELECT authorizeforclass(classes.id) AS authorizeforclass));


create policy "CRUD by uid"
on "public"."discussion_thread_read_status"
as permissive
for all
to public
using ((( SELECT auth.uid() AS uid) = user_id));


create policy "CRUD for self"
on "public"."discussion_thread_watchers"
as permissive
for all
to public
using ((( SELECT auth.uid() AS uid) = user_id));


create policy "CRUD for self"
on "public"."notifications"
as permissive
for all
to public
using ((( SELECT auth.uid() AS uid) = user_id));


create policy "authorizeForPoll"
on "public"."poll_question_answers"
as permissive
for select
to public
using (authorizeforpoll(poll));


create policy "instructors insert"
on "public"."poll_question_answers"
as permissive
for insert
to public
with check (authorizeforclassinstructor(class_id));


create policy "authorizeForPoll"
on "public"."poll_question_results"
as permissive
for select
to public
using (authorizeforpoll(poll));


create policy "authorizeForPoll"
on "public"."poll_questions"
as permissive
for select
to public
using (authorizeforpoll(poll));


create policy "instructors insert"
on "public"."poll_questions"
as permissive
for insert
to public
with check (authorizeforclassinstructor(class_id));


create policy "authorizeForProfile insert"
on "public"."poll_response_answers"
as permissive
for insert
to public
with check (authorizeforprofile(profile_id));


create policy "authorizeForProfile select"
on "public"."poll_response_answers"
as permissive
for select
to public
using (authorizeforprofile(profile_id));


create policy "authorizeForProfile insert"
on "public"."poll_responses"
as permissive
for insert
to public
with check (authorizeforprofile(profile_id));


create policy "authorizeForProfile"
on "public"."poll_responses"
as permissive
for select
to public
using (authorizeforprofile(profile_id));


create policy "authorizeForPoll"
on "public"."polls"
as permissive
for select
to public
using (authorizeforpoll(id));


create policy "insert authorizeForClassInstructor"
on "public"."polls"
as permissive
for insert
to public
with check (authorizeforclassinstructor(class_id));


create policy "View in same class"
on "public"."profiles"
as permissive
for select
to authenticated
using (authorizeforclass(class_id));


create policy "view own, instructors also view all that they instruct"
on "public"."users"
as permissive
for select
to public
using (((user_id = auth.uid()) OR authorizeforinstructorofstudent(user_id)));


create policy "instructors can read and edit in class"
on "public"."assignments"
as permissive
for all
to public
using (( SELECT authorizeforclassinstructor(assignments.class_id) AS authorizeforclass));


create policy "read assignments in own class regardless of release date"
on "public"."assignments"
as permissive
for select
to public
using (authorizeforclass(class_id));


create policy "instructors rw"
on "public"."autograder"
as permissive
for all
to public
using (authorizeforclassinstructor(( SELECT assignments.class_id
   FROM assignments
  WHERE (assignments.id = autograder.id))));


create policy "instructors rw"
on "public"."autograder_regression_test"
as permissive
for all
to public
using (authorizeforclassinstructor(( SELECT assignments.class_id
   FROM assignments
  WHERE (assignments.id = autograder_regression_test.autograder_id))));


create policy "CRUD for own only"
on "public"."discussion_thread_likes"
as permissive
for all
to public
using (authorizeforprofile(creator));


create policy "insert own only"
on "public"."discussion_threads"
as permissive
for insert
to public
with check ((authorizeforclass(class_id) AND authorizeforprofile(author)));


create policy "self updates, or instructor"
on "public"."discussion_threads"
as permissive
for update
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(author)));


create policy "students view all non-private in their class, instructors view "
on "public"."discussion_threads"
as permissive
for select
to public
using (((authorizeforclass(class_id) AND (instructors_only = false)) OR authorizeforclassinstructor(class_id) OR authorizeforprofile(author)));


create policy "view in class"
on "public"."discussion_topics"
as permissive
for select
to public
using (authorizeforclass(class_id));


create policy "visible to instructors always, and self conditionally"
on "public"."grader_result_output"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR (authorizeforprofile(student_id) AND (visibility = 'visible'::feedback_visibility))));


create policy "visible to instructors and self"
on "public"."grader_result_tests"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(student_id)));


create policy "visible to instructors and self"
on "public"."grader_results"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(profile_id)));


create policy "Instructors can do anything"
on "public"."help_queues"
as permissive
for all
to public
using (authorizeforclassinstructor(class_id));


create policy "Visible to everyone in class"
on "public"."help_queues"
as permissive
for select
to public
using (authorizeforclass(class_id));


create policy "insert for self in class"
on "public"."help_request_messages"
as permissive
for insert
to public
with check ((authorizeforclass(class_id) AND authorizeforprofile(author)));


create policy "instructors view all, students view own"
on "public"."help_request_messages"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(author) OR authorizeforprofile(requestor)));


create policy "insert for own class"
on "public"."help_requests"
as permissive
for insert
to public
with check ((authorizeforclass(class_id) AND authorizeforprofile(creator) AND (assignee IS NULL)));


create policy "instructors can update"
on "public"."help_requests"
as permissive
for update
to public
using (authorizeforclassinstructor(class_id));


create policy "students can set resolved"
on "public"."help_requests"
as permissive
for update
to public
using ((authorizeforprofile(creator) AND (resolved_by IS NULL)));


create policy "students view own, instructors view all"
on "public"."help_requests"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(creator)));


create policy "instructors and students can view"
on "public"."repositories"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(profile_id)));


create policy "instructors CRUD"
on "public"."rubrics"
as permissive
for all
to public
using (authorizeforclassinstructor(class_id));


create policy "can only insert comments as self, for own files (instructors ca"
on "public"."submission_file_comments"
as permissive
for insert
to public
with check ((authorizeforprofile(author) AND (authorizeforclassinstructor(class_id) OR authorizeforprofile(( SELECT submissions.profile_id
   FROM submissions
  WHERE (submissions.id = submission_file_comments.submissions_id))))));


create policy "students view own, instructors view all"
on "public"."submission_file_comments"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(( SELECT submissions.profile_id
   FROM submissions
  WHERE (submissions.id = submission_file_comments.submissions_id)))));


create policy "instructors view all, students own"
on "public"."submission_files"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(profile_id)));


create policy "Instructors can view all submissions in class, students can vie"
on "public"."submissions"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(profile_id)));


create policy "Enable users to view their own data only"
on "public"."user_roles"
as permissive
for select
to authenticated
using (((( SELECT auth.uid() AS uid) = user_id) OR authorizeforclassinstructor((class_id)::bigint)));


create policy "view in class"
on "public"."video_meeting_sessions"
as permissive
for select
to public
using (authorizeforclass(class_id));


CREATE TRIGGER discussion_thread_notifications AFTER INSERT ON public.discussion_threads FOR EACH ROW EXECUTE FUNCTION discussion_threads_notification();

CREATE TRIGGER poll_question_answer_ins_del AFTER INSERT OR DELETE ON public.poll_question_answers FOR EACH ROW EXECUTE FUNCTION poll_question_answer_ins_del();

CREATE TRIGGER poll_response_answers_ins_del_upd BEFORE INSERT OR DELETE OR UPDATE ON public.poll_response_answers FOR EACH ROW EXECUTE FUNCTION poll_response_answers_ins_del_upd();


