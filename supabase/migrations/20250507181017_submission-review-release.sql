CREATE OR REPLACE FUNCTION public.submissionreviewreleasecascade()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
is_grading_review boolean;
begin

if NEW.released != OLD.released then
  UPDATE public.submission_file_comments set released=NEW.released WHERE submission_review_id=NEW.id;
  UPDATE public.submission_comments set released=NEW.released WHERE submission_review_id=NEW.id;
  UPDATE public.submission_artifact_comments set released=NEW.released WHERE submission_review_id=NEW.id;
  -- If this is the "Grading" review, then set the released flag on the submission, to_regrole
  select COUNT(*)>0 into is_grading_review from submissions where grading_review_id = NEW.id and id=NEW.submission_id;
  if is_grading_review then
    if NEW.released then
      update submissions set released=NOW() WHERE id=NEW.submission_id;
    else
      update submissions set released=null WHERE id=NEW.submission_id;
    end if;
  end if;
end if;
return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$declare
  calculated_score numeric;
  the_submission submissions%ROWTYPE;
  existing_submission_review_id int8;
begin
  calculated_score=0;
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
  where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null and sfc.points is not null group by c.id

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
  where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null and sfc.points is not null group by c.id
union
  select c.id,c.name,
  case
    when c.is_additive then LEAST(sum(sfc.points),c.total_points)
    else GREATEST(c.total_points - sum(sfc.points), 0)
    end as score
  from public.submission_artifact_comments sfc
  inner join public.rubric_checks ch on ch.id=sfc.rubric_check_id
  inner join public.rubric_criteria c on c.id=ch.rubric_criteria_id
  where sfc.submission_review_id=existing_submission_review_id and sfc.deleted_at is null and sfc.points is not null group by c.id


  ) as combo;
  if calculated_score is null then
    calculated_score = 0;
  end if;

  UPDATE public.submission_reviews SET total_score=calculated_score WHERE id=existing_submission_review_id;

  return NEW;
end;$function$
;
alter table repositories add column synced_repo_sha text;