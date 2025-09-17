CREATE OR REPLACE FUNCTION "public"."invoke_gradebook_recalculation_background_task"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    queue_size integer;
    worker_count integer;
BEGIN

    select count(*)::integer into queue_size from pgmq_public.read('gradebook_row_recalculate', 0, 100);
    if queue_size >= 1000 then
        worker_count := 5;
    else 
        worker_count := 2
    end if;
    for i in 1..worker_count loop
        PERFORM public.call_edge_function_internal(
            '/functions/v1/gradebook-column-recalculate', 
            'POST', 
            '{"Content-type":"application/json","x-supabase-webhook-source":"gradebook_column_recalculate"}', 
            '{}', 
            5000,
            NULL,
            NULL,
            NULL,
            NULL,
            NULL
        );
    end loop;
END;
$$;

-- Optimize submissions_with_reviews_by_round_for_assignment view for better performance
-- The original view creates massive Cartesian products. This version uses a simpler, more direct approach
-- that avoids complex nested CTEs and focuses on efficient joins.

DROP VIEW IF EXISTS public.submissions_with_reviews_by_round_for_assignment;

CREATE OR REPLACE VIEW public.submissions_with_reviews_by_round_for_assignment
WITH (security_invoker='true')
AS
WITH 
  -- Get all student-assignment combinations efficiently
  -- This replaces the complex nested CTE structure with a simple direct join
  student_assignments AS (
    SELECT
      ur.private_profile_id,
      a.class_id,
      a.id as assignment_id,
      a.slug as assignment_slug
    FROM public.assignments a
    JOIN public.user_roles ur ON (
      ur.class_id = a.class_id 
      AND ur.role = 'student'::public.app_role
      AND ur.disabled = false
    )
  ),
  
  -- Get all submissions (individual and group) in one pass
  -- This avoids the complex left joins that were creating Cartesian products
  all_submissions AS (
    -- Individual submissions
    SELECT
      sa.private_profile_id,
      sa.class_id,
      sa.assignment_id,
      sa.assignment_slug,
      s.id as submission_id,
      1 as submission_priority  -- Individual submissions have priority
    FROM student_assignments sa
    JOIN public.submissions s ON (
      s.assignment_id = sa.assignment_id
      AND s.profile_id = sa.private_profile_id
      AND s.is_active = true
      AND s.assignment_group_id IS NULL
    )
    
    UNION ALL
    
    -- Group submissions
    SELECT
      sa.private_profile_id,
      sa.class_id,
      sa.assignment_id,
      sa.assignment_slug,
      s.id as submission_id,
      2 as submission_priority  -- Group submissions are secondary
    FROM student_assignments sa
    JOIN public.assignment_groups_members agm ON (
      agm.assignment_id = sa.assignment_id
      AND agm.profile_id = sa.private_profile_id
    )
    JOIN public.submissions s ON (
      s.assignment_id = sa.assignment_id
      AND s.assignment_group_id = agm.assignment_group_id
      AND s.is_active = true
    )
  ),
  
  -- Choose the best submission for each student-assignment pair
  -- Use window function to pick the highest priority submission efficiently
  best_submissions AS (
    SELECT
      private_profile_id,
      class_id,
      assignment_id,
      assignment_slug,
      submission_id,
      ROW_NUMBER() OVER (
        PARTITION BY private_profile_id, assignment_id 
        ORDER BY submission_priority
      ) as rn
    FROM all_submissions
  )

SELECT
  bs.class_id,
  bs.assignment_id,
  bs.assignment_slug,
  bs.private_profile_id as student_private_profile_id,
  
  -- Private scores: all reviews regardless of release status
  COALESCE(
    (SELECT jsonb_object_agg(x.review_round::text, x.total_score)
     FROM (
       SELECT DISTINCT ON (r.review_round)
         r.review_round,
         sr.total_score
       FROM public.submission_reviews sr
       JOIN public.rubrics r ON r.id = sr.rubric_id
       WHERE sr.submission_id = bs.submission_id
       ORDER BY r.review_round, sr.completed_at DESC NULLS LAST, sr.id DESC
     ) x
    ),
    '{}'::jsonb
  ) as scores_by_round_private,
  
  -- Public scores: only released reviews
  COALESCE(
    (SELECT jsonb_object_agg(x.review_round::text, x.total_score)
     FROM (
       SELECT DISTINCT ON (r.review_round)
         r.review_round,
         sr.total_score
       FROM public.submission_reviews sr
       JOIN public.rubrics r ON r.id = sr.rubric_id
       WHERE sr.submission_id = bs.submission_id
         AND sr.released = true
       ORDER BY r.review_round, sr.completed_at DESC NULLS LAST, sr.id DESC
     ) x
    ),
    '{}'::jsonb
  ) as scores_by_round_public

FROM best_submissions bs
WHERE bs.rn = 1;  -- Only the best submission for each student-assignment pair

COMMENT ON VIEW public.submissions_with_reviews_by_round_for_assignment IS 
'Optimized view: One row per student per assignment with per-review_round score maps. Uses UNION ALL and window functions to avoid Cartesian products.';

-- Add a specialized index to support the common query pattern
-- This index will help when filtering by assignment_id IN (...) AND class_id = X AND student_private_profile_id IN (...)
CREATE INDEX IF NOT EXISTS idx_submissions_multi_assignment_class_profile 
ON public.submissions (assignment_id, class_id, profile_id, is_active) 
WHERE is_active = true;