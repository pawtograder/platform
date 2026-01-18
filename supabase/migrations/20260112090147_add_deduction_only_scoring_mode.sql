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
  is_grading_review boolean;
  current_tweak numeric;
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
  -- Skip advisory lock if no submission review ID is available
  IF existing_submission_review_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  perform pg_advisory_xact_lock(existing_submission_review_id);

  -- Check if this is the grading review (connected to a grading review rubric)
  -- Code-walk rubrics and other review types should NOT include autograde scores
  select EXISTS(select 1 from submissions where grading_review_id = existing_submission_review_id) into is_grading_review;

  -- Only include autograde score if this is the grading review
  if is_grading_review then
    select sum(t.score) into calculated_autograde_score from grader_results r 
      inner join grader_result_tests t on t.grader_result_id=r.id
      where r.submission_id=NEW.submission_id;
  end if;

  -- Calculate manual grading score from all comment types
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

  -- Get the current tweak value
  select tweak into current_tweak from submission_reviews where id = existing_submission_review_id;

  -- Handle null scores
  if calculated_score is null then
    calculated_score = 0;
  end if;
  if calculated_autograde_score is null then
    calculated_autograde_score = 0;
  end if;
  if current_tweak is null then
    current_tweak = 0;
  end if;

  -- Update the submission review with the calculated total score including tweak
  -- The advisory lock ensures this update is atomic and prevents lost updates
  UPDATE public.submission_reviews 
  SET total_score=calculated_score+calculated_autograde_score+current_tweak,
      total_autograde_score=calculated_autograde_score 
  WHERE id=existing_submission_review_id;

  return NEW;
end;$function$
;

-- Update submissionreviewrecompute_bulk_grader_tests() function to handle deduction_only mode
CREATE OR REPLACE FUNCTION public.submissionreviewrecompute_bulk_grader_tests()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  submission_rec record;
  calculated_score numeric;
  calculated_autograde_score numeric;
  existing_submission_review_id int8;
  is_grading_review boolean;
  current_tweak numeric;
begin
  -- Loop through each unique submission_id that was affected by this statement
  FOR submission_rec IN 
    SELECT DISTINCT submission_id 
    FROM new_table 
    WHERE submission_id IS NOT NULL
  LOOP
    -- Get the grading_review_id for this submission
    SELECT grading_review_id 
    INTO existing_submission_review_id 
    FROM public.submissions 
    WHERE id = submission_rec.submission_id;
    
    -- Skip if no review exists
    IF existing_submission_review_id IS NULL THEN
      CONTINUE;
    END IF;
    
    -- CRITICAL: Add advisory lock to prevent race conditions during concurrent score updates
    -- This ensures only one trigger can update the same submission_review at a time
    PERFORM pg_advisory_xact_lock(existing_submission_review_id);

    -- Check if this is the grading review (connected to a grading review rubric)
    -- Code-walk rubrics and other review types should NOT include autograde scores
    SELECT EXISTS(
      SELECT 1 
      FROM submissions 
      WHERE grading_review_id = existing_submission_review_id
    ) INTO is_grading_review;

    -- Only include autograde score if this is the grading review
    calculated_autograde_score = 0;
    IF is_grading_review THEN
      SELECT COALESCE(sum(t.score), 0) 
      INTO calculated_autograde_score 
      FROM grader_results r 
      INNER JOIN grader_result_tests t ON t.grader_result_id = r.id
      WHERE r.submission_id = submission_rec.submission_id;
    END IF;

    -- Calculate manual grading score from all comment types
    SELECT COALESCE(sum(score), 0) 
    INTO calculated_score 
    FROM (
      SELECT c.id, c.name,
        CASE
          WHEN c.is_deduction_only THEN GREATEST(-COALESCE(sum(comments.points), 0), -c.total_points)
          WHEN c.is_additive THEN LEAST(COALESCE(sum(comments.points), 0), c.total_points)
          ELSE GREATEST(c.total_points - COALESCE(sum(comments.points), 0), 0)
        END AS score
      FROM public.submission_reviews sr
      INNER JOIN public.rubric_criteria c ON c.rubric_id = sr.rubric_id
      INNER JOIN public.rubric_checks ch ON ch.rubric_criteria_id = c.id
      LEFT JOIN (
        SELECT sum(sc.points) AS points, sc.rubric_check_id 
        FROM submission_comments sc 
        WHERE sc.submission_review_id = existing_submission_review_id 
          AND sc.deleted_at IS NULL 
          AND sc.points IS NOT NULL 
        GROUP BY sc.rubric_check_id
        UNION ALL
        SELECT sum(sfc.points) AS points, sfc.rubric_check_id 
        FROM submission_file_comments sfc 
        WHERE sfc.submission_review_id = existing_submission_review_id 
          AND sfc.deleted_at IS NULL 
          AND sfc.points IS NOT NULL 
        GROUP BY sfc.rubric_check_id
        UNION ALL
        SELECT sum(sac.points) AS points, sac.rubric_check_id 
        FROM submission_artifact_comments sac 
        WHERE sac.submission_review_id = existing_submission_review_id 
          AND sac.deleted_at IS NULL 
          AND sac.points IS NOT NULL 
        GROUP BY sac.rubric_check_id
      ) AS comments ON comments.rubric_check_id = ch.id
      WHERE sr.id = existing_submission_review_id 
      GROUP BY c.id
    ) AS combo;

    -- Get the current tweak value
    SELECT COALESCE(tweak, 0) 
    INTO current_tweak 
    FROM submission_reviews 
    WHERE id = existing_submission_review_id;

    -- Update the submission review with the calculated total score including tweak
    -- The advisory lock ensures this update is atomic and prevents lost updates
    UPDATE public.submission_reviews 
    SET total_score = calculated_score + calculated_autograde_score + current_tweak,
        total_autograde_score = calculated_autograde_score 
    WHERE id = existing_submission_review_id;
  END LOOP;

  RETURN NULL; -- Result is ignored for AFTER trigger
END;
$$;

-- Grant execute permissions on the updated functions
GRANT EXECUTE ON FUNCTION "public"."submissionreviewrecompute"() TO authenticated;
GRANT EXECUTE ON FUNCTION "public"."submissionreviewrecompute"() TO service_role;

-- Add comments for the updated functionality
COMMENT ON FUNCTION "public"."submissionreviewrecompute" IS 
'Recalculates submission review total scores including manual grading (with support for additive, subtractive, and deduction-only scoring modes), autograde (only for grading reviews), and instructor tweaks. Uses advisory locks to prevent race conditions.';

COMMENT ON FUNCTION public.submissionreviewrecompute_bulk_grader_tests() IS 
'Statement-level trigger function that recalculates submission review scores for all affected submissions in a single statement. Supports additive, subtractive, and deduction-only scoring modes. This prevents redundant recalculations when inserting multiple test results.';
