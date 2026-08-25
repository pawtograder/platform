-- Two related due-date bugs: student-facing surfaces showed a deadline that was neither the one
-- the assignment page showed nor the one submission enforcement used.
--
-- Bug 1: extensions were dropped from the dashboard's deadline.
--   public.assignments_with_effective_due_dates.due_date and
--   public.get_assignments_for_student_dashboard.due_date both called
--   calculate_effective_due_date, which only applies lab-section offsets and never reads
--   assignment_due_date_exceptions. The course dashboard filters that column with
--   `.gte("due_date", now)` (lib/ssr-course-dashboard.ts) and renders it as "Due"
--   (app/course/[course_id]/studentDashboard.tsx), so a student holding an extension saw a future
--   deadline on the assignment detail page (which computes it client-side in
--   hooks/useCourseController.tsx `useAssignmentDueDate`) and an EMPTY upcoming list -- while
--   submission enforcement, which goes through calculate_final_due_date, would still have
--   accepted the work. The Assignments tab had the same root cause via the RPC and bucketed the
--   extended assignment as past-due.
--
--   Fix: both surfaces now select calculate_final_due_date(assignment, student, group), the
--   function that already wraps calculate_effective_due_date and adds the exception hours/minutes.
--   Nothing else reads either due_date column, so the semantics change is contained; the RPC's
--   exception_* columns are unchanged (they remain most-recent-exception metadata, and no caller
--   reads them today).
--
-- Bug 2: a lab section with no end_time silently disabled its own lab offset.
--   calculate_effective_due_date builds its meeting timestamps by string-concatenating
--   lab_sections.end_time. That column is nullable -- the lab-section form leaves it optional
--   (app/course/[course_id]/manage/course/lab-sections/page.tsx) and course-import-sis writes NULL
--   whenever a section's meeting_times does not match any of its time patterns -- and a NULL made
--   `(meeting_date || ' ' || end_time)::timestamp` NULL, so the `<= due_date` predicate was NULL
--   for every meeting, no meeting matched, and the student fell back to the plain assignment due
--   date with no error. Meanwhile the assignment form's "Lab Section Due Date Preview" substitutes
--   23:59:59 and showed the instructor a deadline that would never apply.
--
--   Fix: default a missing end_time to 23:59:59 (end of the meeting day), matching that preview.
--   The same default is now applied in useAssignmentDueDate so all three paths agree.
--
--   Deployment note: any existing lab section with a NULL end_time will see its students'
--   deadlines move EARLIER (from the plain due date to end-of-meeting-day + minutes_due_after_lab)
--   for assignments that use minutes_due_after_lab. Audit before deploying:
--     SELECT ls.id, ls.class_id, c.name AS class_name, ls.name, ls.day_of_week, ls.sis_crn
--       FROM public.lab_sections ls JOIN public.classes c ON c.id = ls.class_id
--      WHERE ls.end_time IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 1. calculate_effective_due_date: tolerate a NULL lab-section end_time.
--
-- Body copied verbatim from the only prior definition
-- (20250712142950_lab-sections.sql) except for the lab_end_time local and the two
-- concatenations that now read it. Signature, volatility and security are unchanged, so the
-- existing GRANTs and every dependent view (assignment_overview, the regression-test and
-- what-if views, calculate_final_due_date) survive CREATE OR REPLACE without a drop.
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "public"."calculate_effective_due_date"(
    "assignment_id_param" bigint,
    "student_profile_id_param" uuid
) RETURNS timestamp with time zone
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    AS $$
DECLARE
    assignment_record RECORD;
    student_lab_section_id bigint;
    most_recent_lab_meeting_date date;
    lab_section_record RECORD;
    course_record RECORD;
    lab_based_due_date timestamp with time zone;
    lab_meeting_timestamp timestamp with time zone;
    lab_end_time time;
BEGIN
    -- Get assignment details
    SELECT * INTO assignment_record
    FROM public.assignments
    WHERE id = assignment_id_param;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Assignment with id % not found', assignment_id_param;
    END IF;

    -- If assignment doesn't use lab-based scheduling, return original due date
    IF assignment_record.minutes_due_after_lab IS NULL THEN
        RETURN assignment_record.due_date;
    END IF;

    -- Get student's lab section for this class
    SELECT lab_section_id INTO student_lab_section_id
    FROM public.user_roles
    WHERE private_profile_id = student_profile_id_param
    AND class_id = assignment_record.class_id
    AND lab_section_id IS NOT NULL;

    -- If student is not in a lab section, fall back to original due date
    IF student_lab_section_id IS NULL THEN
        RETURN assignment_record.due_date;
    END IF;

    -- Get lab section details (for end_time)
    SELECT * INTO lab_section_record
    FROM public.lab_sections
    WHERE id = student_lab_section_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Lab section with id % not found', student_lab_section_id;
    END IF;

    -- Get course details (for time_zone)
    SELECT * INTO course_record
    FROM public.classes
    WHERE id = assignment_record.class_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Class with id % not found', assignment_record.class_id;
    END IF;

    -- end_time is nullable, and concatenating a NULL into the meeting timestamp below would
    -- NULL the whole comparison, match no meeting, and silently skip the lab offset. A section
    -- with no recorded end time is treated as ending at the end of its meeting day, which is
    -- what the assignment form's Lab Section Due Date Preview already shows.
    lab_end_time := COALESCE(lab_section_record.end_time, TIME '23:59:59');

    -- Find the most recent lab section meeting before the assignment's original due date
    -- Convert meeting date + lab section end time to timestamp in course timezone
    SELECT meeting_date INTO most_recent_lab_meeting_date
    FROM public.lab_section_meetings lsm
    WHERE lsm.lab_section_id = student_lab_section_id
    AND (
        (lsm.meeting_date::text || ' ' || lab_end_time::text)::timestamp AT TIME ZONE course_record.time_zone
    ) <= assignment_record.due_date
    AND NOT lsm.cancelled
    ORDER BY lsm.meeting_date DESC
    LIMIT 1;

    -- If no lab meeting found before due date, fall back to original due date
    IF most_recent_lab_meeting_date IS NULL THEN
        RETURN assignment_record.due_date;
    END IF;

    -- Combine meeting date with lab section end time and apply course time zone
    lab_meeting_timestamp := (
        most_recent_lab_meeting_date::text || ' ' || lab_end_time::text
    )::timestamp AT TIME ZONE course_record.time_zone;

    -- Calculate lab-based due date
    lab_based_due_date := lab_meeting_timestamp
                         + (assignment_record.minutes_due_after_lab * INTERVAL '1 minute');

    -- Return the lab-based due date
    RETURN lab_based_due_date;
END;
$$;

COMMENT ON FUNCTION "public"."calculate_effective_due_date"(bigint, uuid) IS 'Calculates the effective due date for a student on an assignment, considering lab-based scheduling if configured. A lab section with a NULL end_time is treated as ending at 23:59:59 on its meeting day (matching the assignment form preview). Does NOT include due-date exceptions -- use calculate_final_due_date for the deadline a student is actually held to.';

-- ---------------------------------------------------------------------------------------------
-- 2. assignments_with_effective_due_dates.due_date becomes the FINAL per-student due date.
--
-- Copied verbatim from the latest definition
-- (20260530120100_add-suggested-due-date-to-effective-view.sql) except the due_date expression
-- and the new LEFT JOIN LATERAL that resolves the student's group for this assignment.
-- Column list, order and types are unchanged, so CREATE OR REPLACE VIEW is valid and the
-- generated Database types do not move. security_invoker preserved.
--
-- The lateral cannot fan out (LIMIT 1, and unique_assignment_group_member already makes
-- (assignment_id, profile_id) unique) and is index-only via
-- idx_assignment_groups_members_profile_assignment_covering (profile_id, assignment_id)
-- INCLUDE (assignment_group_id).
-- ---------------------------------------------------------------------------------------------

CREATE OR REPLACE VIEW "public"."assignments_with_effective_due_dates"
WITH ("security_invoker" = 'true') AS
 SELECT a.id,
    a.created_at,
    a.class_id,
    a.title,
    a.release_date,
    public.calculate_final_due_date(a.id, ur.private_profile_id, agm.assignment_group_id) AS due_date,
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
    ur.private_profile_id AS student_profile_id,
    a.suggested_due_date
   FROM assignments a
     CROSS JOIN user_roles ur
     LEFT JOIN LATERAL (
       SELECT m.assignment_group_id
         FROM public.assignment_groups_members m
        WHERE m.profile_id = ur.private_profile_id
          AND m.assignment_id = a.id
        LIMIT 1
     ) agm ON true
  WHERE ur.class_id = a.class_id AND ur.role = 'student'::app_role AND a.archived_at IS NULL;

COMMENT ON VIEW "public"."assignments_with_effective_due_dates" IS 'View showing all assignment columns but with due_date replaced by the final per-student due date (lab-aware effective date plus any due-date exceptions)';
COMMENT ON COLUMN "public"."assignments_with_effective_due_dates"."due_date" IS 'Final per-student due date: lab-aware effective date plus any assignment_due_date_exceptions (extensions / late tokens) for the student or their group';
COMMENT ON COLUMN "public"."assignments_with_effective_due_dates"."student_profile_id" IS 'Student profile ID for filtering assignments by student';

-- ---------------------------------------------------------------------------------------------
-- 3. get_assignments_for_student_dashboard.due_date becomes the FINAL per-student due date.
--
-- Same bug and same fix as the view above, for the Assignments tab
-- (app/course/[course_id]/assignments/studentAssignmentsList.tsx). Everything below is copied
-- verbatim from the latest definition
-- (20260715120100_hide_unreleased_assignments_from_student_dashboard.sql -- which added the
-- release gate in the final WHERE) except the due_date expression and the new student_group
-- join that feeds it. Basing on that version preserves the release gate and the
-- active-submission preference.
--
-- The exception_* columns are deliberately untouched: they expose the single most recent
-- exception row (ORDER BY created_at DESC LIMIT 1) as metadata, whereas the deadline needs the
-- SUM of every exception -- which is exactly what calculate_final_due_date does. No frontend
-- reads the exception_* columns today, so there is nothing to double-count.
-- ---------------------------------------------------------------------------------------------

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
        -- Prefer the active submission; fall back to most recent. The grade shown should be
        -- the active/graded submission's, not a later not-for-grading scratch submission's.
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
        -- Prefer the active submission; fall back to most recent (see individual branch above).
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
    -- A student is in at most one mode per assignment, so exactly one branch yields a real
    -- row (the other has NULLs). NULLS LAST keeps the real row; the is_active tiebreaker
    -- matches the per-mode LATERAL preference for the active submission.
    ORDER BY assignment_id, student_profile_id,
             submission_is_active DESC NULLS LAST, submission_created_at DESC NULLS LAST
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
         public.calculate_final_due_date(a.id, ur.student_profile_id, sg.assignment_group_id) AS due_date,
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
  -- student_group is the same CTE chosen_repository already uses; it is LEFT JOINed on
  -- (assignment_id, profile_id), which unique_assignment_group_member makes unique, so it
  -- cannot fan out. It supplies the group whose exceptions calculate_final_due_date must add.
  LEFT JOIN student_group sg
    ON sg.assignment_id = a.id AND sg.student_profile_id = ur.student_profile_id
  LEFT JOIN due_date_ex de
    ON de.assignment_id = a.id AND de.student_profile_id = ur.student_profile_id
  -- Release gate: hide assignments not yet released from the student dashboard. A NULL
  -- release_date is treated as released, matching the individual-assignment page redirect.
  WHERE a.archived_at IS NULL
    AND (a.release_date IS NULL OR a.release_date <= now());
END
$$;

REVOKE ALL ON FUNCTION public.get_assignments_for_student_dashboard(bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_assignments_for_student_dashboard(bigint, uuid) TO authenticated;
