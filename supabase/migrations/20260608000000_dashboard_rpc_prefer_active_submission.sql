-- Make `public.get_assignments_for_student_dashboard` surface the ACTIVE submission rather than
-- the most recently created one.
--
-- Bug (issue #823): the dashboard picked each student's submission with `ORDER BY created_at DESC
-- LIMIT 1` (in `latest_submission` / `latest_group_submission`) and broke ties in
-- `chosen_submission` the same way. When an instructor activates an older submission for grading
-- (so a newer, autograder-only submission exists but is NOT active), the dashboard showed the
-- newer submission: its autograder-only score and denominator (e.g. 81.67/90, ungraded) instead
-- of the active, hand-graded submission's released total (e.g. 87.67/100). Every other view
-- (gradebook, submissions list, RLS-gated submission views) keys off `submissions.is_active`, so
-- the dashboard was the lone outlier and disagreed with them.
--
-- A submission's `is_active` flag is maintained so that at most one submission per (profile,
-- assignment) and per (assignment_group, assignment) is active at a time — it is THE submission
-- that counts for grading. By default the latest submission is the active one; the two diverge
-- only when staff explicitly activate an older submission.
--
-- Fix: prefer `is_active = true` before `created_at DESC` in both per-student/per-group LATERALs
-- and in the `chosen_submission` tiebreak. When no submission is active (edge case) the ordering
-- falls back to latest-by-created_at, i.e. the previous behavior. `is_active` is NOT NULL on real
-- submission rows; `NULLS LAST` keeps the synthetic no-submission rows (from the LEFT JOIN
-- LATERALs) sorted after any real submission. Every other CTE, the authorization gate, the
-- release gate, and the function signature are unchanged from
-- 20260529120000_dashboard_rpc_gate_grading_release.sql.

CREATE OR REPLACE FUNCTION public.get_assignments_for_student_dashboard(
  p_class_id bigint,
  p_student_profile_id uuid
) RETURNS TABLE (
  id bigint,
  created_at timestamptz,
  class_id bigint,
  title text,
  release_date timestamptz,
  due_date timestamptz,
  student_repo_prefix text,
  total_points numeric,
  has_autograder boolean,
  has_handgrader boolean,
  description text,
  slug text,
  template_repo text,
  allow_student_formed_groups boolean,
  group_config public.assignment_group_mode,
  group_formation_deadline timestamptz,
  max_group_size integer,
  min_group_size integer,
  archived_at timestamptz,
  autograder_points bigint,
  grading_rubric_id bigint,
  max_late_tokens integer,
  latest_template_sha text,
  meta_grading_rubric_id bigint,
  self_review_rubric_id bigint,
  self_review_setting_id bigint,
  gradebook_column_id bigint,
  minutes_due_after_lab integer,
  allow_not_graded_submissions boolean,
  student_profile_id uuid,
  student_user_id uuid,
  submission_id bigint,
  submission_created_at timestamptz,
  submission_is_active boolean,
  submission_ordinal integer,
  grader_result_id bigint,
  grader_result_score numeric,
  grader_result_max_score numeric,
  repository_id bigint,
  repository text,
  is_github_ready boolean,
  assignment_self_review_setting_id bigint,
  self_review_enabled boolean,
  self_review_deadline_offset bigint,
  review_assignment_id bigint,
  review_submission_id bigint,
  submission_review_id bigint,
  submission_review_completed_at timestamptz,
  due_date_exception_id bigint,
  exception_hours integer,
  exception_minutes integer,
  exception_tokens_consumed integer,
  exception_created_at timestamptz,
  exception_creator_id uuid,
  exception_note text,
  grading_submission_review_id bigint,
  grading_submission_review_completed_at timestamptz,
  grading_total_score numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
BEGIN
  -- Authorization gate (top of function, single explicit check).
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.class_id = p_class_id
      AND ur.user_id = auth.uid()
      AND ur.disabled = false
      AND (
        (ur.role = 'student'::public.app_role AND ur.private_profile_id = p_student_profile_id)
        OR ur.role = 'instructor'::public.app_role
        OR ur.role = 'grader'::public.app_role
      )
  ) THEN
    RAISE EXCEPTION 'not authorized to read assignments dashboard for this student'
      USING ERRCODE = '42501';
  END IF;

  -- Body: same CTE chain that the previous view used, but `ur_students` is bounded
  -- to the single requested (class, student) so every downstream join is O(assignments)
  -- rather than O(class_students * assignments).
  RETURN QUERY
  WITH ur_students AS (
    SELECT ur.class_id,
           ur.private_profile_id AS student_profile_id,
           ur.user_id AS student_user_id
    FROM public.user_roles ur
    WHERE ur.class_id = p_class_id
      AND ur.private_profile_id = p_student_profile_id
      AND ur.role = 'student'::public.app_role
      AND ur.disabled = false
  ), latest_submission AS (
    SELECT a.id AS assignment_id,
           s_ind.id AS submission_id,
           s_ind.created_at AS submission_created_at,
           s_ind.is_active AS submission_is_active,
           s_ind.ordinal AS submission_ordinal,
           ur.student_profile_id
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN LATERAL (
        SELECT s.id, s.created_at, s.is_active, s.ordinal
        FROM public.submissions s
        WHERE s.assignment_id = a.id
          AND s.profile_id = ur.student_profile_id
          AND s.assignment_group_id IS NULL
        -- Prefer the active submission; fall back to the latest by creation time.
        ORDER BY s.is_active DESC, s.created_at DESC
        LIMIT 1
    ) s_ind ON TRUE
  ), student_group AS (
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           agm.assignment_group_id
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN public.assignment_groups_members agm
      ON agm.assignment_id = a.id
     AND agm.profile_id = ur.student_profile_id
  ), latest_group_submission AS (
    SELECT sg.assignment_id,
           sg.student_profile_id,
           s_grp.id AS submission_id,
           s_grp.created_at AS submission_created_at,
           s_grp.is_active AS submission_is_active,
           s_grp.ordinal AS submission_ordinal
    FROM student_group sg
    LEFT JOIN LATERAL (
        SELECT s.id, s.created_at, s.is_active, s.ordinal
        FROM public.submissions s
        WHERE s.assignment_id = sg.assignment_id
          AND s.assignment_group_id = sg.assignment_group_id
        -- Prefer the active submission; fall back to the latest by creation time.
        ORDER BY s.is_active DESC, s.created_at DESC
        LIMIT 1
    ) s_grp ON TRUE
  ), chosen_submission AS (
    SELECT DISTINCT ON (assignment_id, student_profile_id)
           assignment_id,
           student_profile_id,
           submission_id,
           submission_created_at,
           submission_is_active,
           submission_ordinal
    FROM (
        SELECT ls.assignment_id, ls.student_profile_id, ls.submission_id,
               ls.submission_created_at, ls.submission_is_active, ls.submission_ordinal
        FROM latest_submission ls
        UNION ALL
        SELECT lgs.assignment_id, lgs.student_profile_id, lgs.submission_id,
               lgs.submission_created_at, lgs.submission_is_active, lgs.submission_ordinal
        FROM latest_group_submission lgs
    ) x
    -- Prefer the active submission, then the latest. NULLS LAST keeps the synthetic
    -- no-submission rows (is_active / created_at NULL) sorted after any real submission.
    ORDER BY assignment_id, student_profile_id,
             submission_is_active DESC NULLS LAST,
             submission_created_at DESC NULLS LAST
  ), grader_result_for_submission AS (
    SELECT cs.assignment_id,
           cs.student_profile_id,
           gr.id AS grader_result_id,
           gr.score AS grader_result_score,
           gr.max_score AS grader_result_max_score
    FROM chosen_submission cs
    LEFT JOIN public.grader_results gr ON gr.submission_id = cs.submission_id
  ), grading_review_for_submission AS (
    SELECT cs.assignment_id,
           cs.student_profile_id,
           sr.id AS grading_submission_review_id,
           sr.completed_at AS grading_submission_review_completed_at,
           COALESCE(
             CASE
               WHEN NULLIF(sr.per_student_grading_totals ->> cs.student_profile_id::text, '') ~ '^[+-]?[0-9]+(\.[0-9]+)?$'
               THEN (NULLIF(sr.per_student_grading_totals ->> cs.student_profile_id::text, ''))::numeric
               ELSE NULL
             END,
             CASE
               WHEN NULLIF(sr.individual_scores ->> cs.student_profile_id::text, '') ~ '^[+-]?[0-9]+(\.[0-9]+)?$'
               THEN (NULLIF(sr.individual_scores ->> cs.student_profile_id::text, ''))::numeric
               ELSE NULL
             END,
             sr.total_score
           ) AS grading_total_score
    FROM chosen_submission cs
    LEFT JOIN public.submissions s ON s.id = cs.submission_id
    -- Release gate: only join the grading review once it is released, mirroring the
    -- student RLS the prior security_invoker view relied on. Unreleased reviews yield
    -- NULL score columns and the frontend falls back to the autograder score.
    LEFT JOIN public.submission_reviews sr ON sr.id = s.grading_review_id AND sr.released = true
  ), chosen_repository AS (
    SELECT cs.assignment_id,
           cs.student_profile_id,
           repo.repository_id,
           repo.repository,
           repo.is_github_ready
    FROM chosen_submission cs
    LEFT JOIN student_group sg
      ON sg.assignment_id = cs.assignment_id AND sg.student_profile_id = cs.student_profile_id
    LEFT JOIN public.submissions sub ON sub.id = cs.submission_id
    LEFT JOIN LATERAL (
        SELECT r.id AS repository_id, r.repository, r.is_github_ready
        FROM public.repositories r
        WHERE r.assignment_id = cs.assignment_id
          AND (
            (sub.id IS NOT NULL AND sub.assignment_group_id IS NOT NULL
             AND r.assignment_group_id = sub.assignment_group_id)
            OR (sub.id IS NOT NULL AND sub.assignment_group_id IS NULL AND r.profile_id = cs.student_profile_id AND r.assignment_group_id IS NULL)
            OR (
              sub.id IS NULL
              AND (
                (sg.assignment_group_id IS NOT NULL AND r.assignment_group_id = sg.assignment_group_id)
                OR (r.profile_id = cs.student_profile_id AND r.assignment_group_id IS NULL)
              )
            )
          )
        ORDER BY
          CASE
            WHEN sub.id IS NOT NULL AND sub.assignment_group_id IS NOT NULL
                 AND r.assignment_group_id = sub.assignment_group_id THEN 0
            WHEN sub.id IS NOT NULL AND sub.assignment_group_id IS NULL
                 AND r.profile_id = cs.student_profile_id AND r.assignment_group_id IS NULL THEN 0
            WHEN sub.id IS NULL AND r.assignment_group_id IS NOT NULL THEN 1
            WHEN sub.id IS NULL AND r.profile_id = cs.student_profile_id AND r.assignment_group_id IS NULL THEN 2
            ELSE 3
          END,
          r.id
        LIMIT 1
    ) repo ON TRUE
  ), review_info AS (
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           ri.review_assignment_id,
           ri.review_submission_id,
           ri.submission_review_id,
           ri.submission_review_completed_at
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN LATERAL (
        SELECT ra.id AS review_assignment_id,
               ra.submission_id AS review_submission_id,
               sr.id AS submission_review_id,
               sr.completed_at AS submission_review_completed_at
        FROM public.review_assignments ra
        LEFT JOIN public.submission_reviews sr ON sr.id = ra.submission_review_id
        WHERE ra.assignment_id = a.id
          AND ra.assignee_profile_id = ur.student_profile_id
          -- Release gate: mirror the review_assignments RLS the prior security_invoker view
          -- relied on, so an unreleased self/peer review's ids don't surface on the dashboard
          -- (the frontend renders a clickable "Self Review for X" row off review_assignment_id).
          AND (ra.release_date IS NULL OR ra.release_date <= now())
        ORDER BY ra.created_at DESC
        LIMIT 1
    ) ri ON TRUE
  ), due_date_ex AS (
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           ade.id AS due_date_exception_id,
           ade.hours AS exception_hours,
           ade.minutes AS exception_minutes,
           ade.tokens_consumed AS exception_tokens_consumed,
           ade.created_at AS exception_created_at,
           ade.creator_id AS exception_creator_id,
           ade.note AS exception_note
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN LATERAL (
        SELECT ade.*
        FROM public.assignment_due_date_exceptions ade
        WHERE ade.assignment_id = a.id
          AND (ade.student_id = ur.student_profile_id OR
               ade.assignment_group_id IN (
                   SELECT agm.assignment_group_id
                   FROM public.assignment_groups_members agm
                   WHERE agm.profile_id = ur.student_profile_id
                     AND agm.assignment_id = a.id
               ))
        ORDER BY ade.created_at DESC
        LIMIT 1
    ) ade ON TRUE
  )
  SELECT a.id,
         a.created_at,
         a.class_id,
         a.title,
         a.release_date,
         public.calculate_effective_due_date(a.id, ur.student_profile_id) AS due_date,
         a.student_repo_prefix,
         a.total_points,
         a.has_autograder,
         a.has_handgrader,
         a.description,
         a.slug,
         a.template_repo,
         a.allow_student_formed_groups,
         a.group_config,
         a.group_formation_deadline,
         a.max_group_size,
         a.min_group_size,
         a.archived_at,
         a.autograder_points,
         a.grading_rubric_id,
         a.max_late_tokens,
         a.latest_template_sha,
         a.meta_grading_rubric_id,
         a.self_review_rubric_id,
         a.self_review_setting_id,
         a.gradebook_column_id,
         a.minutes_due_after_lab,
         a.allow_not_graded_submissions,
         ur.student_profile_id,
         ur.student_user_id,
         cs.submission_id,
         cs.submission_created_at,
         cs.submission_is_active,
         cs.submission_ordinal,
         gr.grader_result_id,
         gr.grader_result_score,
         gr.grader_result_max_score,
         sr.repository_id,
         sr.repository,
         sr.is_github_ready,
         asrs.id AS assignment_self_review_setting_id,
         asrs.enabled AS self_review_enabled,
         asrs.deadline_offset AS self_review_deadline_offset,
         ri.review_assignment_id,
         ri.review_submission_id,
         ri.submission_review_id,
         ri.submission_review_completed_at,
         de.due_date_exception_id,
         de.exception_hours,
         de.exception_minutes,
         de.exception_tokens_consumed,
         de.exception_created_at,
         de.exception_creator_id,
         de.exception_note,
         gv.grading_submission_review_id,
         gv.grading_submission_review_completed_at,
         gv.grading_total_score
  FROM public.assignments a
  JOIN ur_students ur ON ur.class_id = a.class_id
  LEFT JOIN chosen_submission cs
    ON cs.assignment_id = a.id AND cs.student_profile_id = ur.student_profile_id
  LEFT JOIN grader_result_for_submission gr
    ON gr.assignment_id = a.id AND gr.student_profile_id = ur.student_profile_id
  LEFT JOIN grading_review_for_submission gv
    ON gv.assignment_id = a.id AND gv.student_profile_id = ur.student_profile_id
  LEFT JOIN chosen_repository sr
    ON sr.assignment_id = a.id AND sr.student_profile_id = ur.student_profile_id
  LEFT JOIN public.assignment_self_review_settings asrs
    ON asrs.id = a.self_review_setting_id
  LEFT JOIN review_info ri
    ON ri.assignment_id = a.id AND ri.student_profile_id = ur.student_profile_id
  LEFT JOIN due_date_ex de
    ON de.assignment_id = a.id AND de.student_profile_id = ur.student_profile_id
  WHERE a.archived_at IS NULL;
END
$$;

REVOKE ALL ON FUNCTION public.get_assignments_for_student_dashboard(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_assignments_for_student_dashboard(bigint, uuid) TO authenticated;
