-- Remove target_student_profile_id from comment tables.
-- Individual grading uses unique rubric check IDs per student instead.

ALTER TABLE "public"."submission_comments" DROP CONSTRAINT IF EXISTS "submission_comments_target_student_profile_id_fkey";
ALTER TABLE "public"."submission_comments" DROP COLUMN IF EXISTS "target_student_profile_id";

ALTER TABLE "public"."submission_file_comments" DROP CONSTRAINT IF EXISTS "submission_file_comments_target_student_profile_id_fkey";
ALTER TABLE "public"."submission_file_comments" DROP COLUMN IF EXISTS "target_student_profile_id";

ALTER TABLE "public"."submission_artifact_comments" DROP CONSTRAINT IF EXISTS "submission_artifact_comments_target_student_profile_id_fkey";
ALTER TABLE "public"."submission_artifact_comments" DROP COLUMN IF EXISTS "target_student_profile_id";

-- Revert submissionreviewrecompute to original logic (no individual_scores calc from comments).
-- individual_scores is set by application logic based on per-student rubric part ownership.
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

  return NEW;
end;
$function$;

-- Update submissions_with_reviews_by_round_for_assignment view to include individual_scores.
-- The gradebook scoring function will use individual_scores[student_id] when present.
DROP VIEW IF EXISTS public.submissions_with_reviews_by_round_for_assignment;

CREATE OR REPLACE VIEW public.submissions_with_reviews_by_round_for_assignment
WITH (security_invoker='true')
AS
WITH 
  all_submissions AS (
    SELECT
      ur.private_profile_id,
      a.class_id,
      s.assignment_id,
      a.slug AS assignment_slug,
      s.id AS submission_id
    FROM public.submissions s
    JOIN public.assignments a ON a.id = s.assignment_id
    JOIN public.user_roles ur ON (
      ur.class_id = a.class_id
      AND ur.role = 'student'::public.app_role
      AND ur.disabled = false
      AND ur.private_profile_id = s.profile_id
    )
    WHERE s.is_active = true
      AND s.assignment_group_id IS NULL

    UNION ALL

    SELECT
      agm.profile_id AS private_profile_id,
      a.class_id,
      s.assignment_id,
      a.slug AS assignment_slug,
      s.id AS submission_id
    FROM public.submissions s
    JOIN public.assignments a ON a.id = s.assignment_id
    JOIN public.assignment_groups_members agm ON (
      agm.assignment_id = s.assignment_id
      AND agm.assignment_group_id = s.assignment_group_id
    )
    JOIN public.user_roles ur ON (
      ur.class_id = a.class_id
      AND ur.role = 'student'::public.app_role
      AND ur.disabled = false
      AND ur.private_profile_id = agm.profile_id
    )
    WHERE s.is_active = true
      AND s.assignment_group_id IS NOT NULL
  )

SELECT
  bs.class_id,
  bs.assignment_id,
  bs.assignment_slug,
  bs.private_profile_id AS student_private_profile_id,
  COALESCE(agg.scores_by_round_private, '{}'::jsonb) AS scores_by_round_private,
  COALESCE(agg.scores_by_round_public, '{}'::jsonb) AS scores_by_round_public,
  agg.individual_scores
FROM all_submissions bs
JOIN LATERAL (
  SELECT
    jsonb_object_agg(x.review_round::text, x.total_score) FILTER (WHERE true) AS scores_by_round_private,
    jsonb_object_agg(x.review_round::text, x.total_score) FILTER (WHERE x.released) AS scores_by_round_public,
    (SELECT sr2.individual_scores FROM public.submission_reviews sr2
     WHERE sr2.submission_id = bs.submission_id
     AND sr2.id = (SELECT s.grading_review_id FROM public.submissions s WHERE s.id = bs.submission_id)
    ) AS individual_scores
  FROM (
    SELECT DISTINCT ON (r.review_round)
      r.review_round,
      sr.total_score,
      sr.released,
      sr.completed_at,
      sr.id
    FROM public.submission_reviews sr
    JOIN public.rubrics r ON r.id = sr.rubric_id
    WHERE sr.submission_id = bs.submission_id
    ORDER BY r.review_round, sr.completed_at DESC NULLS LAST, sr.id DESC
  ) x
) agg ON true;

COMMENT ON VIEW public.submissions_with_reviews_by_round_for_assignment IS 
'Optimized view: One row per student per assignment with per-review_round score maps and individual_scores for per-student grading.';
