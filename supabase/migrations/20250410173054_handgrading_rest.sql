drop trigger if exists "audit_assignments_insert_update" on "public"."assignments";

drop trigger if exists "audit_submission_file_comment_insert_update" on "public"."submission_file_comments";

drop trigger if exists "audit_submissions_insert_update" on "public"."submissions";

drop policy "view own, instructors and graders also view all that they instr"
on "public"."users";

drop function if exists "public"."authorizeforinstructororgraderofstudent"(user_id uuid);

drop view if exists "public"."submissions_agg";

alter table "public"."audit" alter column "ip_addr" drop not null;

alter table "public"."grader_result_tests" add column "is_released" boolean not null default true;

alter table "public"."submissions" add column "is_active" boolean not null default false;

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.authorizeforinstructororgraderofstudent(_user_id uuid)
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
  where ourRole.user_id=auth.uid() and (ourRole.role='instructor' or ourRole.role='grader');

  return bind_permissions > 0;
end;
$function$
;

create policy "view own, instructors and graders also view all that they instr"
on "public"."users"
as permissive
for select
to public
using (((user_id = auth.uid()) OR authorizeforinstructororgraderofstudent(user_id)));


CREATE OR REPLACE FUNCTION public.submission_set_active(_submission_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  the_submission submissions%ROWTYPE;
  the_assignment assignments%ROWTYPE;
begin
  select * into the_submission from public.submissions where id=_submission_id;
  select * into the_assignment from public.assignments where id=the_submission.assignment_id;
  if not authorizeforclassgrader(the_submission.class_id) then
    if not authorize_for_submission(the_submission.id) or the_assignment.due_date > NOW() then
      return false;
    end if;
  end if;

  if the_submission.assignment_group_id is null then
    UPDATE submissions set is_active=false where profile_id=the_submission.profile_id and assignment_id=the_submission.assignment_id;
  else
    UPDATE submissions set is_active=false where assignment_id=the_submission.assignment_id and assignment_group_id=the_submission.assignment_group_id;
  end if;
  UPDATE submissions set is_active=true where id=the_submission.id;
  return true;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.submissions_after_insert_hook()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  new_review_id int8;
  the_grading_rubric_id int8;
BEGIN
   CASE TG_OP
   WHEN 'INSERT' THEN
      SELECT grading_rubric_id into the_grading_rubric_id from assignments where id=NEW.assignment_id;

      INSERT INTO public.submission_reviews (total_score, tweak, class_id, submission_id, name, rubric_id)
                VALUES (0, 0, NEW.class_id, NEW.id, 'Grading', the_grading_rubric_id) RETURNING id into new_review_id;

      UPDATE public.submissions set grading_review_id=new_review_id where id=NEW.id;
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$function$
;

create or replace view "public"."submissions_with_grades_for_assignment"  with ("security_invoker"='true') as   SELECT activesubmissionsbystudent.id,
    activesubmissionsbystudent.class_id,
    activesubmissionsbystudent.assignment_id,
    p.name,
    p.sortable_name,
    s.id AS activesubmissionid,
    s.created_at,
    s.released,
    s.repository,
    s.sha,
    ar.score AS autograder_score,
    rev.grader,
    rev.meta_grader,
    rev.total_score,
    rev.tweak,
    rev.completed_by,
    rev.completed_at,
    rev.checked_at,
    rev.checked_by,
    graderprofile.name AS assignedgradername,
    metagraderprofile.name AS assignedmetagradername,
    completerprofile.name AS gradername,
    checkgraderprofile.name AS checkername,
    ag.name AS groupname
   FROM (((((((((( SELECT r.id,
                CASE
                    WHEN (isub.id IS NULL) THEN gsub.id
                    ELSE isub.id
                END AS sub_id,
            r.private_profile_id,
            r.class_id,
                CASE
                    WHEN (isub.id IS NULL) THEN gsub.assignment_id
                    ELSE isub.assignment_id
                END AS assignment_id,
            agm.id AS assignmentgroupid
           FROM ((((user_roles r
             JOIN assignments a ON ((a.class_id = r.class_id)))
             LEFT JOIN submissions isub ON (((isub.profile_id = r.private_profile_id) AND (isub.is_active = true) AND (isub.assignment_id = a.id))))
             LEFT JOIN assignment_groups_members agm ON (((agm.profile_id = r.private_profile_id) AND (agm.assignment_id = a.id))))
             LEFT JOIN submissions gsub ON (((gsub.assignment_group_id = agm.id) AND (gsub.is_active = true) AND (gsub.assignment_id = a.id))))
          WHERE (r.role = 'student'::app_role)) activesubmissionsbystudent
     JOIN profiles p ON ((p.id = activesubmissionsbystudent.private_profile_id)))
     LEFT JOIN submissions s ON ((s.id = activesubmissionsbystudent.sub_id)))
     LEFT JOIN submission_reviews rev ON ((rev.id = s.grading_review_id)))
     LEFT JOIN grader_results ar ON ((ar.submission_id = s.id)))
     LEFT JOIN assignment_groups ag ON ((ag.id = activesubmissionsbystudent.assignmentgroupid)))
     LEFT JOIN profiles completerprofile ON ((completerprofile.id = rev.completed_by)))
     LEFT JOIN profiles graderprofile ON ((graderprofile.id = rev.grader)))
     LEFT JOIN profiles metagraderprofile ON ((metagraderprofile.id = rev.meta_grader)))
     LEFT JOIN profiles checkgraderprofile ON ((checkgraderprofile.id = rev.checked_by)));


CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  calculated_score int;
  the_submission submissions%ROWTYPE;
  existing_submission_review_id int8;
begin
  if 'rubric_check_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    if  NEW.rubric_check_id is null and (OLD is null OR OLD.rubric_check_id is null) then 
     return NEW;
    end if;
  end if;

  if 'submission_review_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    -- If the field is there but null, we don't have anything to update.
    if NEW.submission_review_id is null then
      return NEW;
    end if;
    -- The submission review we are calculating is the one on the row
    existing_submission_review_id = NEW.submission_review_id;
  else
    -- The submission review we are calculating is the one on the assignment, make sure it exists
    select grading_review_id into existing_submission_review_id from public.submissions where id=NEW.submission_id;
  end if;


  select sum(score) into calculated_score from (select c.id,c.name,
  case
    when c.is_additive then LEAST(sum(sfc.points),c.total_points)
    else GREATEST(c.total_points - sum(sfc.points), 0)
  end as score
  from public.submission_file_comments sfc
  inner join public.rubric_checks ch on ch.id=sfc.rubric_check_id
  inner join public.rubric_criteria c on c.id=ch.rubric_criteria_id
  where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null group by c.id

  union
  select -1 as id, 'autograder' as name, r.score from grader_results r where r.submission_id=NEW.submission_id
  union
  select c.id,c.name,
  case
    when c.is_additive then LEAST(sum(sfc.points),c.total_points)
    else GREATEST(c.total_points - sum(sfc.points), 0)
    end as score
  from public.submission_comments sfc
  inner join public.rubric_checks ch on ch.id=sfc.rubric_check_id
  inner join public.rubric_criteria c on c.id=ch.rubric_criteria_id
  where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null group by c.id


  ) as combo;

  UPDATE public.submission_reviews SET total_score=calculated_score WHERE id=existing_submission_review_id;

  return NEW;
end;
$function$
;

create or replace view "public"."submissions_agg"  with ("security_invoker"='true') as   SELECT c.profile_id,
    p.name,
    p.sortable_name,
    p.avatar_url,
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
   FROM ((((( SELECT count(submissions.id) AS submissioncount,
            max(submissions.id) AS latestsubmissionid,
            r.private_profile_id AS profile_id
           FROM ((user_roles r
             LEFT JOIN assignment_groups_members m ON ((m.profile_id = r.private_profile_id)))
             LEFT JOIN submissions ON (((submissions.profile_id = r.private_profile_id) OR (submissions.assignment_group_id = m.assignment_group_id))))
          GROUP BY submissions.assignment_id, r.private_profile_id) c
     LEFT JOIN submissions s ON ((s.id = c.latestsubmissionid)))
     LEFT JOIN assignment_groups groups ON ((groups.id = s.assignment_group_id)))
     LEFT JOIN grader_results g ON ((g.submission_id = s.id)))
     JOIN profiles p ON ((p.id = c.profile_id)));


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
      NEW.is_active = true;
      if NEW.assignment_group_id is not null then
         UPDATE submissions set is_active=false where assignment_id=NEW.assignment_id and assignment_group_id=NEW.assignment_group_id;
      else
         UPDATE submissions set is_active=false where assignment_id=NEW.assignment_id and profile_id=NEW.profile_id;
      end if;
      RETURN NEW;
   ELSE
      RAISE EXCEPTION 'Unexpected TG_OP: "%". Should not occur!', TG_OP;
   END CASE;
   
END
$function$
;

create policy "instructors read"
on "public"."audit"
as permissive
for select
to public
using (authorizeforclassinstructor(class_id));


CREATE TRIGGER audit_assignment_groups_insert_update AFTER INSERT OR UPDATE ON public.assignment_groups FOR EACH ROW EXECUTE FUNCTION audit_insert_and_update();

CREATE TRIGGER audit_assignment_groups_members_insert_update_delete AFTER INSERT OR DELETE OR UPDATE ON public.assignment_groups_members FOR EACH ROW EXECUTE FUNCTION audit_insert_and_update();

CREATE TRIGGER audit_discussion_thread_insert_update AFTER INSERT OR UPDATE ON public.discussion_threads FOR EACH ROW EXECUTE FUNCTION audit_insert_and_update();

CREATE TRIGGER audit_submission_comment_insert_update AFTER INSERT OR UPDATE ON public.submission_comments FOR EACH ROW EXECUTE FUNCTION audit_insert_and_update();

CREATE TRIGGER submission_reviews_audit_insert_update AFTER INSERT OR UPDATE ON public.submission_reviews FOR EACH ROW EXECUTE FUNCTION audit_insert_and_update();

CREATE TRIGGER submissions_after_insert_hook_trigger AFTER INSERT ON public.submissions FOR EACH ROW EXECUTE FUNCTION submissions_after_insert_hook();

CREATE TRIGGER audit_assignments_insert_update AFTER INSERT OR UPDATE ON public.assignments FOR EACH ROW EXECUTE FUNCTION audit_insert_and_update();

CREATE TRIGGER audit_submission_file_comment_insert_update AFTER INSERT OR UPDATE ON public.submission_file_comments FOR EACH ROW EXECUTE FUNCTION audit_insert_and_update();

CREATE TRIGGER audit_submissions_insert_update AFTER INSERT OR UPDATE ON public.submissions FOR EACH ROW EXECUTE FUNCTION audit_insert_and_update();


