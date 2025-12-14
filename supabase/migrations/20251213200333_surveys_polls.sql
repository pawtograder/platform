create type "public"."survey_status" as enum ('draft', 'published', 'closed');

create type "public"."survey_type" as enum ('assign_all', 'specific', 'peer');

create type "public"."template_scope" as enum ('global', 'course');

drop trigger if exists "poll_question_answer_ins_del" on "public"."poll_question_answers";

drop trigger if exists "poll_response_answers_ins_del_upd" on "public"."poll_response_answers";

drop policy "authorizeForPoll" on "public"."poll_question_answers";

drop policy "instructors insert" on "public"."poll_question_answers";

drop policy "authorizeForPoll" on "public"."poll_question_results";

drop policy "authorizeForPoll" on "public"."poll_questions";

drop policy "instructors insert" on "public"."poll_questions";

drop policy "authorizeForProfile insert" on "public"."poll_response_answers";

drop policy "authorizeForProfile select" on "public"."poll_response_answers";

drop policy "authorizeForProfile insert" on "public"."poll_responses";

drop policy "authorizeForProfile" on "public"."poll_responses";

drop policy "authorizeForPoll" on "public"."polls";

drop policy "insert authorizeForClassInstructor" on "public"."polls";

revoke delete on table "public"."poll_question_answers" from "authenticated";

revoke insert on table "public"."poll_question_answers" from "authenticated";

revoke references on table "public"."poll_question_answers" from "authenticated";

revoke select on table "public"."poll_question_answers" from "authenticated";

revoke trigger on table "public"."poll_question_answers" from "authenticated";

revoke truncate on table "public"."poll_question_answers" from "authenticated";

revoke update on table "public"."poll_question_answers" from "authenticated";

revoke delete on table "public"."poll_question_answers" from "service_role";

revoke insert on table "public"."poll_question_answers" from "service_role";

revoke references on table "public"."poll_question_answers" from "service_role";

revoke select on table "public"."poll_question_answers" from "service_role";

revoke trigger on table "public"."poll_question_answers" from "service_role";

revoke truncate on table "public"."poll_question_answers" from "service_role";

revoke update on table "public"."poll_question_answers" from "service_role";

revoke delete on table "public"."poll_question_results" from "authenticated";

revoke insert on table "public"."poll_question_results" from "authenticated";

revoke references on table "public"."poll_question_results" from "authenticated";

revoke select on table "public"."poll_question_results" from "authenticated";

revoke trigger on table "public"."poll_question_results" from "authenticated";

revoke truncate on table "public"."poll_question_results" from "authenticated";

revoke update on table "public"."poll_question_results" from "authenticated";

revoke delete on table "public"."poll_question_results" from "service_role";

revoke insert on table "public"."poll_question_results" from "service_role";

revoke references on table "public"."poll_question_results" from "service_role";

revoke select on table "public"."poll_question_results" from "service_role";

revoke trigger on table "public"."poll_question_results" from "service_role";

revoke truncate on table "public"."poll_question_results" from "service_role";

revoke update on table "public"."poll_question_results" from "service_role";

revoke delete on table "public"."poll_questions" from "authenticated";

revoke insert on table "public"."poll_questions" from "authenticated";

revoke references on table "public"."poll_questions" from "authenticated";

revoke select on table "public"."poll_questions" from "authenticated";

revoke trigger on table "public"."poll_questions" from "authenticated";

revoke truncate on table "public"."poll_questions" from "authenticated";

revoke update on table "public"."poll_questions" from "authenticated";

revoke delete on table "public"."poll_questions" from "service_role";

revoke insert on table "public"."poll_questions" from "service_role";

revoke references on table "public"."poll_questions" from "service_role";

revoke select on table "public"."poll_questions" from "service_role";

revoke trigger on table "public"."poll_questions" from "service_role";

revoke truncate on table "public"."poll_questions" from "service_role";

revoke update on table "public"."poll_questions" from "service_role";

revoke delete on table "public"."poll_response_answers" from "authenticated";

revoke insert on table "public"."poll_response_answers" from "authenticated";

revoke references on table "public"."poll_response_answers" from "authenticated";

revoke select on table "public"."poll_response_answers" from "authenticated";

revoke trigger on table "public"."poll_response_answers" from "authenticated";

revoke truncate on table "public"."poll_response_answers" from "authenticated";

revoke update on table "public"."poll_response_answers" from "authenticated";

revoke delete on table "public"."poll_response_answers" from "service_role";

revoke insert on table "public"."poll_response_answers" from "service_role";

revoke references on table "public"."poll_response_answers" from "service_role";

revoke select on table "public"."poll_response_answers" from "service_role";

revoke trigger on table "public"."poll_response_answers" from "service_role";

revoke truncate on table "public"."poll_response_answers" from "service_role";

revoke update on table "public"."poll_response_answers" from "service_role";

revoke delete on table "public"."poll_responses" from "authenticated";

revoke insert on table "public"."poll_responses" from "authenticated";

revoke references on table "public"."poll_responses" from "authenticated";

revoke select on table "public"."poll_responses" from "authenticated";

revoke trigger on table "public"."poll_responses" from "authenticated";

revoke truncate on table "public"."poll_responses" from "authenticated";

revoke update on table "public"."poll_responses" from "authenticated";

revoke delete on table "public"."poll_responses" from "service_role";

revoke insert on table "public"."poll_responses" from "service_role";

revoke references on table "public"."poll_responses" from "service_role";

revoke select on table "public"."poll_responses" from "service_role";

revoke trigger on table "public"."poll_responses" from "service_role";

revoke truncate on table "public"."poll_responses" from "service_role";

revoke update on table "public"."poll_responses" from "service_role";

revoke delete on table "public"."polls" from "authenticated";

revoke insert on table "public"."polls" from "authenticated";

revoke references on table "public"."polls" from "authenticated";

revoke select on table "public"."polls" from "authenticated";

revoke trigger on table "public"."polls" from "authenticated";

revoke truncate on table "public"."polls" from "authenticated";

revoke update on table "public"."polls" from "authenticated";

revoke delete on table "public"."polls" from "service_role";

revoke insert on table "public"."polls" from "service_role";

revoke references on table "public"."polls" from "service_role";

revoke select on table "public"."polls" from "service_role";

revoke trigger on table "public"."polls" from "service_role";

revoke truncate on table "public"."polls" from "service_role";

revoke update on table "public"."polls" from "service_role";

alter table "public"."poll_question_answers" drop constraint "poll_question_answers_class_id_fkey";

alter table "public"."poll_question_answers" drop constraint "poll_question_answers_poll_fkey";

alter table "public"."poll_question_answers" drop constraint "poll_question_answers_poll_question_fkey";

alter table "public"."poll_question_results" drop constraint "poll_question_results_poll_fkey";

alter table "public"."poll_question_results" drop constraint "poll_question_results_poll_question_answer_fkey";

alter table "public"."poll_question_results" drop constraint "poll_question_results_poll_question_fkey";

alter table "public"."poll_questions" drop constraint "poll_questions_class_id_fkey";

alter table "public"."poll_questions" drop constraint "poll_questions_poll_fkey";

alter table "public"."poll_response_answers" drop constraint "poll_response_answers_poll_fkey";

alter table "public"."poll_response_answers" drop constraint "poll_response_answers_poll_question_answer_fkey";

alter table "public"."poll_response_answers" drop constraint "poll_response_answers_poll_question_fkey";

alter table "public"."poll_response_answers" drop constraint "poll_response_answers_poll_response_fkey";

alter table "public"."poll_response_answers" drop constraint "poll_response_answers_profile_id_fkey";

alter table "public"."poll_responses" drop constraint "poll_responses_class_id_fkey";

alter table "public"."poll_responses" drop constraint "poll_responses_poll_fkey";

alter table "public"."poll_responses" drop constraint "poll_responses_profile_id_fkey";

alter table "public"."polls" drop constraint "polls_class_id_fkey";

alter table "public"."poll_question_answers" drop constraint "poll_question_answers_pkey";

alter table "public"."poll_question_results" drop constraint "poll_question_results_pkey";

alter table "public"."poll_questions" drop constraint "poll_questions_pkey";

alter table "public"."poll_response_answers" drop constraint "poll_response_answers_pkey";

alter table "public"."poll_responses" drop constraint "poll_responses_pkey";

alter table "public"."polls" drop constraint "polls_pkey";

drop index if exists "public"."poll_question_answers_pkey";

drop index if exists "public"."poll_question_results_pkey";

drop index if exists "public"."poll_questions_pkey";

drop index if exists "public"."poll_response_answers_pkey";

drop index if exists "public"."poll_response_answers_uniq";

drop index if exists "public"."poll_responses_pkey";

drop index if exists "public"."polls_pkey";

drop table "public"."poll_question_answers";

drop table "public"."poll_question_results";

drop table "public"."poll_questions";

drop table "public"."poll_response_answers";

drop table "public"."poll_responses";

drop table "public"."polls";

create table "public"."live_poll_responses" (
    "id" uuid not null default gen_random_uuid(),
    "live_poll_id" uuid not null,
    "public_profile_id" uuid,
    "response" jsonb not null default '{}'::jsonb,
    "submitted_at" timestamp with time zone,
    "is_submitted" boolean not null default false,
    "created_at" timestamp with time zone not null default now()
);


alter table "public"."live_poll_responses" enable row level security;

create table "public"."live_polls" (
    "id" uuid not null default gen_random_uuid(),
    "class_id" bigint not null,
    "created_by" uuid not null,
    "question" jsonb not null default '[]'::jsonb,
    "is_live" boolean not null default false,
    "created_at" timestamp with time zone not null default now(),
    "deactivates_at" timestamp with time zone,
    "require_login" boolean not null default false
);


alter table "public"."live_polls" enable row level security;

create table "public"."survey_assignments" (
    "id" uuid not null default gen_random_uuid(),
    "survey_id" uuid not null,
    "profile_id" uuid not null,
    "created_at" timestamp with time zone not null default now(),
    "class_id" bigint not null
);


alter table "public"."survey_assignments" enable row level security;

create table "public"."survey_responses" (
    "id" uuid not null default gen_random_uuid(),
    "survey_id" uuid not null,
    "profile_id" uuid not null,
    "response" jsonb not null default '{}'::jsonb,
    "submitted_at" timestamp with time zone,
    "is_submitted" boolean not null default false,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "deleted_at" timestamp with time zone
);


alter table "public"."survey_responses" enable row level security;

create table "public"."survey_templates" (
    "id" uuid not null default gen_random_uuid(),
    "title" text not null,
    "description" text not null default ''::text,
    "template" jsonb not null default '{}'::jsonb,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "created_by" uuid not null,
    "version" integer not null default 1,
    "scope" template_scope not null default 'course'::template_scope,
    "class_id" bigint not null
);


alter table "public"."survey_templates" enable row level security;

create table "public"."surveys" (
    "id" uuid not null default gen_random_uuid(),
    "survey_id" uuid not null default gen_random_uuid(),
    "class_id" bigint not null,
    "created_by" uuid not null,
    "title" text not null,
    "description" text,
    "json" jsonb not null default '[]'::jsonb,
    "status" survey_status not null default 'draft'::survey_status,
    "allow_response_editing" boolean not null default false,
    "due_date" timestamp with time zone,
    "validation_errors" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "deleted_at" timestamp with time zone,
    "version" integer not null default 1,
    "type" survey_type not null default 'assign_all'::survey_type,
    "assigned_to_all" boolean not null default true
);


alter table "public"."surveys" enable row level security;

CREATE INDEX idx_live_poll_responses_poll_id ON public.live_poll_responses USING btree (live_poll_id);

CREATE INDEX idx_live_poll_responses_profile_id ON public.live_poll_responses USING btree (public_profile_id);

CREATE INDEX idx_live_polls_class_is_live ON public.live_polls USING btree (class_id, is_live);

CREATE INDEX idx_live_polls_deactivation ON public.live_polls USING btree (deactivates_at) WHERE ((is_live = true) AND (deactivates_at IS NOT NULL));

CREATE UNIQUE INDEX idx_responses_survey_user ON public.survey_responses USING btree (survey_id, profile_id);

CREATE INDEX idx_survey_assignments_class_id ON public.survey_assignments USING btree (class_id);

CREATE INDEX idx_survey_assignments_profile_id ON public.survey_assignments USING btree (profile_id);

CREATE INDEX idx_survey_assignments_survey_id ON public.survey_assignments USING btree (survey_id);

CREATE INDEX idx_survey_responses_survey_id_active ON public.survey_responses USING btree (survey_id) WHERE (deleted_at IS NULL);

CREATE INDEX idx_surveys_class_active ON public.surveys USING btree (class_id, deleted_at) WHERE (deleted_at IS NULL);

CREATE INDEX idx_surveys_created_by ON public.surveys USING btree (created_by);

CREATE INDEX idx_surveys_survey_id_version ON public.surveys USING btree (survey_id, version DESC);

CREATE UNIQUE INDEX live_poll_responses_pkey ON public.live_poll_responses USING btree (id);

CREATE UNIQUE INDEX live_poll_responses_unique_per_profile ON public.live_poll_responses USING btree (live_poll_id, public_profile_id);

CREATE UNIQUE INDEX live_polls_pkey ON public.live_polls USING btree (id);

CREATE UNIQUE INDEX survey_assignments_pkey ON public.survey_assignments USING btree (id);

CREATE UNIQUE INDEX survey_assignments_unique_per_profile ON public.survey_assignments USING btree (survey_id, profile_id);

CREATE UNIQUE INDEX survey_responses_pkey ON public.survey_responses USING btree (id);

CREATE UNIQUE INDEX survey_responses_unique_per_profile ON public.survey_responses USING btree (survey_id, profile_id);

CREATE UNIQUE INDEX survey_templates_pkey ON public.survey_templates USING btree (id);

CREATE UNIQUE INDEX surveys_pkey ON public.surveys USING btree (id);

alter table "public"."live_poll_responses" add constraint "live_poll_responses_pkey" PRIMARY KEY using index "live_poll_responses_pkey";

alter table "public"."live_polls" add constraint "live_polls_pkey" PRIMARY KEY using index "live_polls_pkey";

alter table "public"."survey_assignments" add constraint "survey_assignments_pkey" PRIMARY KEY using index "survey_assignments_pkey";

alter table "public"."survey_responses" add constraint "survey_responses_pkey" PRIMARY KEY using index "survey_responses_pkey";

alter table "public"."survey_templates" add constraint "survey_templates_pkey" PRIMARY KEY using index "survey_templates_pkey";

alter table "public"."surveys" add constraint "surveys_pkey" PRIMARY KEY using index "surveys_pkey";

alter table "public"."live_poll_responses" add constraint "live_poll_responses_live_poll_id_fkey" FOREIGN KEY (live_poll_id) REFERENCES live_polls(id) ON DELETE CASCADE not valid;

alter table "public"."live_poll_responses" validate constraint "live_poll_responses_live_poll_id_fkey";

alter table "public"."live_poll_responses" add constraint "live_poll_responses_public_profile_id_fkey" FOREIGN KEY (public_profile_id) REFERENCES user_roles(public_profile_id) ON DELETE CASCADE not valid;

alter table "public"."live_poll_responses" validate constraint "live_poll_responses_public_profile_id_fkey";

alter table "public"."live_poll_responses" add constraint "live_poll_responses_unique_per_profile" UNIQUE using index "live_poll_responses_unique_per_profile";

alter table "public"."live_polls" add constraint "live_polls_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE not valid;

alter table "public"."live_polls" validate constraint "live_polls_class_id_fkey";

alter table "public"."live_polls" add constraint "live_polls_created_by_fkey" FOREIGN KEY (created_by) REFERENCES user_roles(public_profile_id) ON DELETE CASCADE not valid;

alter table "public"."live_polls" validate constraint "live_polls_created_by_fkey";

alter table "public"."survey_assignments" add constraint "survey_assignments_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE not valid;

alter table "public"."survey_assignments" validate constraint "survey_assignments_class_id_fkey";

alter table "public"."survey_assignments" add constraint "survey_assignments_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE not valid;

alter table "public"."survey_assignments" validate constraint "survey_assignments_profile_id_fkey";

alter table "public"."survey_assignments" add constraint "survey_assignments_survey_id_fkey" FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE not valid;

alter table "public"."survey_assignments" validate constraint "survey_assignments_survey_id_fkey";

alter table "public"."survey_assignments" add constraint "survey_assignments_unique_per_profile" UNIQUE using index "survey_assignments_unique_per_profile";

alter table "public"."survey_responses" add constraint "survey_responses_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE not valid;

alter table "public"."survey_responses" validate constraint "survey_responses_profile_id_fkey";

alter table "public"."survey_responses" add constraint "survey_responses_survey_id_fkey" FOREIGN KEY (survey_id) REFERENCES surveys(id) ON DELETE CASCADE not valid;

alter table "public"."survey_responses" validate constraint "survey_responses_survey_id_fkey";

alter table "public"."survey_responses" add constraint "survey_responses_unique_per_profile" UNIQUE using index "survey_responses_unique_per_profile";

alter table "public"."survey_templates" add constraint "survey_templates_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE not valid;

alter table "public"."survey_templates" validate constraint "survey_templates_class_id_fkey";

alter table "public"."survey_templates" add constraint "survey_templates_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE CASCADE not valid;

alter table "public"."survey_templates" validate constraint "survey_templates_created_by_fkey";

alter table "public"."surveys" add constraint "chk_survey_type_assigned_to_all_consistency" CHECK (((type IS NOT NULL) AND (assigned_to_all IS NOT NULL) AND (((type = 'assign_all'::survey_type) AND (assigned_to_all = true)) OR ((type = ANY (ARRAY['specific'::survey_type, 'peer'::survey_type])) AND (assigned_to_all = false))))) not valid;

alter table "public"."surveys" validate constraint "chk_survey_type_assigned_to_all_consistency";

alter table "public"."surveys" add constraint "surveys_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE not valid;

alter table "public"."surveys" validate constraint "surveys_class_id_fkey";

alter table "public"."surveys" add constraint "surveys_created_by_fkey" FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE CASCADE not valid;

alter table "public"."surveys" validate constraint "surveys_created_by_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.authorizeforanyclassstaff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_privileges up
    WHERE up.user_id = auth.uid()
    AND up.role IN ('instructor', 'grader')
  );
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_live_poll_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    target_class_id bigint;
    staff_payload jsonb;
    affected_profile_ids uuid[];
    profile_id uuid;
BEGIN
    -- Get the class_id from the record
    IF TG_OP = 'INSERT' THEN
        target_class_id := NEW.class_id;
    ELSIF TG_OP = 'UPDATE' THEN
        target_class_id := COALESCE(NEW.class_id, OLD.class_id);
    ELSIF TG_OP = 'DELETE' THEN
        target_class_id := OLD.class_id;
    END IF;

    IF target_class_id IS NOT NULL THEN
        -- Create payload
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
            'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            'class_id', target_class_id,
            'timestamp', NOW()
        );

        -- Broadcast to staff channel
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );

        -- Broadcast to all students using class-wide student channel
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':students',
            true
        );
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.broadcast_live_poll_response_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    target_class_id bigint;
    target_poll_id uuid;
    staff_payload jsonb;
BEGIN
    -- Get the poll_id and class_id
    IF TG_OP = 'INSERT' THEN
        target_poll_id := NEW.live_poll_id;
    ELSIF TG_OP = 'UPDATE' THEN
        target_poll_id := COALESCE(NEW.live_poll_id, OLD.live_poll_id);
    ELSIF TG_OP = 'DELETE' THEN
        target_poll_id := OLD.live_poll_id;
    END IF;

    -- Get class_id from the parent poll
    SELECT class_id INTO target_class_id
    FROM live_polls
    WHERE id = target_poll_id;

    IF target_class_id IS NOT NULL THEN
        -- Create payload
        staff_payload := jsonb_build_object(
            'type', 'table_change',
            'operation', TG_OP,
            'table', TG_TABLE_NAME,
            'row_id', CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
            'data', CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END,
            'class_id', target_class_id,
            'live_poll_id', target_poll_id,
            'timestamp', NOW()
        );

        -- Only broadcast to staff channel (students don't need response updates)
        PERFORM realtime.send(
            staff_payload,
            'broadcast',
            'class:' || target_class_id || ':staff',
            true
        );
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.can_access_poll_response(poll_id uuid, profile_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    -- Early exit: if require_login is false, anyone can access (no user_roles query needed)
    WHEN NOT lp.require_login THEN true
    -- If require_login is true, user must be authenticated
    WHEN lp.require_login AND auth.uid() IS NULL THEN false
    -- If require_login is true and user is authenticated, verify class membership and profile ownership
    WHEN lp.require_login AND auth.uid() IS NOT NULL THEN
      -- User must belong to the poll's class
      authorizeforclass(lp.class_id)
      -- Profile_id must be provided when require_login is true
      AND profile_id IS NOT NULL
      -- Profile_id must belong to the authenticated user (prevents impersonation)
      AND authorizeforprofile(profile_id)
    ELSE false
  END
  FROM public.live_polls lp
  WHERE lp.id = poll_id;
$function$
;

CREATE OR REPLACE FUNCTION public.create_survey_assignments(p_survey_id uuid, p_profile_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_class_id BIGINT;
BEGIN
  -- Verify the caller is an instructor for this survey's class
  SELECT class_id INTO v_class_id
  FROM public.surveys
  WHERE id = p_survey_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Survey not found';
  END IF;
  
  IF NOT authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Permission denied: only instructors can manage survey assignments';
  END IF;
  
  -- Delete existing assignments for this survey
  DELETE FROM survey_assignments WHERE survey_id = p_survey_id;
  
  -- Insert new assignments with class_id
  INSERT INTO survey_assignments (survey_id, profile_id, class_id)
  SELECT p_survey_id, unnest(p_profile_ids), v_class_id
  ON CONFLICT (survey_id, profile_id) DO NOTHING;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.deactivate_expired_polls()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Deactivate polls where deactivates_at has passed
  UPDATE live_polls
  SET is_live = false
  WHERE is_live = true
    AND deactivates_at IS NOT NULL
    AND deactivates_at <= NOW();
END;
$function$
;

CREATE OR REPLACE FUNCTION public.prevent_live_poll_created_by_change()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'Cannot change created_by of a live poll';
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_live_poll_response_submitted_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.is_submitted = TRUE
     AND (OLD.is_submitted = FALSE OR OLD.is_submitted IS NULL) THEN
    NEW.submitted_at = NOW();
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_poll_deactivates_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- When is_live changes from false to true, set deactivates_at to 1 hour from now
  IF NEW.is_live = true AND (OLD.is_live = false OR OLD.is_live IS NULL) THEN
    NEW.deactivates_at := NOW() + INTERVAL '1 hour';
  END IF;
  
  -- When is_live changes from true to false, clear deactivates_at
  IF NEW.is_live = false AND OLD.is_live = true THEN
    NEW.deactivates_at := NULL;
  END IF;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_survey_submitted_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Only set submitted_at when is_submitted flips from false -> true
  IF NEW.is_submitted = TRUE
     AND (OLD.is_submitted = FALSE OR OLD.is_submitted IS NULL) THEN
    NEW.submitted_at = NOW();
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.soft_delete_survey(p_survey_id uuid, p_survey_logical_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_class_id BIGINT;
BEGIN
  SET LOCAL search_path = pg_catalog, public;

  -- Verify survey exists and capture class for authorization
  SELECT class_id
  INTO v_class_id
  FROM public.surveys
  WHERE id = p_survey_id
    AND survey_id = p_survey_logical_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Survey not found';
  END IF;

  IF NOT authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Permission denied: instructor access required';
  END IF;

  -- Soft delete responses tied to any version of this survey
  UPDATE public.survey_responses
  SET deleted_at = NOW()
  WHERE survey_id IN (
    SELECT id FROM public.surveys WHERE survey_id = p_survey_logical_id
  )
    AND deleted_at IS NULL;

  -- Soft delete all survey versions sharing the logical id
  UPDATE public.surveys
  SET deleted_at = NOW()
  WHERE survey_id = p_survey_logical_id
    AND deleted_at IS NULL;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_survey_type_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Columns are NOT NULL with defaults, so direct comparisons are safe
  IF NEW.assigned_to_all = TRUE THEN
    NEW.type := 'assign_all';
  ELSIF NEW.type = 'assign_all' THEN
    NEW.type := 'specific';
  END IF;
  
  NEW.assigned_to_all := (NEW.type = 'assign_all');
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_survey_type_with_assigned_to_all()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Columns are NOT NULL, so direct comparisons are safe
  IF NEW.assigned_to_all IS DISTINCT FROM OLD.assigned_to_all THEN
    IF NEW.assigned_to_all = TRUE THEN
      NEW.type := 'assign_all';
    ELSIF NEW.type = 'assign_all' THEN
      NEW.type := 'specific';
    END IF;
  ELSIF NEW.type IS DISTINCT FROM OLD.type THEN
    NEW.assigned_to_all := (NEW.type = 'assign_all');
  END IF;
  
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.update_updated_at_survey_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$
;

grant delete on table "public"."live_poll_responses" to "anon";

grant insert on table "public"."live_poll_responses" to "anon";

grant references on table "public"."live_poll_responses" to "anon";

grant select on table "public"."live_poll_responses" to "anon";

grant trigger on table "public"."live_poll_responses" to "anon";

grant truncate on table "public"."live_poll_responses" to "anon";

grant update on table "public"."live_poll_responses" to "anon";

grant delete on table "public"."live_poll_responses" to "authenticated";

grant insert on table "public"."live_poll_responses" to "authenticated";

grant references on table "public"."live_poll_responses" to "authenticated";

grant select on table "public"."live_poll_responses" to "authenticated";

grant trigger on table "public"."live_poll_responses" to "authenticated";

grant truncate on table "public"."live_poll_responses" to "authenticated";

grant update on table "public"."live_poll_responses" to "authenticated";

grant delete on table "public"."live_poll_responses" to "service_role";

grant insert on table "public"."live_poll_responses" to "service_role";

grant references on table "public"."live_poll_responses" to "service_role";

grant select on table "public"."live_poll_responses" to "service_role";

grant trigger on table "public"."live_poll_responses" to "service_role";

grant truncate on table "public"."live_poll_responses" to "service_role";

grant update on table "public"."live_poll_responses" to "service_role";

grant delete on table "public"."live_polls" to "anon";

grant insert on table "public"."live_polls" to "anon";

grant references on table "public"."live_polls" to "anon";

grant select on table "public"."live_polls" to "anon";

grant trigger on table "public"."live_polls" to "anon";

grant truncate on table "public"."live_polls" to "anon";

grant update on table "public"."live_polls" to "anon";

grant delete on table "public"."live_polls" to "authenticated";

grant insert on table "public"."live_polls" to "authenticated";

grant references on table "public"."live_polls" to "authenticated";

grant select on table "public"."live_polls" to "authenticated";

grant trigger on table "public"."live_polls" to "authenticated";

grant truncate on table "public"."live_polls" to "authenticated";

grant update on table "public"."live_polls" to "authenticated";

grant delete on table "public"."live_polls" to "service_role";

grant insert on table "public"."live_polls" to "service_role";

grant references on table "public"."live_polls" to "service_role";

grant select on table "public"."live_polls" to "service_role";

grant trigger on table "public"."live_polls" to "service_role";

grant truncate on table "public"."live_polls" to "service_role";

grant update on table "public"."live_polls" to "service_role";

grant delete on table "public"."survey_assignments" to "anon";

grant insert on table "public"."survey_assignments" to "anon";

grant references on table "public"."survey_assignments" to "anon";

grant select on table "public"."survey_assignments" to "anon";

grant trigger on table "public"."survey_assignments" to "anon";

grant truncate on table "public"."survey_assignments" to "anon";

grant update on table "public"."survey_assignments" to "anon";

grant delete on table "public"."survey_assignments" to "authenticated";

grant insert on table "public"."survey_assignments" to "authenticated";

grant references on table "public"."survey_assignments" to "authenticated";

grant select on table "public"."survey_assignments" to "authenticated";

grant trigger on table "public"."survey_assignments" to "authenticated";

grant truncate on table "public"."survey_assignments" to "authenticated";

grant update on table "public"."survey_assignments" to "authenticated";

grant delete on table "public"."survey_assignments" to "service_role";

grant insert on table "public"."survey_assignments" to "service_role";

grant references on table "public"."survey_assignments" to "service_role";

grant select on table "public"."survey_assignments" to "service_role";

grant trigger on table "public"."survey_assignments" to "service_role";

grant truncate on table "public"."survey_assignments" to "service_role";

grant update on table "public"."survey_assignments" to "service_role";

grant delete on table "public"."survey_responses" to "anon";

grant insert on table "public"."survey_responses" to "anon";

grant references on table "public"."survey_responses" to "anon";

grant select on table "public"."survey_responses" to "anon";

grant trigger on table "public"."survey_responses" to "anon";

grant truncate on table "public"."survey_responses" to "anon";

grant update on table "public"."survey_responses" to "anon";

grant delete on table "public"."survey_responses" to "authenticated";

grant insert on table "public"."survey_responses" to "authenticated";

grant references on table "public"."survey_responses" to "authenticated";

grant select on table "public"."survey_responses" to "authenticated";

grant trigger on table "public"."survey_responses" to "authenticated";

grant truncate on table "public"."survey_responses" to "authenticated";

grant update on table "public"."survey_responses" to "authenticated";

grant delete on table "public"."survey_responses" to "service_role";

grant insert on table "public"."survey_responses" to "service_role";

grant references on table "public"."survey_responses" to "service_role";

grant select on table "public"."survey_responses" to "service_role";

grant trigger on table "public"."survey_responses" to "service_role";

grant truncate on table "public"."survey_responses" to "service_role";

grant update on table "public"."survey_responses" to "service_role";

grant delete on table "public"."survey_templates" to "anon";

grant insert on table "public"."survey_templates" to "anon";

grant references on table "public"."survey_templates" to "anon";

grant select on table "public"."survey_templates" to "anon";

grant trigger on table "public"."survey_templates" to "anon";

grant truncate on table "public"."survey_templates" to "anon";

grant update on table "public"."survey_templates" to "anon";

grant delete on table "public"."survey_templates" to "authenticated";

grant insert on table "public"."survey_templates" to "authenticated";

grant references on table "public"."survey_templates" to "authenticated";

grant select on table "public"."survey_templates" to "authenticated";

grant trigger on table "public"."survey_templates" to "authenticated";

grant truncate on table "public"."survey_templates" to "authenticated";

grant update on table "public"."survey_templates" to "authenticated";

grant delete on table "public"."survey_templates" to "service_role";

grant insert on table "public"."survey_templates" to "service_role";

grant references on table "public"."survey_templates" to "service_role";

grant select on table "public"."survey_templates" to "service_role";

grant trigger on table "public"."survey_templates" to "service_role";

grant truncate on table "public"."survey_templates" to "service_role";

grant update on table "public"."survey_templates" to "service_role";

grant delete on table "public"."surveys" to "anon";

grant insert on table "public"."surveys" to "anon";

grant references on table "public"."surveys" to "anon";

grant select on table "public"."surveys" to "anon";

grant trigger on table "public"."surveys" to "anon";

grant truncate on table "public"."surveys" to "anon";

grant update on table "public"."surveys" to "anon";

grant delete on table "public"."surveys" to "authenticated";

grant insert on table "public"."surveys" to "authenticated";

grant references on table "public"."surveys" to "authenticated";

grant select on table "public"."surveys" to "authenticated";

grant trigger on table "public"."surveys" to "authenticated";

grant truncate on table "public"."surveys" to "authenticated";

grant update on table "public"."surveys" to "authenticated";

grant delete on table "public"."surveys" to "service_role";

grant insert on table "public"."surveys" to "service_role";

grant references on table "public"."surveys" to "service_role";

grant select on table "public"."surveys" to "service_role";

grant trigger on table "public"."surveys" to "service_role";

grant truncate on table "public"."surveys" to "service_role";

grant update on table "public"."surveys" to "service_role";

create policy "live_polls_responses_all_staff"
on "public"."live_poll_responses"
as permissive
for all
to authenticated
using ((EXISTS ( SELECT 1
   FROM live_polls lp
  WHERE ((lp.id = live_poll_responses.live_poll_id) AND authorizeforclassgrader(lp.class_id)))))
with check ((EXISTS ( SELECT 1
   FROM live_polls lp
  WHERE ((lp.id = live_poll_responses.live_poll_id) AND authorizeforclassgrader(lp.class_id)))));


create policy "live_polls_responses_insert"
on "public"."live_poll_responses"
as permissive
for insert
to anon, authenticated
with check (can_access_poll_response(live_poll_id, public_profile_id));


create policy "live_polls_all_staff_delete"
on "public"."live_polls"
as permissive
for delete
to authenticated
using (authorizeforclassgrader(class_id));


create policy "live_polls_all_staff_insert"
on "public"."live_polls"
as permissive
for insert
to authenticated
with check ((authorizeforclassgrader(class_id) AND authorizeforprofile(created_by)));


create policy "live_polls_all_staff_update"
on "public"."live_polls"
as permissive
for update
to authenticated
using (authorizeforclassgrader(class_id))
with check (authorizeforclassgrader(class_id));


create policy "live_polls_select"
on "public"."live_polls"
as permissive
for select
to anon, authenticated
using (true);


create policy "survey_assignments_delete_instructors"
on "public"."survey_assignments"
as permissive
for delete
to authenticated
using (authorizeforclassinstructor(class_id));


create policy "survey_assignments_insert_instructors"
on "public"."survey_assignments"
as permissive
for insert
to authenticated
with check (authorizeforclassinstructor(class_id));


create policy "survey_assignments_manage_instructors"
on "public"."survey_assignments"
as permissive
for select
to authenticated
using (authorizeforclassinstructor(class_id));


create policy "survey_assignments_select_assignee"
on "public"."survey_assignments"
as permissive
for select
to authenticated
using ((EXISTS ( SELECT 1
   FROM user_privileges up
  WHERE ((up.user_id = auth.uid()) AND ((up.private_profile_id = survey_assignments.profile_id) OR (up.public_profile_id = survey_assignments.profile_id))))));


create policy "survey_assignments_select_class_member"
on "public"."survey_assignments"
as permissive
for select
to authenticated
using (authorizeforclass(class_id));


create policy "survey_assignments_select_graders"
on "public"."survey_assignments"
as permissive
for select
to authenticated
using (authorizeforclassgrader(class_id));


create policy "survey_assignments_update_instructors"
on "public"."survey_assignments"
as permissive
for update
to authenticated
using (authorizeforclassinstructor(class_id))
with check (authorizeforclassinstructor(class_id));


create policy "survey_responses_insert_owner"
on "public"."survey_responses"
as permissive
for insert
to public
with check ((EXISTS ( SELECT 1
   FROM user_privileges up
  WHERE ((up.user_id = auth.uid()) AND ((up.public_profile_id = survey_responses.profile_id) OR (up.private_profile_id = survey_responses.profile_id))))));


create policy "survey_responses_select_owner"
on "public"."survey_responses"
as permissive
for select
to public
using ((EXISTS ( SELECT 1
   FROM user_privileges up
  WHERE ((up.user_id = auth.uid()) AND ((up.public_profile_id = survey_responses.profile_id) OR (up.private_profile_id = survey_responses.profile_id))))));


create policy "survey_responses_select_staff"
on "public"."survey_responses"
as permissive
for select
to public
using ((EXISTS ( SELECT 1
   FROM (surveys s
     JOIN user_privileges up ON ((up.class_id = s.class_id)))
  WHERE ((s.id = survey_responses.survey_id) AND (up.user_id = auth.uid()) AND (up.role = ANY (ARRAY['instructor'::app_role, 'grader'::app_role]))))));


create policy "survey_responses_update_owner"
on "public"."survey_responses"
as permissive
for update
to public
using ((EXISTS ( SELECT 1
   FROM user_privileges up
  WHERE ((up.user_id = auth.uid()) AND ((up.public_profile_id = survey_responses.profile_id) OR (up.private_profile_id = survey_responses.profile_id))))))
with check ((EXISTS ( SELECT 1
   FROM user_privileges up
  WHERE ((up.user_id = auth.uid()) AND ((up.public_profile_id = survey_responses.profile_id) OR (up.private_profile_id = survey_responses.profile_id))))));


create policy "survey_templates_delete"
on "public"."survey_templates"
as permissive
for delete
to public
using ((EXISTS ( SELECT 1
   FROM user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.private_profile_id = survey_templates.created_by)))));


create policy "survey_templates_insert"
on "public"."survey_templates"
as permissive
for insert
to public
with check (authorizeforclassinstructor(class_id));


create policy "survey_templates_select"
on "public"."survey_templates"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) OR ((scope = 'global'::template_scope) AND authorizeforanyclassstaff())));


create policy "survey_templates_update"
on "public"."survey_templates"
as permissive
for update
to public
using (authorizeforclassinstructor(class_id))
with check (authorizeforclassinstructor(class_id));


create policy "surveys_insert_instructors"
on "public"."surveys"
as permissive
for insert
to public
with check (authorizeforclassinstructor(class_id));


create policy "surveys_select_staff"
on "public"."surveys"
as permissive
for select
to public
using ((authorizeforclassgrader(class_id) AND (deleted_at IS NULL)));


create policy "surveys_select_students"
on "public"."surveys"
as permissive
for select
to public
using ((authorizeforclass(class_id) AND (deleted_at IS NULL) AND (status = ANY (ARRAY['published'::survey_status, 'closed'::survey_status])) AND ((assigned_to_all = true) OR (EXISTS ( SELECT 1
   FROM (survey_assignments sa
     JOIN user_privileges up ON (((up.private_profile_id = sa.profile_id) OR (up.public_profile_id = sa.profile_id))))
  WHERE ((sa.survey_id = surveys.id) AND (up.user_id = auth.uid()) AND (up.class_id = surveys.class_id)))))));


create policy "surveys_update_instructors"
on "public"."surveys"
as permissive
for update
to public
using (authorizeforclassinstructor(class_id))
with check (authorizeforclassinstructor(class_id));


CREATE TRIGGER broadcast_live_poll_responses_realtime AFTER INSERT OR DELETE OR UPDATE ON public.live_poll_responses FOR EACH ROW EXECUTE FUNCTION broadcast_live_poll_response_change();

CREATE TRIGGER trg_live_poll_responses_set_submitted_at BEFORE INSERT OR UPDATE ON public.live_poll_responses FOR EACH ROW EXECUTE FUNCTION set_live_poll_response_submitted_at();

CREATE TRIGGER broadcast_live_polls_realtime AFTER INSERT OR DELETE OR UPDATE ON public.live_polls FOR EACH ROW EXECUTE FUNCTION broadcast_live_poll_change();

CREATE TRIGGER prevent_live_poll_created_by_change_trigger BEFORE UPDATE ON public.live_polls FOR EACH ROW EXECUTE FUNCTION prevent_live_poll_created_by_change();

CREATE TRIGGER set_poll_deactivates_at_trigger BEFORE UPDATE ON public.live_polls FOR EACH ROW EXECUTE FUNCTION set_poll_deactivates_at();

CREATE TRIGGER set_survey_submitted_at_trigger BEFORE INSERT OR UPDATE ON public.survey_responses FOR EACH ROW EXECUTE FUNCTION set_survey_submitted_at();

CREATE TRIGGER update_survey_responses_updated_at BEFORE UPDATE ON public.survey_responses FOR EACH ROW EXECUTE FUNCTION update_updated_at_survey_column();

CREATE TRIGGER update_survey_templates_updated_at BEFORE UPDATE ON public.survey_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at_survey_column();

CREATE TRIGGER sync_survey_type_on_insert_trigger BEFORE INSERT ON public.surveys FOR EACH ROW EXECUTE FUNCTION sync_survey_type_on_insert();

CREATE TRIGGER sync_survey_type_trigger BEFORE UPDATE ON public.surveys FOR EACH ROW EXECUTE FUNCTION sync_survey_type_with_assigned_to_all();

CREATE TRIGGER update_surveys_updated_at BEFORE UPDATE ON public.surveys FOR EACH ROW EXECUTE FUNCTION update_updated_at_survey_column();


-- Migration: Add realtime broadcast triggers for surveys, survey_responses, and survey_assignments
-- This enables TableController realtime updates for survey-related tables

-- =============================================================================
-- BROADCAST FUNCTION: surveys table
-- Broadcasts to staff channel when surveys are created, updated, or deleted
-- =============================================================================
CREATE OR REPLACE FUNCTION public.broadcast_survey_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class_id bigint;
  v_row_id text;
  v_operation text;
  v_data jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_class_id := OLD.class_id;
    v_row_id := OLD.id;
    v_operation := 'DELETE';
    v_data := row_to_json(OLD)::jsonb;
  ELSE
    v_class_id := NEW.class_id;
    v_row_id := NEW.id;
    v_operation := TG_OP;
    v_data := row_to_json(NEW)::jsonb;
  END IF;

  -- Broadcast to staff channel (surveys are staff-only data)
  PERFORM public.safe_broadcast(
    jsonb_build_object(
      'type', 'table_change',
      'table', 'surveys',
      'operation', v_operation,
      'row_id', v_row_id,
      'class_id', v_class_id,
      'data', v_data,
      'timestamp', now()::text
    ),
    'broadcast',
    'class:' || v_class_id || ':staff',
    true
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- Create the trigger for surveys
DROP TRIGGER IF EXISTS broadcast_surveys_realtime ON public.surveys;
CREATE TRIGGER broadcast_surveys_realtime
  AFTER INSERT OR UPDATE OR DELETE ON public.surveys
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_survey_change();

-- =============================================================================
-- BROADCAST FUNCTION: survey_responses table
-- Broadcasts to staff channel when responses are created, updated, or deleted
-- =============================================================================
CREATE OR REPLACE FUNCTION public.broadcast_survey_response_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class_id bigint;
  v_survey_id text;
  v_row_id text;
  v_operation text;
  v_data jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row_id := OLD.id;
    v_survey_id := OLD.survey_id;
    v_operation := 'DELETE';
    v_data := row_to_json(OLD)::jsonb;
    -- Get class_id from the survey
    SELECT class_id INTO v_class_id FROM surveys WHERE id = OLD.survey_id;
  ELSE
    v_row_id := NEW.id;
    v_survey_id := NEW.survey_id;
    v_operation := TG_OP;
    v_data := row_to_json(NEW)::jsonb;
    -- Get class_id from the survey
    SELECT class_id INTO v_class_id FROM surveys WHERE id = NEW.survey_id;
  END IF;

  -- Only broadcast if we found a class_id
  IF v_class_id IS NOT NULL THEN
    -- Broadcast to staff channel (responses are staff-only data)
    PERFORM public.safe_broadcast(
      jsonb_build_object(
        'type', 'table_change',
        'table', 'survey_responses',
        'operation', v_operation,
        'row_id', v_row_id,
        'survey_id', v_survey_id,
        'class_id', v_class_id,
        'data', v_data,
        'timestamp', now()::text
      ),
      'broadcast',
      'class:' || v_class_id || ':staff',
      true
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- Create the trigger for survey_responses
DROP TRIGGER IF EXISTS broadcast_survey_responses_realtime ON public.survey_responses;
CREATE TRIGGER broadcast_survey_responses_realtime
  AFTER INSERT OR UPDATE OR DELETE ON public.survey_responses
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_survey_response_change();

-- =============================================================================
-- BROADCAST FUNCTION: survey_assignments table
-- Broadcasts to staff channel when assignments are created, updated, or deleted
-- =============================================================================
CREATE OR REPLACE FUNCTION public.broadcast_survey_assignment_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_class_id bigint;
  v_survey_id text;
  v_row_id text;
  v_operation text;
  v_data jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row_id := OLD.id;
    v_survey_id := OLD.survey_id;
    v_operation := 'DELETE';
    v_data := row_to_json(OLD)::jsonb;
    -- Get class_id from the survey
    SELECT class_id INTO v_class_id FROM surveys WHERE id = OLD.survey_id;
  ELSE
    v_row_id := NEW.id;
    v_survey_id := NEW.survey_id;
    v_operation := TG_OP;
    v_data := row_to_json(NEW)::jsonb;
    -- Get class_id from the survey
    SELECT class_id INTO v_class_id FROM surveys WHERE id = NEW.survey_id;
  END IF;

  -- Only broadcast if we found a class_id
  IF v_class_id IS NOT NULL THEN
    -- Broadcast to staff channel (assignments are staff-only data)
    PERFORM public.safe_broadcast(
      jsonb_build_object(
        'type', 'table_change',
        'table', 'survey_assignments',
        'operation', v_operation,
        'row_id', v_row_id,
        'survey_id', v_survey_id,
        'class_id', v_class_id,
        'data', v_data,
        'timestamp', now()::text
      ),
      'broadcast',
      'class:' || v_class_id || ':staff',
      true
    );
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$;

-- Create the trigger for survey_assignments
DROP TRIGGER IF EXISTS broadcast_survey_assignments_realtime ON public.survey_assignments;
CREATE TRIGGER broadcast_survey_assignments_realtime
  AFTER INSERT OR UPDATE OR DELETE ON public.survey_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public.broadcast_survey_assignment_change();
