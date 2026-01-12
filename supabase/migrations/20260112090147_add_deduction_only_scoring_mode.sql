-- Add is_deduction_only column to rubric_criteria
ALTER TABLE rubric_criteria ADD COLUMN is_deduction_only boolean NOT NULL DEFAULT false;

-- Add CHECK constraint to prevent both is_additive and is_deduction_only being true
ALTER TABLE rubric_criteria ADD CONSTRAINT chk_scoring_mode_exclusive 
  CHECK (NOT (is_additive = true AND is_deduction_only = true));

-- Update submissionreviewrecompute() function to handle deduction_only mode
CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$declare
  calculated_score numeric;
  calculated_autograde_score numeric;
  the_submission submissions%ROWTYPE;
  existing_submission_review_id int8;
begin
  calculated_score=0;
  calculated_autograde_score=0;
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

select sum(t.score) into calculated_autograde_score from grader_results r 
  inner join grader_result_tests t on t.grader_result_id=r.id
  where r.submission_id=NEW.submission_id;

select sum(score) into calculated_score from (
  select c.id,c.name,
  case
    when c.is_deduction_only then GREATEST(-COALESCE(sum(comments.points),0), -c.total_points)
    when c.is_additive then LEAST(COALESCE(sum(comments.points),0),c.total_points)
    else GREATEST(c.total_points - COALESCE(sum(comments.points),0), 0)
    end as score
  from public.submission_reviews sr
  inner join public.rubric_criteria c on c.rubric_id=sr.rubric_id
  inner join public.rubric_checks ch on ch.rubric_criteria_id=c.id
    left join (select sum(sc.points) as points,sc.rubric_check_id from submission_comments sc where sc.submission_review_id=existing_submission_review_id and sc.deleted_at is null and sc.points is not null group by sc.rubric_check_id
    UNION ALL
    select sum(sfc.points) as points,sfc.rubric_check_id from submission_file_comments sfc where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null and sfc.points is not null group by sfc.rubric_check_id
    UNION all
    select sum(sac.points) as points,sac.rubric_check_id from submission_artifact_comments sac where sac.submission_review_id=existing_submission_review_id and sac.deleted_at is null and sac.points is not null group by sac.rubric_check_id
    ) as comments on comments.rubric_check_id=ch.id
  where sr.id=existing_submission_review_id 
   group by c.id) as combo;

  if calculated_score is null then
    calculated_score = 0;
  end if;
  if calculated_autograde_score is null then
    calculated_autograde_score = 0;
  end if;

  UPDATE public.submission_reviews SET total_score=calculated_score+calculated_autograde_score,total_autograde_score=calculated_autograde_score WHERE id=existing_submission_review_id;

  return NEW;
end;$function$
;
