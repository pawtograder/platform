-- Fix race conditions in submission review total_score calculation
-- 
-- Issues addressed:
-- 1. Missing trigger on submission_artifact_comments table
-- 2. Race conditions in submissionreviewrecompute function (lost updates)
-- 3. Add advisory locking to prevent concurrent updates to same submission review

-- First, add the missing trigger for submission_artifact_comments
CREATE TRIGGER submission_artifact_comment_recalculate_submission_review 
AFTER INSERT OR UPDATE ON public.submission_artifact_comments 
FOR EACH ROW EXECUTE FUNCTION submissionreviewrecompute();

-- Update the submissionreviewrecompute function to fix race conditions
CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
declare
  calculated_score numeric;
  calculated_autograde_score numeric;
  the_submission submissions%ROWTYPE;
  existing_submission_review_id int8;
begin
  calculated_score=0;
  calculated_autograde_score=0;
  
  -- Avoid re-entrant work when our own UPDATEs fire triggers
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  
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

  -- CRITICAL: Add advisory lock to prevent race conditions during concurrent score updates
  -- This ensures only one trigger can update the same submission_review at a time
  perform pg_advisory_xact_lock(existing_submission_review_id);

  -- Calculate autograder score
  select sum(t.score) into calculated_autograde_score from grader_results r 
    inner join grader_result_tests t on t.grader_result_id=r.id
    where r.submission_id=NEW.submission_id;

  -- Calculate manual grading score from all comment types
  select sum(score) into calculated_score from (
    select c.id,c.name,
    case
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

  -- Handle null scores
  if calculated_score is null then
    calculated_score = 0;
  end if;
  if calculated_autograde_score is null then
    calculated_autograde_score = 0;
  end if;

  -- Update the submission review with the calculated total score
  -- The advisory lock ensures this update is atomic and prevents lost updates
  UPDATE public.submission_reviews 
  SET total_score=calculated_score+calculated_autograde_score,
      total_autograde_score=calculated_autograde_score 
  WHERE id=existing_submission_review_id;

  return NEW;
end;
$function$;

-- Fix the race condition in gradebook recalculation
-- The submission_review_recalculate_dependent_columns function should NOT use trigger depth protection
-- because it needs to run when scores are updated, even from within other triggers
CREATE OR REPLACE FUNCTION public.submission_review_recalculate_dependent_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    assignment_id bigint;
    dependent_column RECORD;
    submission_student_id uuid;
    group_id bigint;
    messages jsonb[];
BEGIN

    -- Only proceed if total_score or released status actually changed
    IF TG_OP = 'UPDATE' AND NEW.total_score = OLD.total_score AND NEW.released = OLD.released THEN
        RETURN NEW;
    END IF;

    -- 1. Find the assignment, profile, and group for this submission review
    SELECT submissions.assignment_id, submissions.profile_id, submissions.assignment_group_id
      INTO assignment_id, submission_student_id, group_id
      FROM public.submissions
     WHERE submissions.id = NEW.submission_id;

    -- 2. For each gradebook_column that depends on this assignment
    FOR dependent_column IN
        SELECT gradebook_columns.id
        FROM public.gradebook_columns
        WHERE dependencies->'assignments' @> to_jsonb(ARRAY[assignment_id]::bigint[])
    LOOP
        IF submission_student_id IS NOT NULL THEN
            -- Individual submission: add one message
            messages := messages || (
                SELECT array_agg(
                    jsonb_build_object(
                        'gradebook_column_id', dependent_column.id,
                        'student_id', submission_student_id,
                        'is_private', gcs.is_private,
                        'gradebook_column_student_id', gcs.id,
                        'reason', 'individual_submission_score_update'
                    )
                )
                FROM public.gradebook_column_students gcs
                WHERE gcs.gradebook_column_id = dependent_column.id
                AND gcs.student_id = submission_student_id
            );
        ELSIF group_id IS NOT NULL THEN
            -- Group submission: add a message for each student in the group
            messages := messages || (
                SELECT array_agg(
                    jsonb_build_object(
                        'gradebook_column_id', dependent_column.id,
                        'student_id', agm.profile_id,
                        'is_private', gcs.is_private,
                        'gradebook_column_student_id', gcs.id,
                        'reason', 'group_submission_score_update'
                    )
                )
                FROM public.assignment_groups_members agm
                INNER JOIN public.gradebook_column_students gcs ON gcs.gradebook_column_id = dependent_column.id AND gcs.student_id = agm.profile_id
                WHERE agm.assignment_group_id = group_id
            );
        END IF;
    END LOOP;

    -- 3. Send messages using helper function
    PERFORM public.send_gradebook_recalculation_messages(messages);

    RETURN NEW;
END;
$function$;
