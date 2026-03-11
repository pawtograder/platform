-- Suppress group-related notifications for assignments that have not been released yet.
-- Instructors set up groups before release; students should not see those changes.

CREATE OR REPLACE FUNCTION public.notification_assignment_group_member()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
declare
   body jsonb;
   subject jsonb;
   style text;
   member_name text;
   added_by_name text;
   group_name text;
   assignment_name text;
   v_release_date timestamptz;
BEGIN
   -- Look up the release date once; skip notification when the assignment is unreleased.
   CASE TG_OP
   WHEN 'INSERT' THEN
      SELECT a.release_date INTO v_release_date FROM assignments a WHERE a.id = NEW.assignment_id;
      IF v_release_date IS NULL OR v_release_date > now() THEN
         RETURN NEW;
      END IF;

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
      SELECT a.release_date INTO v_release_date FROM assignments a WHERE a.id = OLD.assignment_id;
      IF v_release_date IS NULL OR v_release_date > now() THEN
         RETURN OLD;
      END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.notification_assignment_group_invitations()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
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
      select a.* into assignment FROM assignments as a
      inner join assignment_groups g on g.assignment_id=a.id
      WHERE g.id=NEW.assignment_group_id;

      IF assignment.release_date IS NULL OR assignment.release_date > now() THEN
         RETURN NEW;
      END IF;

      SELECT name into group_name FROM assignment_groups WHERE id=NEW.assignment_group_id;
      select name into inviter_name FROM profiles WHERE id=NEW.inviter;
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
$function$;

CREATE OR REPLACE FUNCTION public.notification_assignment_group_join_request()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, pg_temp
AS $function$
declare
   body jsonb;
   subject jsonb;
   style text;
   requestor_name text;
   decision_maker_name text;
   group_name text;
   assignment_name text;
   v_release_date timestamptz;
BEGIN
   SELECT a.release_date INTO v_release_date FROM assignments a WHERE a.id = NEW.assignment_id;
   IF v_release_date IS NULL OR v_release_date > now() THEN
      RETURN NEW;
   END IF;

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
$function$;
