-- Assign-to-student grading mode: grader picks which student a rubric part applies to.
ALTER TABLE "public"."rubric_parts" ADD COLUMN IF NOT EXISTS "is_assign_to_student" boolean NOT NULL DEFAULT false;

-- Maps rubric_part_id → assigned student profile_id (or null if skipped)
ALTER TABLE "public"."submission_reviews" ADD COLUMN IF NOT EXISTS "rubric_part_student_assignments" jsonb;
-- Extend submissionreviewrecompute to also compute individual_scores.
-- Preserves ALL existing logic (advisory lock, is_deduction_only, score capping, autograde, tweak).
CREATE OR REPLACE FUNCTION public.submissionreviewrecompute()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$declare
  calculated_score numeric;
  calculated_autograde_score numeric;
  the_submission submissions%ROWTYPE;
  existing_submission_review_id int8;
  v_submission_id bigint;
  is_grading_review boolean;
  should_cap boolean;
  assignment_total_points numeric;
  current_tweak numeric;
  individual_scores_result jsonb;
begin
  calculated_score=0;
  calculated_autograde_score=0;
  
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  
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
    select grading_review_id into existing_submission_review_id from public.submissions where id=NEW.submission_id;
  end if;

  IF existing_submission_review_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  SELECT submission_id INTO v_submission_id
  FROM submission_reviews
  WHERE id = existing_submission_review_id;
  
  IF v_submission_id IS NULL THEN
    RETURN NEW;
  END IF;
  
  perform pg_advisory_xact_lock(existing_submission_review_id);

  select EXISTS(select 1 from submissions where grading_review_id = existing_submission_review_id) into is_grading_review;

  if is_grading_review then
    select sum(t.score) into calculated_autograde_score from grader_results r 
      inner join grader_result_tests t on t.grader_result_id=r.id
      where r.submission_id=v_submission_id
        and r.rerun_for_submission_id IS NULL
        and r.autograder_regression_test IS NULL;
  end if;

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

  SELECT COALESCE(tweak, 0) 
  INTO current_tweak 
  FROM submission_reviews 
  WHERE id = existing_submission_review_id;

  SELECT r.cap_score_to_assignment_points INTO should_cap
  FROM public.rubrics r
  INNER JOIN public.submission_reviews sr ON sr.rubric_id = r.id
  WHERE sr.id = existing_submission_review_id;

  calculated_score = calculated_score + calculated_autograde_score + current_tweak;

  IF should_cap THEN
    SELECT a.total_points INTO assignment_total_points
    FROM public.assignments a
    INNER JOIN public.submissions s ON s.assignment_id = a.id
    WHERE s.id = v_submission_id;
    
    IF assignment_total_points IS NOT NULL THEN
      calculated_score = LEAST(calculated_score, assignment_total_points);
    END IF;
  END IF;

  -- individual_scores: combine two sources of per-student scores.
  -- Source 1: is_individual_grading parts — comments have target_student_profile_id.
  -- Source 2: is_assign_to_student parts — student comes from rubric_part_student_assignments JSON.
  WITH
  -- Read the current assignments mapping from the review
  part_assignments AS (
    SELECT (jsonb_each_text(COALESCE(sr.rubric_part_student_assignments, '{}'::jsonb))).*
    FROM public.submission_reviews sr WHERE sr.id = existing_submission_review_id
  ),
  -- Source 1: per-student comments (is_individual_grading parts)
  individual_raw AS (
    SELECT sfc.target_student_profile_id::text as student_id, ch.rubric_criteria_id, sum(sfc.points) as pts
    FROM public.submission_file_comments sfc
    INNER JOIN public.rubric_checks ch ON ch.id = sfc.rubric_check_id
    INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
    INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
    WHERE sfc.submission_review_id = existing_submission_review_id
      AND sfc.deleted_at IS NULL AND sfc.target_student_profile_id IS NOT NULL
      AND rp.is_individual_grading = true
    GROUP BY sfc.target_student_profile_id, ch.rubric_criteria_id
    UNION ALL
    SELECT sc.target_student_profile_id::text, ch.rubric_criteria_id, sum(sc.points)
    FROM public.submission_comments sc
    INNER JOIN public.rubric_checks ch ON ch.id = sc.rubric_check_id
    INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
    INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
    WHERE sc.submission_review_id = existing_submission_review_id
      AND sc.deleted_at IS NULL AND sc.target_student_profile_id IS NOT NULL
      AND rp.is_individual_grading = true
    GROUP BY sc.target_student_profile_id, ch.rubric_criteria_id
    UNION ALL
    SELECT sac.target_student_profile_id::text, ch.rubric_criteria_id, sum(sac.points)
    FROM public.submission_artifact_comments sac
    INNER JOIN public.rubric_checks ch ON ch.id = sac.rubric_check_id
    INNER JOIN public.rubric_criteria c ON c.id = ch.rubric_criteria_id
    INNER JOIN public.rubric_parts rp ON rp.id = c.rubric_part_id
    WHERE sac.submission_review_id = existing_submission_review_id
      AND sac.deleted_at IS NULL AND sac.target_student_profile_id IS NOT NULL
      AND rp.is_individual_grading = true
    GROUP BY sac.target_student_profile_id, ch.rubric_criteria_id
  ),
  -- Source 2: assign-to-student parts — use rubric_part_student_assignments to map part → student
  assigned_raw AS (
    SELECT pa.value as student_id, ch.rubric_criteria_id, sum(comments.points) as pts
    FROM part_assignments pa
    INNER JOIN public.rubric_parts rp ON rp.id = pa.key::bigint AND rp.is_assign_to_student = true
    INNER JOIN public.rubric_criteria c ON c.rubric_part_id = rp.id
    INNER JOIN public.rubric_checks ch ON ch.rubric_criteria_id = c.id
    LEFT JOIN (
      SELECT sc.rubric_check_id, sc.points FROM public.submission_comments sc
      WHERE sc.submission_review_id = existing_submission_review_id AND sc.deleted_at IS NULL AND sc.points IS NOT NULL
      UNION ALL
      SELECT sfc.rubric_check_id, sfc.points FROM public.submission_file_comments sfc
      WHERE sfc.submission_review_id = existing_submission_review_id AND sfc.deleted_at IS NULL AND sfc.points IS NOT NULL
      UNION ALL
      SELECT sac.rubric_check_id, sac.points FROM public.submission_artifact_comments sac
      WHERE sac.submission_review_id = existing_submission_review_id AND sac.deleted_at IS NULL AND sac.points IS NOT NULL
    ) comments ON comments.rubric_check_id = ch.id
    WHERE pa.value IS NOT NULL AND pa.value != ''
    GROUP BY pa.value, ch.rubric_criteria_id
  ),
  all_raw AS (
    SELECT * FROM individual_raw
    UNION ALL
    SELECT * FROM assigned_raw
  ),
  merged_points AS (
    SELECT student_id, rubric_criteria_id, sum(pts) as total_pts
    FROM all_raw GROUP BY student_id, rubric_criteria_id
  ),
  capped_scores AS (
    SELECT mp.student_id,
      CASE WHEN c.is_deduction_only THEN GREATEST(-COALESCE(mp.total_pts, 0), -c.total_points)
           WHEN c.is_additive THEN LEAST(COALESCE(mp.total_pts, 0), c.total_points)
           ELSE GREATEST(c.total_points - COALESCE(mp.total_pts, 0), 0) END as score
    FROM merged_points mp
    INNER JOIN public.rubric_criteria c ON c.id = mp.rubric_criteria_id
  ),
  student_scores AS (
    SELECT student_id, sum(score) as student_score
    FROM capped_scores GROUP BY student_id
  )
  SELECT jsonb_object_agg(student_id, student_score)
  INTO individual_scores_result
  FROM student_scores;

  UPDATE public.submission_reviews
  SET total_score=calculated_score, total_autograde_score=calculated_autograde_score, individual_scores=individual_scores_result
  WHERE id=existing_submission_review_id;

  return NEW;
end;$function$;
