-- Optimize assignments_for_student_dashboard by avoiding seq scan on submissions and heavy dedup sorts
-- 1) Supporting indexes

-- Latest active submission per assignment per student (individual submissions)
CREATE INDEX IF NOT EXISTS idx_submissions_latest_individual_covering
ON public.submissions USING btree (profile_id, assignment_id, created_at DESC)
INCLUDE (id, is_active, ordinal, assignment_group_id)
WHERE assignment_group_id IS NULL;

-- Latest active submission per assignment per group member (group submissions)
CREATE INDEX IF NOT EXISTS idx_submissions_latest_group_covering
ON public.submissions USING btree (assignment_group_id, assignment_id, created_at DESC)
INCLUDE (id, is_active, ordinal, profile_id)
WHERE assignment_group_id IS NOT NULL;

-- Speed up mapping from group -> member profiles used in latest submission resolution
CREATE INDEX IF NOT EXISTS idx_assignment_groups_members_assignment_profile
ON public.assignment_groups_members USING btree (assignment_id, assignment_group_id, profile_id);

-- Speed up due date exception lookups for a given assignment and student or group
CREATE INDEX IF NOT EXISTS idx_assignment_due_date_exceptions_assignment_student_group
ON public.assignment_due_date_exceptions USING btree (assignment_id, student_id, assignment_group_id);

-- Speed up repositories lookups for student and for group
CREATE INDEX IF NOT EXISTS idx_repositories_profile_assignment
ON public.repositories USING btree (profile_id, assignment_id)
WHERE profile_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_repositories_assignment_group_assignment
ON public.repositories USING btree (assignment_group_id, assignment_id)
WHERE assignment_group_id IS NOT NULL;

-- 2) Replace the view using LATERAL lookups to avoid scanning all submissions
CREATE OR REPLACE VIEW public.assignments_for_student_dashboard
WITH (security_invoker = true) AS
WITH ur_students AS (
    -- Restrict to the current authenticated user to avoid row explosion
    SELECT ur.class_id, ur.private_profile_id AS student_profile_id, ur.user_id AS student_user_id
    FROM public.user_roles ur
    WHERE ur.role = 'student'::public.app_role
      AND ur.user_id = auth.uid()
), latest_submission AS (
    -- For each assignment and student, pick the latest individual submission if any
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
        ORDER BY s.created_at DESC
        LIMIT 1
    ) s_ind ON TRUE
), student_group AS (
    -- Compute the student's group for each assignment (if any)
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           agm.assignment_group_id
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN public.assignment_groups_members agm
      ON agm.assignment_id = a.id
     AND agm.profile_id = ur.student_profile_id
), latest_group_submission AS (
    -- If the student has a group, pick the group's latest submission
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
        ORDER BY s.created_at DESC
        LIMIT 1
    ) s_grp ON TRUE
), chosen_submission AS (
    -- Choose the most recent between group and individual submission
    SELECT DISTINCT ON (assignment_id, student_profile_id)
           assignment_id,
           student_profile_id,
           submission_id,
           submission_created_at,
           submission_is_active,
           submission_ordinal
    FROM (
        SELECT ls.assignment_id,
               ls.student_profile_id,
               ls.submission_id,
               ls.submission_created_at,
               ls.submission_is_active,
               ls.submission_ordinal
        FROM latest_submission ls
        UNION ALL
        SELECT lgs.assignment_id,
               lgs.student_profile_id,
               lgs.submission_id,
               lgs.submission_created_at,
               lgs.submission_is_active,
               lgs.submission_ordinal
        FROM latest_group_submission lgs
    ) x
    ORDER BY assignment_id, student_profile_id, submission_created_at DESC NULLS LAST
), grader_result_for_submission AS (
    SELECT cs.assignment_id,
           cs.student_profile_id,
           gr.id AS grader_result_id,
           gr.score AS grader_result_score,
           gr.max_score AS grader_result_max_score
    FROM chosen_submission cs
    LEFT JOIN public.grader_results gr ON gr.submission_id = cs.submission_id
), student_repositories AS (
    -- Individual repositories
    SELECT DISTINCT r.assignment_id,
           ur.student_profile_id,
           r.id AS repository_id,
           r.repository,
           r.is_github_ready
    FROM public.repositories r
    JOIN ur_students ur ON ur.student_profile_id = r.profile_id
    WHERE r.profile_id IS NOT NULL
    UNION ALL
    -- Group repositories
    SELECT DISTINCT r.assignment_id,
           agm.profile_id AS student_profile_id,
           r.id AS repository_id,
           r.repository,
           r.is_github_ready
    FROM public.repositories r
    JOIN public.assignment_groups_members agm
      ON agm.assignment_group_id = r.assignment_group_id
    WHERE r.assignment_group_id IS NOT NULL
), review_info AS (
    SELECT a.id AS assignment_id,
           ur.student_profile_id,
           ra.id AS review_assignment_id,
           ra.submission_id AS review_submission_id,
           sr.id AS submission_review_id,
           sr.completed_at AS submission_review_completed_at
    FROM public.assignments a
    JOIN ur_students ur ON ur.class_id = a.class_id
    LEFT JOIN public.review_assignments ra
      ON ra.assignment_id = a.id
     AND ra.assignee_profile_id = ur.student_profile_id
    LEFT JOIN public.submission_reviews sr ON sr.id = ra.submission_review_id
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
       de.exception_note
FROM public.assignments a
JOIN ur_students ur ON ur.class_id = a.class_id
LEFT JOIN chosen_submission cs
  ON cs.assignment_id = a.id AND cs.student_profile_id = ur.student_profile_id
LEFT JOIN grader_result_for_submission gr
  ON gr.assignment_id = a.id AND gr.student_profile_id = ur.student_profile_id
LEFT JOIN student_repositories sr
  ON sr.assignment_id = a.id AND sr.student_profile_id = ur.student_profile_id
LEFT JOIN public.assignment_self_review_settings asrs
  ON asrs.id = a.self_review_setting_id
LEFT JOIN review_info ri
  ON ri.assignment_id = a.id AND ri.student_profile_id = ur.student_profile_id
LEFT JOIN due_date_ex de
  ON de.assignment_id = a.id AND de.student_profile_id = ur.student_profile_id
WHERE a.archived_at IS NULL;

ALTER TABLE public.assignments_for_student_dashboard OWNER TO postgres;
GRANT ALL ON TABLE public.assignments_for_student_dashboard TO anon;
GRANT ALL ON TABLE public.assignments_for_student_dashboard TO authenticated;
GRANT ALL ON TABLE public.assignments_for_student_dashboard TO service_role;
