create type "public"."assignment_group_join_status" as enum ('pending', 'approved', 'rejected', 'withdrawn');

create type "public"."assignment_group_mode" as enum ('individual', 'groups', 'both');

drop policy "visible to instructors always, and self conditionally" on "public"."grader_result_output";

drop policy "visible to instructors and self" on "public"."grader_result_tests";

drop policy "visible to instructors and self" on "public"."grader_results";

drop policy "instructors and students can view" on "public"."repositories";

drop policy "can only insert comments as self, for own files (instructors ca" on "public"."submission_file_comments";

drop policy "students view own, instructors view all" on "public"."submission_file_comments";

drop policy "instructors view all, students own" on "public"."submission_files";

drop policy "Instructors can view all submissions in class, students can vie" on "public"."submissions";

drop view if exists "public"."submissions_agg";

create table "public"."assignment_group_invitations" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "assignment_group_id" bigint not null,
    "inviter" uuid not null default gen_random_uuid(),
    "invitee" uuid not null default gen_random_uuid(),
    "class_id" bigint not null
);


alter table "public"."assignment_group_invitations" enable row level security;

create table "public"."assignment_group_join_request" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "assignment_group_id" bigint not null,
    "profile_id" uuid not null,
    "class_id" bigint not null,
    "decision_maker" uuid,
    "decided_at" timestamp with time zone,
    "status" assignment_group_join_status not null default 'pending'::assignment_group_join_status,
    "assignment_id" bigint not null
);


alter table "public"."assignment_group_join_request" enable row level security;

create table "public"."assignment_groups" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "name" text not null,
    "class_id" bigint not null,
    "assignment_id" bigint not null
);


alter table "public"."assignment_groups" enable row level security;

create table "public"."assignment_groups_members" (
    "id" bigint generated by default as identity not null,
    "created_at" timestamp with time zone not null default now(),
    "assignment_group_id" bigint not null,
    "profile_id" uuid not null default gen_random_uuid(),
    "class_id" bigint not null,
    "assignment_id" bigint not null,
    "added_by" uuid not null
);


alter table "public"."assignment_groups_members" enable row level security;

alter table "public"."assignments" add column "allow_student_formed_groups" boolean;

alter table "public"."assignments" add column "group_config" assignment_group_mode;
update "public"."assignments" set "group_config" = 'individual'::assignment_group_mode;
alter table "public"."assignments" alter column "group_config" set not null;

alter table "public"."assignments" add column "group_formation_deadline" timestamp without time zone;

alter table "public"."assignments" add column "max_group_size" integer;

alter table "public"."assignments" add column "min_group_size" integer;

alter table "public"."assignments" alter column "class_id" set not null;

alter table "public"."assignments" alter column "due_date" set not null;

alter table "public"."assignments" alter column "due_date" set data type timestamp without time zone using "due_date"::timestamp without time zone;

update "public"."assignments" set "has_autograder" = false where "has_autograder" is null;

alter table "public"."assignments" alter column "has_autograder" set default false;

alter table "public"."assignments" alter column "has_autograder" set not null;

update "public"."assignments" set "has_handgrader" = true;

alter table "public"."assignments" alter column "has_handgrader" set default true;

alter table "public"."assignments" alter column "has_handgrader" set not null;

alter table "public"."assignments" alter column "latest_due_date" set data type timestamp without time zone using "latest_due_date"::timestamp without time zone;

alter table "public"."assignments" alter column "release_date" set data type timestamp without time zone using "release_date"::timestamp without time zone;

alter table "public"."assignments" alter column "title" set not null;

alter table "public"."grader_result_output" add column "assignment_group_id" bigint;

alter table "public"."grader_result_tests" add column "assignment_group_id" bigint;

alter table "public"."grader_results" add column "assignment_group_id" bigint;

alter table "public"."profiles" add column "is_private_profile" boolean;

update "public"."profiles" set "is_private_profile" = false where "is_private_profile" is null;

alter table "public"."profiles" alter column "is_private_profile" set not null;

alter table "public"."repositories" add column "assignment_group_id" bigint;

alter table "public"."repositories" alter column "profile_id" drop not null;

alter table "public"."submission_files" add column "assignment_group_id" bigint;

alter table "public"."submission_files" alter column "profile_id" drop not null;

alter table "public"."submissions" add column "assignment_group_id" bigint;

alter table "public"."submissions" alter column "profile_id" drop not null;

CREATE UNIQUE INDEX assignment_group_invitation_pkey ON public.assignment_group_invitations USING btree (id);

CREATE UNIQUE INDEX assignment_group_invitations_assignment_group_id_invitee_key ON public.assignment_group_invitations USING btree (assignment_group_id, invitee);

CREATE UNIQUE INDEX assignment_group_join_request_pkey ON public.assignment_group_join_request USING btree (id);

CREATE UNIQUE INDEX assignment_groups_members_pkey ON public.assignment_groups_members USING btree (id);

CREATE UNIQUE INDEX assignment_groups_pkey ON public.assignment_groups USING btree (id);

alter table "public"."assignment_group_invitations" add constraint "assignment_group_invitation_pkey" PRIMARY KEY using index "assignment_group_invitation_pkey";

alter table "public"."assignment_group_join_request" add constraint "assignment_group_join_request_pkey" PRIMARY KEY using index "assignment_group_join_request_pkey";

alter table "public"."assignment_groups" add constraint "assignment_groups_pkey" PRIMARY KEY using index "assignment_groups_pkey";

alter table "public"."assignment_groups_members" add constraint "assignment_groups_members_pkey" PRIMARY KEY using index "assignment_groups_members_pkey";

alter table "public"."assignment_group_invitations" add constraint "assignment_group_invitation_assignment_group_id_fkey" FOREIGN KEY (assignment_group_id) REFERENCES assignment_groups(id) not valid;

alter table "public"."assignment_group_invitations" validate constraint "assignment_group_invitation_assignment_group_id_fkey";

alter table "public"."assignment_group_invitations" add constraint "assignment_group_invitation_invitee_fkey" FOREIGN KEY (invitee) REFERENCES profiles(id) not valid;

alter table "public"."assignment_group_invitations" validate constraint "assignment_group_invitation_invitee_fkey";

alter table "public"."assignment_group_invitations" add constraint "assignment_group_invitation_inviter_fkey" FOREIGN KEY (inviter) REFERENCES profiles(id) not valid;

alter table "public"."assignment_group_invitations" validate constraint "assignment_group_invitation_inviter_fkey";

alter table "public"."assignment_group_invitations" add constraint "assignment_group_invitations_assignment_group_id_invitee_key" UNIQUE using index "assignment_group_invitations_assignment_group_id_invitee_key";

alter table "public"."assignment_group_invitations" add constraint "assignment_group_invitations_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."assignment_group_invitations" validate constraint "assignment_group_invitations_class_id_fkey";

alter table "public"."assignment_group_join_request" add constraint "assignment_group_join_request_assignment_group_id_fkey" FOREIGN KEY (assignment_group_id) REFERENCES assignment_groups(id) not valid;

alter table "public"."assignment_group_join_request" validate constraint "assignment_group_join_request_assignment_group_id_fkey";

alter table "public"."assignment_group_join_request" add constraint "assignment_group_join_request_assignment_id_fkey" FOREIGN KEY (assignment_id) REFERENCES assignments(id) not valid;

alter table "public"."assignment_group_join_request" validate constraint "assignment_group_join_request_assignment_id_fkey";

alter table "public"."assignment_group_join_request" add constraint "assignment_group_join_request_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."assignment_group_join_request" validate constraint "assignment_group_join_request_class_id_fkey";

alter table "public"."assignment_group_join_request" add constraint "assignment_group_join_request_decision_maker_fkey" FOREIGN KEY (decision_maker) REFERENCES profiles(id) not valid;

alter table "public"."assignment_group_join_request" validate constraint "assignment_group_join_request_decision_maker_fkey";

alter table "public"."assignment_group_join_request" add constraint "assignment_group_join_request_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) not valid;

alter table "public"."assignment_group_join_request" validate constraint "assignment_group_join_request_profile_id_fkey";

alter table "public"."assignment_group_join_request" add constraint "assignment_group_join_request_profile_id_fkey1" FOREIGN KEY (profile_id) REFERENCES user_roles(private_profile_id) not valid;

alter table "public"."assignment_group_join_request" validate constraint "assignment_group_join_request_profile_id_fkey1";

alter table "public"."assignment_groups" add constraint "assignment_groups_assignment_id_fkey" FOREIGN KEY (assignment_id) REFERENCES assignments(id) not valid;

alter table "public"."assignment_groups" validate constraint "assignment_groups_assignment_id_fkey";

alter table "public"."assignment_groups" add constraint "assignment_groups_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."assignment_groups" validate constraint "assignment_groups_class_id_fkey";

alter table "public"."assignment_groups_members" add constraint "assignment_groups_members_added_by_fkey" FOREIGN KEY (added_by) REFERENCES profiles(id) not valid;

alter table "public"."assignment_groups_members" validate constraint "assignment_groups_members_added_by_fkey";

alter table "public"."assignment_groups_members" add constraint "assignment_groups_members_assignment_group_id_fkey" FOREIGN KEY (assignment_group_id) REFERENCES assignment_groups(id) not valid;

alter table "public"."assignment_groups_members" validate constraint "assignment_groups_members_assignment_group_id_fkey";

alter table "public"."assignment_groups_members" add constraint "assignment_groups_members_assignment_id_fkey" FOREIGN KEY (assignment_id) REFERENCES assignments(id) not valid;

alter table "public"."assignment_groups_members" validate constraint "assignment_groups_members_assignment_id_fkey";

alter table "public"."assignment_groups_members" add constraint "assignment_groups_members_class_id_fkey" FOREIGN KEY (class_id) REFERENCES classes(id) not valid;

alter table "public"."assignment_groups_members" validate constraint "assignment_groups_members_class_id_fkey";

alter table "public"."assignment_groups_members" add constraint "assignment_groups_members_profile_id_fkey" FOREIGN KEY (profile_id) REFERENCES profiles(id) not valid;

alter table "public"."assignment_groups_members" validate constraint "assignment_groups_members_profile_id_fkey";

alter table "public"."assignment_groups_members" add constraint "assignment_groups_members_profile_id_fkey1" FOREIGN KEY (profile_id) REFERENCES user_roles(private_profile_id) not valid;

alter table "public"."assignment_groups_members" validate constraint "assignment_groups_members_profile_id_fkey1";

alter table "public"."grader_result_output" add constraint "grader_result_output_assignment_group_id_fkey" FOREIGN KEY (assignment_group_id) REFERENCES assignment_groups(id) not valid;

alter table "public"."grader_result_output" validate constraint "grader_result_output_assignment_group_id_fkey";

alter table "public"."grader_result_tests" add constraint "grader_result_tests_assignment_group_id_fkey" FOREIGN KEY (assignment_group_id) REFERENCES assignment_groups(id) not valid;

alter table "public"."grader_result_tests" validate constraint "grader_result_tests_assignment_group_id_fkey";

alter table "public"."grader_results" add constraint "grader_results_assignment_group_id_fkey" FOREIGN KEY (assignment_group_id) REFERENCES assignment_groups(id) not valid;

alter table "public"."grader_results" validate constraint "grader_results_assignment_group_id_fkey";

alter table "public"."repositories" add constraint "repositories_assignment_group_id_fkey" FOREIGN KEY (assignment_group_id) REFERENCES assignment_groups(id) not valid;

alter table "public"."repositories" validate constraint "repositories_assignment_group_id_fkey";

alter table "public"."submission_files" add constraint "submission_files_assignment_group_id_fkey" FOREIGN KEY (assignment_group_id) REFERENCES assignment_groups(id) not valid;

alter table "public"."submission_files" validate constraint "submission_files_assignment_group_id_fkey";

alter table "public"."submissions" add constraint "submissions_assignment_group_id_fkey" FOREIGN KEY (assignment_group_id) REFERENCES assignment_groups(id) not valid;

alter table "public"."submissions" validate constraint "submissions_assignment_group_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.assignment_group_join_request_decision()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$BEGIN
   CASE TG_OP
  WHEN 'UPDATE' then
       if new.status != 'pending' and old.status = 'pending' then
            UPDATE assignment_group_join_request AS t
            SET    decided_at = NOW()
            WHERE  t.id = NEW.id;
       end if;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;   
   RETURN NEW;
END$function$
;

CREATE OR REPLACE FUNCTION public.authorizeforassignmentgroup(_assignment_group_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$declare
  bind_permissions int;
begin

  -- Fetch user role once and store it to reduce number of calls
  select count(*)
  into bind_permissions
  from public.user_roles as r
  inner join public.assignment_groups_members m on m.profile_id=r.private_profile_id
  where m.assignment_group_id=_assignment_group_id and r.user_id=auth.uid();

  return bind_permissions > 0;
end;$function$
;

CREATE OR REPLACE FUNCTION public.notification_assignment_group_invitations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
   body jsonb;
   subject jsonb;
   style text;
   inviter_name text;
   group_name text;
   assignment assignments%ROWTYPE;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      SELECT name into group_name FROM assignment_groups WHERE id=NEW.assignment_group_id;
      select name into inviter_name FROM profiles WHERE id=NEW.inviter;
      select a.* into assignment FROM assignments  as a
      inner join assignment_groups g on g.assignment_id=a.id
      WHERE g.id=NEW.assignment_group_id;
      body := jsonb_build_object(
         'type', 'assignment_group_invitations',
         'action', 'create',
         'inviter',NEW.inviter,
         'invitee',NEW.invitee,
         'inviter_name',inviter_name,
         'assignment_id',assignment.id,
         'assignment_name',assignment.title,
         'assignment_group_name',group_name,
         'assignment_group_id',NEW.assignment_group_id
      );
      subject := '{}';
      style := 'info';
      INSERT INTO notifications (class_id, subject, body, style, user_id)
      SELECT NEW.class_id,subject, body, style, user_id FROM 
      user_roles where private_profile_id=NEW.invitee;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.notification_assignment_group_join_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
   body jsonb;
   subject jsonb;
   style text;
   requestor_name text;
   decision_maker_name text;
   group_name text;
   assignment_name text;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      SELECT name into group_name FROM assignment_groups WHERE id=NEW.assignment_group_id;
      select name into requestor_name FROM profiles WHERE id=NEW.profile_id;
      select title into assignment_name FROM assignments WHERE id=NEW.assignment_id;
      body := jsonb_build_object(
         'type', 'assignment_group_join_request',
         'action', 'create',
         'status', NEW.status,
         'requestor',NEW.profile_id,
         'requestor_name',requestor_name,
         'assignment_id',NEW.assignment_id,
         'assignment_name',assignment_name,
         'assignment_group_name',group_name,
         'assignment_group_id',NEW.assignment_group_id
      );
      subject := '{}';
      style := 'info';
      INSERT INTO notifications (class_id, subject, body, style, user_id)
      SELECT NEW.class_id,subject, body, style, user_id from
      user_roles r inner join 
      assignment_groups_members m on m.profile_id=r.private_profile_id
      WHERE m.assignment_group_id = NEW.assignment_group_id;
   WHEN 'UPDATE' then
      SELECT name into group_name FROM assignment_groups WHERE id=NEW.assignment_group_id;
      select name into requestor_name FROM profiles WHERE id=NEW.profile_id;
      select title into assignment_name FROM assignments WHERE id=NEW.assignment_id;
      IF NEW.status = 'withdrawn' then
        body := jsonb_build_object(
          'type', 'assignment_group_join_request',
          'action', 'update',
          'status', NEW.status,
          'requestor',NEW.profile_id,
          'requestor_name',requestor_name,
          'assignment_id',NEW.assignment_id,
          'assignment_name',assignment_name,
          'assignment_group_name',group_name,
          'assignment_group_id',NEW.assignment_group_id
        );
        subject := '{}';
        style := 'info';
        INSERT INTO notifications (class_id, subject, body, style, user_id)
        SELECT NEW.class_id,subject, body, style, user_id from
        user_roles r inner join 
        assignment_groups_members m on m.profile_id=r.private_profile_id
        WHERE m.assignment_group_id = NEW.assignment_group_id;
      END IF;
      IF NEW.status = 'approved' or NEW.status = 'rejected' THEN
         SELECT name into decision_maker_name from profiles where id=NEW.decision_maker;
         body := jsonb_build_object(
          'type', 'assignment_group_join_request',
          'action', 'update',
          'status', NEW.status,
          'requestor',NEW.profile_id,
          'requestor_name',requestor_name,
          'assignment_id',NEW.assignment_id,
          'assignment_name',assignment_name,
          'assignment_group_name',group_name,
          'assignment_group_id',NEW.assignment_group_id,
          'decision_maker',NEW.decision_maker,
          'decision_maker_name',decision_maker_name
        );
        subject := '{}';
        style := 'info';
        INSERT INTO notifications (class_id, subject, body, style, user_id)
        SELECT NEW.class_id,subject, body, style, user_id from
        user_roles r WHERE private_profile_id=NEW.profile_id;
      END IF;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$function$
;

CREATE OR REPLACE FUNCTION public.notification_assignment_group_member()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
   body jsonb;
   subject jsonb;
   style text;
   member_name text;
   added_by_name text;
   group_name text;
   assignment_name text;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      SELECT name into group_name FROM assignment_groups WHERE id=NEW.assignment_group_id;
      select name into member_name FROM profiles WHERE id=NEW.profile_id;
      select name into added_by_name FROM profiles WHERE id=NEW.added_by;
      select title into assignment_name FROM assignments WHERE id=NEW.assignment_id;
      body := jsonb_build_object(
         'type', 'assignment_group_member',
         'action', 'join',
         'added_by',NEW.added_by,
         'added_by_name',added_by_name,
         'profile_id',NEW.profile_id,
         'name',member_name,
         'assignment_id',NEW.assignment_id,
         'assignment_name',assignment_name,
         'assignment_group_name',group_name,
         'assignment_group_id',NEW.assignment_group_id
      );
      subject := '{}';
      style := 'info';
      INSERT INTO notifications (class_id, subject, body, style, user_id)
      SELECT NEW.class_id,subject, body, style, user_id FROM 
      user_roles r inner join 
      assignment_groups_members m on m.profile_id=r.private_profile_id
      WHERE m.assignment_group_id = NEW.assignment_group_id and m.profile_id != NEW.profile_id;
  WHEN 'DELETE' then
          SELECT name into group_name FROM assignment_groups WHERE id=OLD.assignment_group_id;
      select name into member_name FROM profiles WHERE id=OLD.profile_id;
      select name into added_by_name FROM profiles WHERE id=OLD.added_by;
      select title into assignment_name FROM assignments WHERE id=OLD.assignment_id;
      body := jsonb_build_object(
         'type', 'assignment_group_member',
         'action', 'leave',
         'added_by',OLD.added_by,
         'profile_id',OLD.profile_id,
         'name',member_name,
         'assignment_id',OLD.assignment_id,
         'assignment_name',assignment_name,
         'assignment_group_name',group_name,
         'assignment_group_id',OLD.assignment_group_id
      );
      subject := '{}';
      style := 'info';
      INSERT INTO notifications (class_id, subject, body, style, user_id)
      SELECT OLD.class_id,subject, body, style, user_id FROM 
      user_roles r inner join 
      assignment_groups_members m on m.profile_id=r.private_profile_id
      WHERE m.assignment_group_id = OLD.assignment_group_id;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
   RETURN NEW;
END
$function$
;

create or replace view "public"."submissions_agg" with (security = invoker) as  SELECT c.profile_id,
    groups.name AS groupname,
    c.submissioncount,
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
   FROM (((( SELECT count(submissions.id) AS submissioncount,
            max(submissions.id) AS latestsubmissionid,
            r.private_profile_id AS profile_id
           FROM ((user_roles r
             LEFT JOIN assignment_groups_members m ON ((m.profile_id = r.private_profile_id)))
             LEFT JOIN submissions ON (((submissions.profile_id = r.private_profile_id) OR (submissions.assignment_group_id = m.assignment_group_id))))
          GROUP BY submissions.assignment_id, r.private_profile_id) c
     LEFT JOIN submissions s ON ((s.id = c.latestsubmissionid)))
     LEFT JOIN assignment_groups groups ON ((groups.id = s.assignment_group_id)))
     LEFT JOIN grader_results g ON ((g.submission_id = s.id)));


CREATE OR REPLACE FUNCTION public.user_register_create_demo_account()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$declare
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
         INSERT INTO public.users (user_id) VALUES (NEW.id);
      end if;
      SELECT id FROM public.classes WHERE is_demo LIMIT 1 INTO demo_class_id;
      if demo_class_id is not null then
        INSERT INTO public.profiles (name, avatar_url, class_id, is_private_profile) VALUES
            (NEW.email, 'https://api.dicebear.com/9.x/identicon/svg?seed=' || NEW.email, demo_class_id, TRUE) RETURNING id into new_private_profile_id;

        INSERT INTO public.profiles (name, avatar_url, class_id, is_private_profile) VALUES
            (public.generate_anon_name(),'https://api.dicebear.com/9.x/identicon/svg?seed='||public.generate_anon_name(), demo_class_id, FALSE) RETURNING id into new_public_profile_id; 

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
   
END$function$
;

grant delete on table "public"."assignment_group_invitations" to "anon";

grant insert on table "public"."assignment_group_invitations" to "anon";

grant references on table "public"."assignment_group_invitations" to "anon";

grant select on table "public"."assignment_group_invitations" to "anon";

grant trigger on table "public"."assignment_group_invitations" to "anon";

grant truncate on table "public"."assignment_group_invitations" to "anon";

grant update on table "public"."assignment_group_invitations" to "anon";

grant delete on table "public"."assignment_group_invitations" to "authenticated";

grant insert on table "public"."assignment_group_invitations" to "authenticated";

grant references on table "public"."assignment_group_invitations" to "authenticated";

grant select on table "public"."assignment_group_invitations" to "authenticated";

grant trigger on table "public"."assignment_group_invitations" to "authenticated";

grant truncate on table "public"."assignment_group_invitations" to "authenticated";

grant update on table "public"."assignment_group_invitations" to "authenticated";

grant delete on table "public"."assignment_group_invitations" to "service_role";

grant insert on table "public"."assignment_group_invitations" to "service_role";

grant references on table "public"."assignment_group_invitations" to "service_role";

grant select on table "public"."assignment_group_invitations" to "service_role";

grant trigger on table "public"."assignment_group_invitations" to "service_role";

grant truncate on table "public"."assignment_group_invitations" to "service_role";

grant update on table "public"."assignment_group_invitations" to "service_role";

grant delete on table "public"."assignment_group_join_request" to "anon";

grant insert on table "public"."assignment_group_join_request" to "anon";

grant references on table "public"."assignment_group_join_request" to "anon";

grant select on table "public"."assignment_group_join_request" to "anon";

grant trigger on table "public"."assignment_group_join_request" to "anon";

grant truncate on table "public"."assignment_group_join_request" to "anon";

grant update on table "public"."assignment_group_join_request" to "anon";

grant delete on table "public"."assignment_group_join_request" to "authenticated";

grant insert on table "public"."assignment_group_join_request" to "authenticated";

grant references on table "public"."assignment_group_join_request" to "authenticated";

grant select on table "public"."assignment_group_join_request" to "authenticated";

grant trigger on table "public"."assignment_group_join_request" to "authenticated";

grant truncate on table "public"."assignment_group_join_request" to "authenticated";

grant update on table "public"."assignment_group_join_request" to "authenticated";

grant delete on table "public"."assignment_group_join_request" to "service_role";

grant insert on table "public"."assignment_group_join_request" to "service_role";

grant references on table "public"."assignment_group_join_request" to "service_role";

grant select on table "public"."assignment_group_join_request" to "service_role";

grant trigger on table "public"."assignment_group_join_request" to "service_role";

grant truncate on table "public"."assignment_group_join_request" to "service_role";

grant update on table "public"."assignment_group_join_request" to "service_role";

grant delete on table "public"."assignment_groups" to "anon";

grant insert on table "public"."assignment_groups" to "anon";

grant references on table "public"."assignment_groups" to "anon";

grant select on table "public"."assignment_groups" to "anon";

grant trigger on table "public"."assignment_groups" to "anon";

grant truncate on table "public"."assignment_groups" to "anon";

grant update on table "public"."assignment_groups" to "anon";

grant delete on table "public"."assignment_groups" to "authenticated";

grant insert on table "public"."assignment_groups" to "authenticated";

grant references on table "public"."assignment_groups" to "authenticated";

grant select on table "public"."assignment_groups" to "authenticated";

grant trigger on table "public"."assignment_groups" to "authenticated";

grant truncate on table "public"."assignment_groups" to "authenticated";

grant update on table "public"."assignment_groups" to "authenticated";

grant delete on table "public"."assignment_groups" to "service_role";

grant insert on table "public"."assignment_groups" to "service_role";

grant references on table "public"."assignment_groups" to "service_role";

grant select on table "public"."assignment_groups" to "service_role";

grant trigger on table "public"."assignment_groups" to "service_role";

grant truncate on table "public"."assignment_groups" to "service_role";

grant update on table "public"."assignment_groups" to "service_role";

grant delete on table "public"."assignment_groups_members" to "anon";

grant insert on table "public"."assignment_groups_members" to "anon";

grant references on table "public"."assignment_groups_members" to "anon";

grant select on table "public"."assignment_groups_members" to "anon";

grant trigger on table "public"."assignment_groups_members" to "anon";

grant truncate on table "public"."assignment_groups_members" to "anon";

grant update on table "public"."assignment_groups_members" to "anon";

grant delete on table "public"."assignment_groups_members" to "authenticated";

grant insert on table "public"."assignment_groups_members" to "authenticated";

grant references on table "public"."assignment_groups_members" to "authenticated";

grant select on table "public"."assignment_groups_members" to "authenticated";

grant trigger on table "public"."assignment_groups_members" to "authenticated";

grant truncate on table "public"."assignment_groups_members" to "authenticated";

grant update on table "public"."assignment_groups_members" to "authenticated";

grant delete on table "public"."assignment_groups_members" to "service_role";

grant insert on table "public"."assignment_groups_members" to "service_role";

grant references on table "public"."assignment_groups_members" to "service_role";

grant select on table "public"."assignment_groups_members" to "service_role";

grant trigger on table "public"."assignment_groups_members" to "service_role";

grant truncate on table "public"."assignment_groups_members" to "service_role";

grant update on table "public"."assignment_groups_members" to "service_role";

create policy "create invitations for own groups"
on "public"."assignment_group_invitations"
as permissive
for insert
to public
with check ((authorizeforprofile(inviter) AND authorizeforassignmentgroup(assignment_group_id)));


create policy "instructors can delete, inviter can delete, invitee can delete"
on "public"."assignment_group_invitations"
as permissive
for delete
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(invitee) OR authorizeforprofile(inviter)));


create policy "instructors view all, invitee views own, group members view own"
on "public"."assignment_group_invitations"
as permissive
for select
to public
using ((authorizeforprofile(invitee) OR authorizeforclassinstructor(class_id) OR authorizeforassignmentgroup(assignment_group_id)));


create policy "instructors view all, students view self AND authorizeForAssign"
on "public"."assignment_group_join_request"
as permissive
for select
to public
using ((authorizeforprofile(profile_id) OR authorizeforclassinstructor(class_id) OR authorizeforassignmentgroup(assignment_group_id)));


create policy "only update if it's your request and you are the decider"
on "public"."assignment_group_join_request"
as permissive
for update
to public
using (((authorizeforprofile(profile_id) OR authorizeforassignmentgroup(assignment_group_id)) AND ((status = 'pending'::assignment_group_join_status) OR (status = 'rejected'::assignment_group_join_status) OR (status = 'withdrawn'::assignment_group_join_status))));


create policy "enrolled in class views all"
on "public"."assignment_groups"
as permissive
for select
to public
using (authorizeforclass(class_id));


create policy "anyone in class can see all"
on "public"."assignment_groups_members"
as permissive
for select
to public
using (authorizeforclass(class_id));


create policy "visible to instructors always, and self conditionally"
on "public"."grader_result_output"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR ((authorizeforprofile(student_id) OR authorizeforassignmentgroup(assignment_group_id)) AND (visibility = 'visible'::feedback_visibility))));


create policy "visible to instructors and self"
on "public"."grader_result_tests"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(student_id) OR authorizeforassignmentgroup(assignment_group_id)));


create policy "visible to instructors and self"
on "public"."grader_results"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(profile_id) OR authorizeforassignmentgroup(assignment_group_id)));


create policy "instructors and students can view"
on "public"."repositories"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(profile_id) OR authorizeforassignmentgroup(assignment_group_id)));


create policy "can only insert comments as self, for own files (instructors ca"
on "public"."submission_file_comments"
as permissive
for insert
to public
with check ((authorizeforprofile(author) AND (authorizeforclassinstructor(class_id) OR authorizeforprofile(( SELECT submissions.profile_id
   FROM submissions
  WHERE (submissions.id = submission_file_comments.submissions_id))) OR authorizeforassignmentgroup(( SELECT submissions.assignment_group_id
   FROM submissions
  WHERE (submissions.id = submission_file_comments.submissions_id))))));


create policy "students view own, instructors view all"
on "public"."submission_file_comments"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(( SELECT submissions.profile_id
   FROM submissions
  WHERE (submissions.id = submission_file_comments.submissions_id))) OR authorizeforassignmentgroup(( SELECT submissions.assignment_group_id
   FROM submissions
  WHERE (submissions.id = submission_file_comments.submissions_id)))));


create policy "instructors view all, students own"
on "public"."submission_files"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(profile_id) OR authorizeforassignmentgroup(assignment_group_id)));


create policy "Instructors can view all submissions in class, students can vie"
on "public"."submissions"
as permissive
for select
to public
using ((authorizeforclassinstructor(class_id) OR authorizeforprofile(profile_id) OR authorizeforassignmentgroup(assignment_group_id)));


CREATE TRIGGER notification_assignment_group_invitations_trigger AFTER INSERT ON public.assignment_group_invitations FOR EACH ROW EXECUTE FUNCTION notification_assignment_group_invitations();

CREATE TRIGGER assignment_group_join_request_decision AFTER UPDATE ON public.assignment_group_join_request FOR EACH ROW EXECUTE FUNCTION assignment_group_join_request_decision();

CREATE TRIGGER notification_assignment_group_join_request_trigger AFTER INSERT OR UPDATE ON public.assignment_group_join_request FOR EACH ROW EXECUTE FUNCTION notification_assignment_group_join_request();

CREATE TRIGGER notification_assignment_group_member_trigger AFTER INSERT OR DELETE ON public.assignment_groups_members FOR EACH ROW EXECUTE FUNCTION notification_assignment_group_member();


