-- Expose the advisory suggested_due_date through assignments_with_effective_due_dates
-- so student-facing surfaces that read this view (e.g. the course dashboard's upcoming
-- assignments) can display it. due_date here remains the lab-aware effective hard deadline;
-- suggested_due_date is the raw advisory column, display-only. Appended at the end so
-- CREATE OR REPLACE VIEW is valid; security_invoker preserved.

CREATE OR REPLACE VIEW "public"."assignments_with_effective_due_dates"
WITH ("security_invoker" = 'true') AS
 SELECT a.id,
    a.created_at,
    a.class_id,
    a.title,
    a.release_date,
    calculate_effective_due_date(a.id, ur.private_profile_id) AS due_date,
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
  WHERE ur.class_id = a.class_id AND ur.role = 'student'::app_role AND a.archived_at IS NULL;
