-- Add assignment_slug back to submissions_with_grades_for_assignment view
-- This field was removed in migration 20250730164813_completable-review-assignments.sql 
-- during a performance optimization. This migration adds it back.

DROP VIEW IF EXISTS public.submissions_with_grades_for_assignment;

-- Recreate the view with assignment_slug added back
CREATE OR REPLACE VIEW public.submissions_with_grades_for_assignment 
WITH (security_invoker='true') 
AS
WITH student_roles AS (
  -- Pre-filter student roles to reduce working set
  SELECT r.id, r.private_profile_id, r.class_id
  FROM user_roles r
  WHERE r.role = 'student'::app_role
),

-- Separate CTEs for individual and group submissions to avoid complex CASE logic
individual_submissions AS (
  SELECT 
    sr.id as user_role_id,
    sr.private_profile_id,
    sr.class_id,
    a.id as assignment_id,
    s.id as submission_id,
    NULL::bigint as assignment_group_id,
    a.due_date,
    a.slug as assignment_slug  -- Add assignment_slug
  FROM student_roles sr
  INNER JOIN assignments a ON a.class_id = sr.class_id
  INNER JOIN submissions s ON (
    s.profile_id = sr.private_profile_id 
    AND s.assignment_id = a.id 
    AND s.is_active = true
  )
),

group_submissions AS (
  SELECT 
    sr.id as user_role_id,
    sr.private_profile_id,
    sr.class_id,
    a.id as assignment_id,
    s.id as submission_id,
    agm.assignment_group_id,
    a.due_date,
    a.slug as assignment_slug  -- Add assignment_slug
  FROM student_roles sr
  INNER JOIN assignments a ON a.class_id = sr.class_id
  INNER JOIN assignment_groups_members agm ON (
    agm.profile_id = sr.private_profile_id 
    AND agm.assignment_id = a.id
  )
  INNER JOIN submissions s ON (
    s.assignment_group_id = agm.assignment_group_id 
    AND s.assignment_id = a.id 
    AND s.is_active = true
  )
),

-- Union individual and group submissions
all_submissions AS (
  SELECT * FROM individual_submissions
  UNION ALL
  SELECT * FROM group_submissions
),

-- Handle due date exceptions more efficiently
due_date_extensions AS (
  SELECT 
    COALESCE(student_id, ag.profile_id) as effective_student_id,
    COALESCE(ade.assignment_group_id, ag.assignment_group_id) as effective_assignment_group_id,
    sum(ade.tokens_consumed) as tokens_consumed,
    sum(ade.hours) as hours
  FROM assignment_due_date_exceptions ade
  LEFT JOIN assignment_groups_members ag ON ade.assignment_group_id = ag.assignment_group_id
  GROUP BY 
    COALESCE(student_id, ag.profile_id),
    COALESCE(ade.assignment_group_id, ag.assignment_group_id)
),

-- Main submission data with extensions
submissions_with_extensions AS (
  SELECT 
    asub.*,
    COALESCE(dde.tokens_consumed, 0) as tokens_consumed,
    COALESCE(dde.hours, 0) as hours
  FROM all_submissions asub
  LEFT JOIN due_date_extensions dde ON (
    dde.effective_student_id = asub.private_profile_id
    AND (
      (asub.assignment_group_id IS NULL AND dde.effective_assignment_group_id IS NULL)
      OR (asub.assignment_group_id = dde.effective_assignment_group_id)
    )
  )
)

-- Final SELECT with all existing fields PLUS assignment_slug
SELECT 
  swe.user_role_id as id,
  swe.class_id,
  swe.assignment_id,
  p.id as student_private_profile_id,
  p.name,
  p.sortable_name,
  s.id AS activesubmissionid,
  s.created_at,
  s.released,
  s.repository,
  s.sha,
  rev.total_autograde_score AS autograder_score,
  rev.grader,
  rev.meta_grader,
  rev.total_score,
  rev.tweak,
  rev.completed_by,
  rev.completed_at,
  rev.checked_at,
  rev.checked_by,
  graderprofile.name AS assignedgradername,
  metagraderprofile.name AS assignedmetagradername,
  completerprofile.name AS gradername,
  checkgraderprofile.name AS checkername,
  ag.name AS groupname,
  swe.tokens_consumed,
  swe.hours,
  swe.due_date,
  (swe.due_date + ('01:00:00'::interval * swe.hours::double precision)) AS late_due_date,
  ar.grader_sha,
  ar.grader_action_sha,
  swe.assignment_slug AS assignment_slug       -- ADD assignment_slug field
FROM submissions_with_extensions swe
INNER JOIN profiles p ON p.id = swe.private_profile_id
INNER JOIN submissions s ON s.id = swe.submission_id
LEFT JOIN submission_reviews rev ON rev.id = s.grading_review_id
LEFT JOIN grader_results ar ON ar.submission_id = s.id
LEFT JOIN assignment_groups ag ON ag.id = swe.assignment_group_id
LEFT JOIN profiles completerprofile ON completerprofile.id = rev.completed_by
LEFT JOIN profiles graderprofile ON graderprofile.id = rev.grader
LEFT JOIN profiles metagraderprofile ON metagraderprofile.id = rev.meta_grader
LEFT JOIN profiles checkgraderprofile ON checkgraderprofile.id = rev.checked_by;
