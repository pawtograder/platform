-- Re-add target_student_profile_id to comment tables for individual grading.
-- Individual grading parts need per-student scope so each student's checks/comments
-- are stored and displayed separately. The simplify migration removed these columns
-- but the per-student rubric check ID approach was never implemented.

ALTER TABLE "public"."submission_comments" ADD COLUMN IF NOT EXISTS "target_student_profile_id" uuid;
ALTER TABLE "public"."submission_comments" DROP CONSTRAINT IF EXISTS "submission_comments_target_student_profile_id_fkey";
ALTER TABLE "public"."submission_comments" ADD CONSTRAINT "submission_comments_target_student_profile_id_fkey"
  FOREIGN KEY (target_student_profile_id) REFERENCES profiles(id) NOT VALID;
ALTER TABLE "public"."submission_comments" VALIDATE CONSTRAINT "submission_comments_target_student_profile_id_fkey";

ALTER TABLE "public"."submission_file_comments" ADD COLUMN IF NOT EXISTS "target_student_profile_id" uuid;
ALTER TABLE "public"."submission_file_comments" DROP CONSTRAINT IF EXISTS "submission_file_comments_target_student_profile_id_fkey";
ALTER TABLE "public"."submission_file_comments" ADD CONSTRAINT "submission_file_comments_target_student_profile_id_fkey"
  FOREIGN KEY (target_student_profile_id) REFERENCES profiles(id) NOT VALID;
ALTER TABLE "public"."submission_file_comments" VALIDATE CONSTRAINT "submission_file_comments_target_student_profile_id_fkey";

ALTER TABLE "public"."submission_artifact_comments" ADD COLUMN IF NOT EXISTS "target_student_profile_id" uuid;
ALTER TABLE "public"."submission_artifact_comments" DROP CONSTRAINT IF EXISTS "submission_artifact_comments_target_student_profile_id_fkey";
ALTER TABLE "public"."submission_artifact_comments" ADD CONSTRAINT "submission_artifact_comments_target_student_profile_id_fkey"
  FOREIGN KEY (target_student_profile_id) REFERENCES profiles(id) NOT VALID;
ALTER TABLE "public"."submission_artifact_comments" VALIDATE CONSTRAINT "submission_artifact_comments_target_student_profile_id_fkey";

-- Update submissionreviewrecompute to compute individual_scores from target_student_profile_id comments
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

  -- Calculate individual scores for individual grading parts (comments with target_student_profile_id)
  WITH student_scores AS (
    SELECT
      target_student_profile_id,
      sum(score) as student_score
    FROM (
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

      UNION ALL

      SELECT sac.target_student_profile_id,
        CASE
          WHEN c.is_additive THEN LEAST(sum(sac.points), c.total_points)
          ELSE GREATEST(c.total_points - sum(sac.points), 0)
        END as score
      FROM public.submission_artifact_comments sac
      INNER JOIN public.rubric_checks ch ON ch.id = sac.rubric_check_id
      INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
      INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
      WHERE sac.submission_review_id = existing_submission_review_id
        AND sac.deleted_at IS NULL
        AND sac.target_student_profile_id IS NOT NULL
        AND rp.is_individual_grading = true
      GROUP BY sac.target_student_profile_id, c.id, c.is_additive, c.total_points
    ) AS individual_combo
    GROUP BY target_student_profile_id
  )
  SELECT jsonb_object_agg(target_student_profile_id, student_score)
  INTO individual_scores_result
  FROM student_scores;

  IF individual_scores_result IS NOT NULL THEN
    UPDATE public.submission_reviews 
    SET individual_scores = individual_scores_result 
    WHERE id = existing_submission_review_id;
  END IF;

  return NEW;
end;
$function$;
