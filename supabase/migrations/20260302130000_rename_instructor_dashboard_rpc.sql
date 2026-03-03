-- Drop the old instructor dashboard RPC and recreate it with a new name.
-- Keeps the same metrics logic while giving the dashboard a dedicated v2 RPC identifier.

DROP FUNCTION IF EXISTS public.get_instructor_dashboard_metrics(bigint, timestamptz);
DROP FUNCTION IF EXISTS public.get_instructor_dashboard_overview_metrics(bigint, timestamptz);

CREATE OR REPLACE FUNCTION public.get_instructor_dashboard_overview_metrics(
  p_class_id bigint,
  p_now timestamptz DEFAULT now()
)
RETURNS TABLE (
  section text,
  assignment_id bigint,
  title text,
  due_date timestamptz,
  time_zone text,
  total_submitters bigint,
  graded_submissions bigint,
  open_regrade_requests bigint,
  closed_or_resolved_regrade_requests bigint,
  students_with_valid_extensions bigint,
  review_assignments_total bigint,
  review_assignments_completed bigint,
  review_assignments_incomplete bigint,
  submission_reviews_total bigint,
  submission_reviews_completed bigint,
  submission_reviews_incomplete bigint,
  grades_released_count bigint,
  grades_unreleased_count bigint,
  grades_release_status text,
  class_student_count bigint,
  students_without_submissions bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.authorizeforclassgrader(p_class_id) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for class %', p_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH assignment_scope AS (
    SELECT
      a.id AS assignment_id,
      a.title,
      a.due_date,
      c.time_zone
    FROM public.assignments a
    INNER JOIN public.classes c ON c.id = a.class_id
    WHERE a.class_id = p_class_id
  ),
  active_students AS (
    SELECT ur.private_profile_id
    FROM public.user_roles ur
    WHERE ur.class_id = p_class_id
      AND ur.role = 'student'::public.app_role
      AND ur.disabled = false
  ),
  class_roster_count AS (
    SELECT COUNT(*)::bigint AS student_count
    FROM active_students
  ),
  student_submission_candidates AS (
    -- Individual submissions mapped directly to active students.
    SELECT
      s.assignment_id,
      s.id AS submission_id,
      s.profile_id AS student_profile_id,
      s.created_at
    FROM public.submissions s
    INNER JOIN active_students st ON st.private_profile_id = s.profile_id
    WHERE s.class_id = p_class_id
      AND s.is_active = true
      AND s.profile_id IS NOT NULL

    UNION ALL

    -- Group submissions mapped to each active student in the group.
    SELECT
      s.assignment_id,
      s.id AS submission_id,
      agm.profile_id AS student_profile_id,
      s.created_at
    FROM public.submissions s
    INNER JOIN public.assignment_groups_members agm
      ON agm.assignment_group_id = s.assignment_group_id
     AND agm.assignment_id = s.assignment_id
    INNER JOIN active_students st ON st.private_profile_id = agm.profile_id
    WHERE s.class_id = p_class_id
      AND s.is_active = true
      AND s.assignment_group_id IS NOT NULL
  ),
  student_submission_dedup AS (
    -- Pick one active submission per student per assignment to avoid double-counting.
    SELECT
      ranked.assignment_id,
      ranked.student_profile_id,
      ranked.submission_id
    FROM (
      SELECT
        ssc.assignment_id,
        ssc.student_profile_id,
        ssc.submission_id,
        ROW_NUMBER() OVER (
          PARTITION BY ssc.assignment_id, ssc.student_profile_id
          ORDER BY ssc.created_at DESC, ssc.submission_id DESC
        ) AS rn
      FROM student_submission_candidates ssc
    ) ranked
    WHERE ranked.rn = 1
  ),
  student_submission_rollup AS (
    SELECT
      ssd.assignment_id,
      COUNT(*)::bigint AS students_with_active_submissions
    FROM student_submission_dedup ssd
    GROUP BY ssd.assignment_id
  ),
  active_submission_units AS (
    -- Unique active submissions relevant to current student roster.
    SELECT DISTINCT
      ssd.assignment_id,
      ssd.submission_id
    FROM student_submission_dedup ssd
  ),
  submission_review_rollup AS (
    SELECT
      asu.assignment_id,
      COUNT(*)::bigint AS submission_reviews_total,
      COUNT(*) FILTER (
        WHERE sr.completed_at IS NOT NULL
          AND sr.completed_by IS NOT NULL
      )::bigint AS submission_reviews_completed,
      COUNT(*) FILTER (
        WHERE sr.id IS NULL
           OR sr.completed_at IS NULL
           OR sr.completed_by IS NULL
      )::bigint AS submission_reviews_incomplete,
      COUNT(*) FILTER (
        WHERE sr.released = true
      )::bigint AS grades_released_count
    FROM active_submission_units asu
    INNER JOIN public.submissions s ON s.id = asu.submission_id
    LEFT JOIN public.submission_reviews sr ON sr.id = s.grading_review_id
    GROUP BY asu.assignment_id
  ),
  active_submission_review_units AS (
    SELECT DISTINCT
      asu.assignment_id,
      s.grading_review_id AS submission_review_id
    FROM active_submission_units asu
    INNER JOIN public.submissions s ON s.id = asu.submission_id
    WHERE s.grading_review_id IS NOT NULL
  ),
  review_assignment_rollup AS (
    SELECT
      asru.assignment_id,
      COUNT(ra.id) FILTER (
        WHERE ra.release_date IS NULL
           OR ra.release_date <= p_now
      )::bigint AS review_assignments_total,
      COUNT(ra.id) FILTER (
        WHERE (ra.release_date IS NULL OR ra.release_date <= p_now)
          AND ra.completed_at IS NOT NULL
          AND ra.completed_by IS NOT NULL
      )::bigint AS review_assignments_completed,
      COUNT(ra.id) FILTER (
        WHERE (ra.release_date IS NULL OR ra.release_date <= p_now)
          AND (ra.completed_at IS NULL OR ra.completed_by IS NULL)
      )::bigint AS review_assignments_incomplete
    FROM active_submission_review_units asru
    LEFT JOIN public.review_assignments ra
      ON ra.class_id = p_class_id
     AND ra.assignment_id = asru.assignment_id
     AND ra.submission_review_id = asru.submission_review_id
    GROUP BY asru.assignment_id
  ),
  regrade_rollup AS (
    SELECT
      srr.assignment_id,
      COUNT(*) FILTER (
        WHERE srr.status::text IN ('opened', 'escalated')
      )::bigint AS open_regrade_requests,
      COUNT(*) FILTER (
        WHERE srr.status::text IN ('closed', 'resolved')
      )::bigint AS closed_or_resolved_regrade_requests
    FROM public.submission_regrade_requests srr
    WHERE srr.class_id = p_class_id
    GROUP BY srr.assignment_id
  ),
  extension_rollup AS (
    SELECT
      ade.assignment_id,
      COUNT(DISTINCT COALESCE('g:' || ade.assignment_group_id::text, 'p:' || ade.student_id::text))::bigint
        AS students_with_valid_extensions
    FROM public.assignment_due_date_exceptions ade
    INNER JOIN public.assignments a2 ON a2.id = ade.assignment_id
    WHERE a2.class_id = p_class_id
      AND (a2.due_date + make_interval(hours => ade.hours, mins => ade.minutes)) > p_now
    GROUP BY ade.assignment_id
  )
  SELECT
    CASE
      WHEN a.due_date IS NULL THEN 'undated'
      WHEN a.due_date <= p_now THEN 'past_due'
      ELSE 'upcoming'
    END AS section,
    a.assignment_id,
    a.title,
    a.due_date,
    a.time_zone,
    COALESCE(ssr.students_with_active_submissions, 0) AS total_submitters,
    COALESCE(srv.submission_reviews_completed, 0) AS graded_submissions,
    COALESCE(rr.open_regrade_requests, 0) AS open_regrade_requests,
    COALESCE(rr.closed_or_resolved_regrade_requests, 0) AS closed_or_resolved_regrade_requests,
    COALESCE(ext.students_with_valid_extensions, 0) AS students_with_valid_extensions,
    COALESCE(rar.review_assignments_total, 0) AS review_assignments_total,
    COALESCE(rar.review_assignments_completed, 0) AS review_assignments_completed,
    COALESCE(rar.review_assignments_incomplete, 0) AS review_assignments_incomplete,
    COALESCE(srv.submission_reviews_total, 0) AS submission_reviews_total,
    COALESCE(srv.submission_reviews_completed, 0) AS submission_reviews_completed,
    COALESCE(srv.submission_reviews_incomplete, 0) AS submission_reviews_incomplete,
    COALESCE(srv.grades_released_count, 0) AS grades_released_count,
    GREATEST(COALESCE(srv.submission_reviews_total, 0) - COALESCE(srv.grades_released_count, 0), 0)
      AS grades_unreleased_count,
    CASE
      WHEN COALESCE(srv.submission_reviews_total, 0) = 0 THEN 'no_submissions'
      WHEN COALESCE(srv.grades_released_count, 0) = 0 THEN 'not_released'
      WHEN COALESCE(srv.grades_released_count, 0) < COALESCE(srv.submission_reviews_total, 0) THEN 'partially_released'
      ELSE 'fully_released'
    END AS grades_release_status,
    crc.student_count AS class_student_count,
    GREATEST(crc.student_count - COALESCE(ssr.students_with_active_submissions, 0), 0) AS students_without_submissions
  FROM assignment_scope a
  CROSS JOIN class_roster_count crc
  LEFT JOIN student_submission_rollup ssr ON ssr.assignment_id = a.assignment_id
  LEFT JOIN submission_review_rollup srv ON srv.assignment_id = a.assignment_id
  LEFT JOIN review_assignment_rollup rar ON rar.assignment_id = a.assignment_id
  LEFT JOIN regrade_rollup rr ON rr.assignment_id = a.assignment_id
  LEFT JOIN extension_rollup ext ON ext.assignment_id = a.assignment_id
  ORDER BY
    CASE
      WHEN a.due_date IS NULL THEN 2
      WHEN a.due_date <= p_now THEN 0
      ELSE 1
    END,
    CASE WHEN a.due_date <= p_now THEN a.due_date END DESC NULLS LAST,
    CASE WHEN a.due_date > p_now THEN a.due_date END ASC NULLS LAST,
    a.assignment_id DESC;
END;
$$;

COMMENT ON FUNCTION public.get_instructor_dashboard_overview_metrics(bigint, timestamptz)
IS 'Returns one row per assignment for instructor/grader dashboard with accurate student submission counts plus separate submission-review and review-assignment completion metrics. Includes grade release counts/status. review_assignments_incomplete may exceed submission_reviews_incomplete when multiple review assignments exist for a single submission review.';

GRANT EXECUTE ON FUNCTION public.get_instructor_dashboard_overview_metrics(bigint, timestamptz) TO authenticated;
