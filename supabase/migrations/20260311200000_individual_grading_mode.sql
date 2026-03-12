-- Add individual_grading_mode to rubric_parts
-- When true, the rubric part is graded per-student in a group submission
alter table "public"."rubric_parts" add column "is_individual_grading" boolean not null default false;

-- Add individual_scores JSONB to submission_reviews
-- Stores per-student score breakdown: {"profile_id": score, ...}
alter table "public"."submission_reviews" add column "individual_scores" jsonb;

-- Add target_student_profile_id to submission_comments
-- For individual grading: which student this comment/check applies to
alter table "public"."submission_comments" add column "target_student_profile_id" uuid;
alter table "public"."submission_comments" add constraint "submission_comments_target_student_profile_id_fkey"
  FOREIGN KEY (target_student_profile_id) REFERENCES profiles(id) not valid;
alter table "public"."submission_comments" validate constraint "submission_comments_target_student_profile_id_fkey";

-- Add target_student_profile_id to submission_file_comments
alter table "public"."submission_file_comments" add column "target_student_profile_id" uuid;
alter table "public"."submission_file_comments" add constraint "submission_file_comments_target_student_profile_id_fkey"
  FOREIGN KEY (target_student_profile_id) REFERENCES profiles(id) not valid;
alter table "public"."submission_file_comments" validate constraint "submission_file_comments_target_student_profile_id_fkey";

-- Add target_student_profile_id to submission_artifact_comments
alter table "public"."submission_artifact_comments" add column "target_student_profile_id" uuid;
alter table "public"."submission_artifact_comments" add constraint "submission_artifact_comments_target_student_profile_id_fkey"
  FOREIGN KEY (target_student_profile_id) REFERENCES profiles(id) not valid;
alter table "public"."submission_artifact_comments" validate constraint "submission_artifact_comments_target_student_profile_id_fkey";

-- Update the submissionreviewrecompute trigger to also compute individual_scores
CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  calculated_score int;
  individual_scores_result jsonb;
  the_submission submissions%ROWTYPE;
  existing_submission_review_id int8;
begin
  if 'rubric_check_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    if  NEW.rubric_check_id is null and (OLD is null OR OLD.rubric_check_id is null) then 
     return NEW;
    end if;
  end if;

  if 'submission_review_id' = any(select jsonb_object_keys(to_jsonb(new))) then 
    if NEW.submission_review_id is null then
      return NEW;
    end if;
    existing_submission_review_id = NEW.submission_review_id;
  else
    select * into the_submission from public.submissions where id=NEW.submission_id;
    if the_submission.submission_review_id is null then
      INSERT INTO submission_reviews (total_score,tweak, class_id, submission_id, name) VALUES(0,0, the_submission.class_id, the_submission.id, 'Grading') RETURNING id into existing_submission_review_id;
      UPDATE public.submissions set submission_review_id=existing_submission_review_id where id=the_submission.id;
    else
      existing_submission_review_id = the_submission.submission_review_id;
    end if;
  end if;

  -- Calculate total score (existing logic)
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

  -- Calculate individual scores for individual grading parts
  -- Get all distinct target_student_profile_ids from comments for this review
  WITH student_scores AS (
    SELECT
      target_student_profile_id,
      sum(score) as student_score
    FROM (
      -- File comments for individual grading parts
      SELECT sfc.target_student_profile_id, 
        CASE
          WHEN c.is_additive THEN LEAST(sum(sfc.points), c.total_points)
          ELSE GREATEST(c.total_points - sum(sfc.points), 0)
        END as score
      FROM public.submission_file_comments sfc
      INNER JOIN public.rubric_checks ch ON ch.id = sfc.rubric_check_id
      INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
      INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
      WHERE sfc.submission_review_id = existing_submission_review_id
        AND sfc.deleted_at IS NULL
        AND sfc.target_student_profile_id IS NOT NULL
        AND rp.is_individual_grading = true
      GROUP BY sfc.target_student_profile_id, c.id, c.is_additive, c.total_points

      UNION ALL

      -- Submission comments for individual grading parts
      SELECT sc.target_student_profile_id,
        CASE
          WHEN c.is_additive THEN LEAST(sum(sc.points), c.total_points)
          ELSE GREATEST(c.total_points - sum(sc.points), 0)
        END as score
      FROM public.submission_comments sc
      INNER JOIN public.rubric_checks ch ON ch.id = sc.rubric_check_id
      INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
      INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
      WHERE sc.submission_review_id = existing_submission_review_id
        AND sc.deleted_at IS NULL
        AND sc.target_student_profile_id IS NOT NULL
        AND rp.is_individual_grading = true
      GROUP BY sc.target_student_profile_id, c.id, c.is_additive, c.total_points
    ) AS individual_combo
    GROUP BY target_student_profile_id
  )
  SELECT jsonb_object_agg(target_student_profile_id, student_score)
  INTO individual_scores_result
  FROM student_scores;

  -- Only set individual_scores if there are any individual grading results
  IF individual_scores_result IS NOT NULL THEN
    UPDATE public.submission_reviews 
    SET individual_scores = individual_scores_result 
    WHERE id = existing_submission_review_id;
  END IF;

  return NEW;
end;
$function$;

-- Update submissions_with_grades_for_assignment view to include individual_scores
DROP VIEW IF EXISTS public.submissions_with_grades_for_assignment;

create or replace view "public"."submissions_with_grades_for_assignment" 
WITH ("security_invoker"='true') 
as  SELECT activesubmissionsbystudent.id,
    activesubmissionsbystudent.class_id,
    activesubmissionsbystudent.assignment_id,
    p.id as student_private_profile_id,
    p.name,
    p.sortable_name,
    s.id AS activesubmissionid,
    s.created_at,
    s.released,
    s.repository,
    s.sha,
    rev.total_autograde_score AS autograder_score,
    rev.grader,
    rev.meta_grader,
    rev.total_score,
    rev.tweak,
    rev.completed_by,
    rev.completed_at,
    rev.checked_at,
    rev.checked_by,
    rev.individual_scores,
    graderprofile.name AS assignedgradername,
    metagraderprofile.name AS assignedmetagradername,
    completerprofile.name AS gradername,
    checkgraderprofile.name AS checkername,
    ag.name AS groupname,
    activesubmissionsbystudent.tokens_consumed,
    activesubmissionsbystudent.hours,
    activesubmissionsbystudent.due_date,
    (activesubmissionsbystudent.due_date + ('01:00:00'::interval * (activesubmissionsbystudent.hours)::double precision)) AS late_due_date,
    ar.grader_sha,
    ar.grader_action_sha
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
             LEFT JOIN submissions gsub ON (((gsub.assignment_group_id = agm.assignment_group_id) AND (gsub.is_active = true) AND (gsub.assignment_id = a.id))))
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
