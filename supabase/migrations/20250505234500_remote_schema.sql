drop view if exists "public"."autograder_regression_test_by_grader";

drop view if exists "public"."submissions_agg";

drop view if exists "public"."submissions_with_grades_for_assignment";

alter table "public"."grader_results" alter column "max_score" set default '100'::numeric;

alter table "public"."grader_results" alter column "max_score" set data type numeric using "max_score"::numeric;

alter table "public"."grader_results" alter column "score" set data type numeric using "score"::numeric;

alter table "public"."rubric_checks" add column "annotation_target" text;

alter table "public"."rubric_checks" alter column "points" set data type numeric using "points"::numeric;

alter table "public"."submission_artifact_comments" alter column "points" set data type numeric using "points"::numeric;

alter table "public"."submission_comments" alter column "points" set data type numeric using "points"::numeric;

alter table "public"."submission_file_comments" alter column "points" set data type numeric using "points"::numeric;

alter table "public"."submission_reviews" alter column "total_score" set data type numeric using "total_score"::numeric;

alter table "public"."submission_reviews" alter column "tweak" set data type numeric using "tweak"::numeric;

set check_function_bodies = off;

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


CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$declare
  calculated_score numeric;
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
  select -1 as id, 'autograder' as name, sum(t.score) as score from grader_results r 
  inner join grader_result_tests t on t.grader_result_id=r.id
  where r.submission_id=NEW.submission_id
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
end;$function$
;

create or replace view "public"."submissions_agg" as  SELECT c.profile_id,
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


create or replace view "public"."submissions_with_grades_for_assignment" as  SELECT activesubmissionsbystudent.id,
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
    ag.name AS groupname,
    activesubmissionsbystudent.tokens_consumed,
    activesubmissionsbystudent.hours,
    activesubmissionsbystudent.due_date,
    (activesubmissionsbystudent.due_date + ('01:00:00'::interval * (activesubmissionsbystudent.hours)::double precision)) AS late_due_date
   FROM (((((((((( SELECT r.id,
                CASE
                    WHEN (isub.id IS NULL) THEN gsub.id
                    ELSE isub.id
                END AS sub_id,
            r.private_profile_id,
            r.class_id,
            a.id AS assignment_id,
            agm.assignment_group_id AS assignmentgroupid,
            lt.tokens_consumed,
            lt.hours,
            a.due_date
           FROM (((((user_roles r
             JOIN assignments a ON ((a.class_id = r.class_id)))
             LEFT JOIN submissions isub ON (((isub.profile_id = r.private_profile_id) AND (isub.is_active = true) AND (isub.assignment_id = a.id))))
             LEFT JOIN assignment_groups_members agm ON (((agm.profile_id = r.private_profile_id) AND (agm.assignment_id = a.id))))
             LEFT JOIN ( SELECT sum(assignment_due_date_exceptions.tokens_consumed) AS tokens_consumed,
                    sum(assignment_due_date_exceptions.hours) AS hours,
                    assignment_due_date_exceptions.student_id,
                    assignment_due_date_exceptions.assignment_group_id
                   FROM assignment_due_date_exceptions
                  GROUP BY assignment_due_date_exceptions.student_id, assignment_due_date_exceptions.assignment_group_id) lt ON ((((agm.assignment_group_id IS NULL) AND (lt.student_id = r.private_profile_id)) OR ((agm.assignment_group_id IS NOT NULL) AND (lt.assignment_group_id = agm.assignment_group_id)))))
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



