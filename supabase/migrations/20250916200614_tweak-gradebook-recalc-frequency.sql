CREATE OR REPLACE FUNCTION "public"."invoke_gradebook_recalculation_background_task"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
declare
    queue_size integer;
    worker_count integer;
BEGIN

    -- select count(*)::integer into queue_size from pgmq_public.read('gradebook_row_recalculate', 0, 100);
    -- if queue_size >= 1000 then
    --     worker_count := 5;
    -- else 
    --     worker_count := 2
    -- end if;
    worker_count := 2;
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
  -- Build directly from submissions to enable planner to push filters (e.g., assignment_id)
  all_submissions AS (
    -- Individual submissions
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

    -- Group submissions (expand to each student in the group who is an active student in the class)
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
  COALESCE(agg.scores_by_round_public, '{}'::jsonb) AS scores_by_round_public
FROM all_submissions bs
JOIN LATERAL (
  SELECT
    jsonb_object_agg(x.review_round::text, x.total_score) FILTER (WHERE true) AS scores_by_round_private,
    jsonb_object_agg(x.review_round::text, x.total_score) FILTER (WHERE x.released) AS scores_by_round_public
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
'Optimized view: One row per student per assignment with per-review_round score maps. Uses UNION ALL and window functions to avoid Cartesian products.';

-- Add a specialized index to support the common query pattern
-- This index will help when filtering by assignment_id IN (...) AND class_id = X AND student_private_profile_id IN (...)
CREATE INDEX IF NOT EXISTS idx_submissions_multi_assignment_class_profile 
ON public.submissions (assignment_id, class_id, profile_id, is_active) 
WHERE is_active = true;

-- Speed up active students lookup by class
CREATE INDEX IF NOT EXISTS idx_user_roles_active_students_by_class 
ON public.user_roles (class_id, private_profile_id)
WHERE role = 'student'::public.app_role AND disabled = false;

-- Improve review fetch and ordering for latest-per-round per submission
CREATE INDEX IF NOT EXISTS idx_submission_reviews_submission_rubric_completed_desc 
ON public.submission_reviews (submission_id, rubric_id, completed_at DESC, id DESC) INCLUDE (total_score, released);

-- Individual submissions: fast lookup of active rows per (assignment_id, profile_id)
CREATE INDEX IF NOT EXISTS idx_submissions_individual_active
ON public.submissions (assignment_id, profile_id, id)
WHERE is_active = true AND assignment_group_id IS NULL;

-- Group submissions: fast lookup of active rows per (assignment_id, assignment_group_id)
CREATE INDEX IF NOT EXISTS idx_submissions_group_active
ON public.submissions (assignment_id, assignment_group_id, id)
WHERE is_active = true AND assignment_group_id IS NOT NULL;

-- Alternative path for user_roles that matches join and removes disabled filter
CREATE INDEX IF NOT EXISTS idx_user_roles_role_class_active
ON public.user_roles (role, class_id, private_profile_id)
WHERE disabled = false;