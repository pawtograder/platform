-- Index for rubrics.assignment_id (assignments -> rubrics join)
CREATE INDEX IF NOT EXISTS idx_rubrics_assignment_id ON public.rubrics (assignment_id);

-- Index for rubric_parts.rubric_id (rubrics -> rubric_parts join)  
CREATE INDEX IF NOT EXISTS idx_rubric_parts_rubric_id ON public.rubric_parts (rubric_id);

-- Index for rubric_criteria.rubric_part_id (rubric_parts -> rubric_criteria join)
CREATE INDEX IF NOT EXISTS idx_rubric_criteria_rubric_part_id ON public.rubric_criteria (rubric_part_id);

-- Index for rubric_checks.rubric_criteria_id (rubric_criteria -> rubric_checks join)
CREATE INDEX IF NOT EXISTS idx_rubric_checks_rubric_criteria_id ON public.rubric_checks (rubric_criteria_id);

-- Index for rubric_check_references.referencing_rubric_check_id (rubric_checks -> rubric_check_references join)
CREATE INDEX IF NOT EXISTS idx_rubric_check_references_referencing_id ON public.rubric_check_references (referencing_rubric_check_id);

-- Index for assignments.self_review_setting_id (assignments -> assignment_self_review_settings join)
CREATE INDEX IF NOT EXISTS idx_assignments_self_review_setting_id ON public.assignments (self_review_setting_id);

-- Composite index for rubrics if you filter by class_id and assignment_id together
CREATE INDEX IF NOT EXISTS idx_rubrics_assignment_class ON public.rubrics (assignment_id, class_id);

-- Additional index for the referenced_rubric_check_id lookup:
CREATE INDEX IF NOT EXISTS idx_rubric_check_references_referenced_id ON public.rubric_check_references (referenced_rubric_check_id);

-- Assignments and rubrics relationship:
CREATE INDEX IF NOT EXISTS idx_assignments_grading_rubric_id ON public.assignments (grading_rubric_id);

-- Assignment groups relationships:
CREATE INDEX IF NOT EXISTS idx_submissions_assignment_group_id ON public.submissions (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_assignment_groups_members_assignment_group_id ON public.assignment_groups_members (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_assignment_groups_members_profile_id ON public.assignment_groups_members (profile_id);

-- Grader results relationships:
CREATE INDEX IF NOT EXISTS idx_grader_results_submission_id ON public.grader_results (submission_id);
CREATE INDEX IF NOT EXISTS idx_grader_result_tests_grader_result_id ON public.grader_result_tests (grader_result_id);

-- Submission artifacts:
CREATE INDEX IF NOT EXISTS idx_submission_artifacts_submission_id ON public.submission_artifacts (submission_id);

-- Additional rubric hierarchy indices 
CREATE INDEX IF NOT EXISTS idx_rubric_criteria_rubric_id ON public.rubric_criteria (rubric_id);


-- ====================
-- ASSIGNMENT GROUP TABLES
-- ====================

-- assignment_group_invitations
CREATE INDEX IF NOT EXISTS idx_assignment_group_invitations_assignment_group_id ON public.assignment_group_invitations (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_assignment_group_invitations_invitee ON public.assignment_group_invitations (invitee);
CREATE INDEX IF NOT EXISTS idx_assignment_group_invitations_inviter ON public.assignment_group_invitations (inviter);
CREATE INDEX IF NOT EXISTS idx_assignment_group_invitations_class_id ON public.assignment_group_invitations (class_id);

-- assignment_group_join_request
CREATE INDEX IF NOT EXISTS idx_assignment_group_join_request_assignment_group_id ON public.assignment_group_join_request (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_assignment_group_join_request_assignment_id ON public.assignment_group_join_request (assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_group_join_request_class_id ON public.assignment_group_join_request (class_id);
CREATE INDEX IF NOT EXISTS idx_assignment_group_join_request_decision_maker ON public.assignment_group_join_request (decision_maker);
CREATE INDEX IF NOT EXISTS idx_assignment_group_join_request_profile_id ON public.assignment_group_join_request (profile_id);

-- assignment_groups
CREATE INDEX IF NOT EXISTS idx_assignment_groups_assignment_id ON public.assignment_groups (assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_groups_class_id ON public.assignment_groups (class_id);

-- assignment_groups_members (some indices already exist from recent migration)
CREATE INDEX IF NOT EXISTS idx_assignment_groups_members_added_by ON public.assignment_groups_members (added_by);
CREATE INDEX IF NOT EXISTS idx_assignment_groups_members_assignment_id ON public.assignment_groups_members (assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_groups_members_class_id ON public.assignment_groups_members (class_id);

-- ====================
-- ASSIGNMENT TABLES
-- ====================

-- assignments
CREATE INDEX IF NOT EXISTS idx_assignments_class_id ON public.assignments (class_id);
CREATE INDEX IF NOT EXISTS idx_assignments_meta_grading_rubric_id ON public.assignments (meta_grading_rubric_id);
CREATE INDEX IF NOT EXISTS idx_assignments_self_review_rubric_id ON public.assignments (self_review_rubric_id);
CREATE INDEX IF NOT EXISTS idx_assignments_gradebook_column_id ON public.assignments (gradebook_column_id);

-- assignment_due_date_exceptions
CREATE INDEX IF NOT EXISTS idx_assignment_due_date_exceptions_assignment_group_id ON public.assignment_due_date_exceptions (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_assignment_due_date_exceptions_assignment_id ON public.assignment_due_date_exceptions (assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_due_date_exceptions_class_id ON public.assignment_due_date_exceptions (class_id);
CREATE INDEX IF NOT EXISTS idx_assignment_due_date_exceptions_creator_id ON public.assignment_due_date_exceptions (creator_id);
CREATE INDEX IF NOT EXISTS idx_assignment_due_date_exceptions_student_id ON public.assignment_due_date_exceptions (student_id);

-- assignment_handout_commits
CREATE INDEX IF NOT EXISTS idx_assignment_handout_commits_assignment_id ON public.assignment_handout_commits (assignment_id);
CREATE INDEX IF NOT EXISTS idx_assignment_handout_commits_class_id ON public.assignment_handout_commits (class_id);

-- assignment_self_review_settings
CREATE INDEX IF NOT EXISTS idx_assignment_self_review_settings_class_id ON public.assignment_self_review_settings (class_id);

-- ====================
-- AUTOGRADER TABLES
-- ====================

-- autograder_commits
CREATE INDEX IF NOT EXISTS idx_autograder_commits_autograder_id ON public.autograder_commits (autograder_id);
-- autograder_regression_test
CREATE INDEX IF NOT EXISTS idx_autograder_regression_test_autograder_id ON public.autograder_regression_test (autograder_id);

-- ====================
-- AUDIT & MONITORING
-- ====================

-- audit
CREATE INDEX IF NOT EXISTS idx_audit_user_id ON public.audit (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_class_id ON public.audit (class_id);

-- ====================
-- CLASS & SECTION TABLES
-- ====================

-- class_sections
CREATE INDEX IF NOT EXISTS idx_class_sections_class_id ON public.class_sections (class_id);

-- classes
CREATE INDEX IF NOT EXISTS idx_classes_gradebook_id ON public.classes (gradebook_id);

-- ====================
-- DISCUSSION TABLES
-- ====================

-- discussion_threads
CREATE INDEX IF NOT EXISTS idx_discussion_threads_class_id ON public.discussion_threads (class_id);
CREATE INDEX IF NOT EXISTS idx_discussion_threads_parent ON public.discussion_threads (parent);
CREATE INDEX IF NOT EXISTS idx_discussion_threads_topic_id ON public.discussion_threads (topic_id);

-- discussion_thread_likes
CREATE INDEX IF NOT EXISTS idx_discussion_thread_likes_discussion_thread ON public.discussion_thread_likes (discussion_thread);
CREATE INDEX IF NOT EXISTS idx_discussion_thread_likes_creator ON public.discussion_thread_likes (creator);

-- discussion_thread_read_status
CREATE INDEX IF NOT EXISTS idx_discussion_thread_read_status_discussion_thread_id ON public.discussion_thread_read_status (discussion_thread_id);
CREATE INDEX IF NOT EXISTS idx_discussion_thread_read_status_discussion_thread_root_id ON public.discussion_thread_read_status (discussion_thread_root_id);
CREATE INDEX IF NOT EXISTS idx_discussion_thread_read_status_user_id ON public.discussion_thread_read_status (user_id);

-- discussion_thread_watchers
CREATE INDEX IF NOT EXISTS idx_discussion_thread_watchers_class_id ON public.discussion_thread_watchers (class_id);
CREATE INDEX IF NOT EXISTS idx_discussion_thread_watchers_discussion_thread_root_id ON public.discussion_thread_watchers (discussion_thread_root_id);
CREATE INDEX IF NOT EXISTS idx_discussion_thread_watchers_user_id ON public.discussion_thread_watchers (user_id);

-- discussion_topics
CREATE INDEX IF NOT EXISTS idx_discussion_topics_class_id ON public.discussion_topics (class_id);

-- ====================
-- EMAIL TABLES
-- ====================

-- email_batches
CREATE INDEX IF NOT EXISTS idx_email_batches_class_id ON public.email_batches (class_id);

-- emails
CREATE INDEX IF NOT EXISTS idx_emails_batch_id ON public.emails (batch_id);
CREATE INDEX IF NOT EXISTS idx_emails_class_id ON public.emails (class_id);
CREATE INDEX IF NOT EXISTS idx_emails_user_id ON public.emails (user_id);

-- ====================
-- GRADEBOOK TABLES
-- ====================

-- gradebook_column_students
CREATE INDEX IF NOT EXISTS idx_gradebook_column_students_class_id ON public.gradebook_column_students (class_id);
CREATE INDEX IF NOT EXISTS idx_gradebook_column_students_gradebook_column_id ON public.gradebook_column_students (gradebook_column_id);
CREATE INDEX IF NOT EXISTS idx_gradebook_column_students_student_id ON public.gradebook_column_students (student_id);

-- gradebook_columns
CREATE INDEX IF NOT EXISTS idx_gradebook_columns_class_id ON public.gradebook_columns (class_id);
CREATE INDEX IF NOT EXISTS idx_gradebook_columns_gradebook_id ON public.gradebook_columns (gradebook_id);

-- gradebooks
CREATE INDEX IF NOT EXISTS idx_gradebooks_class_id ON public.gradebooks (class_id);
CREATE INDEX IF NOT EXISTS idx_gradebooks_final_grade_column ON public.gradebooks (final_grade_column);

-- ====================
-- GRADER TABLES
-- ====================

-- grader_keys
CREATE INDEX IF NOT EXISTS idx_grader_keys_class_id ON public.grader_keys (class_id);

-- grader_result_output (grader_result_id already has index)
CREATE INDEX IF NOT EXISTS idx_grader_result_output_assignment_group_id ON public.grader_result_output (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_grader_result_output_class_id ON public.grader_result_output (class_id);
CREATE INDEX IF NOT EXISTS idx_grader_result_output_student_id ON public.grader_result_output (student_id);

-- grader_result_test_output
CREATE INDEX IF NOT EXISTS idx_grader_result_test_output_class_id ON public.grader_result_test_output (class_id);
CREATE INDEX IF NOT EXISTS idx_grader_result_test_output_grader_result_test_id ON public.grader_result_test_output (grader_result_test_id);

-- grader_result_tests (grader_result_id already has index from recent migration)
CREATE INDEX IF NOT EXISTS idx_grader_result_tests_assignment_group_id ON public.grader_result_tests (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_grader_result_tests_student_id ON public.grader_result_tests (student_id);
CREATE INDEX IF NOT EXISTS idx_grader_result_tests_submission_id ON public.grader_result_tests (submission_id);
CREATE INDEX IF NOT EXISTS idx_grader_result_tests_class_id ON public.grader_result_tests (class_id);

-- grader_results (submission_id already has index from recent migration)
CREATE INDEX IF NOT EXISTS idx_grader_results_assignment_group_id ON public.grader_results (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_grader_results_autograder_regression_test ON public.grader_results (autograder_regression_test);
CREATE INDEX IF NOT EXISTS idx_grader_results_class_id ON public.grader_results (class_id);
CREATE INDEX IF NOT EXISTS idx_grader_results_profile_id ON public.grader_results (profile_id);

-- ====================
-- GRADING & REVIEW TABLES
-- ====================

-- grading_conflicts
CREATE INDEX IF NOT EXISTS idx_grading_conflicts_class_id ON public.grading_conflicts (class_id);
CREATE INDEX IF NOT EXISTS idx_grading_conflicts_created_by_profile_id ON public.grading_conflicts (created_by_profile_id);
CREATE INDEX IF NOT EXISTS idx_grading_conflicts_grader_profile_id ON public.grading_conflicts (grader_profile_id);
CREATE INDEX IF NOT EXISTS idx_grading_conflicts_student_profile_id ON public.grading_conflicts (student_profile_id);

-- review_assignment_rubric_parts
CREATE INDEX IF NOT EXISTS idx_review_assignment_rubric_parts_class_id ON public.review_assignment_rubric_parts (class_id);
CREATE INDEX IF NOT EXISTS idx_review_assignment_rubric_parts_review_assignment_id ON public.review_assignment_rubric_parts (review_assignment_id);
CREATE INDEX IF NOT EXISTS idx_review_assignment_rubric_parts_rubric_part_id ON public.review_assignment_rubric_parts (rubric_part_id);

-- review_assignments
CREATE INDEX IF NOT EXISTS idx_review_assignments_assignee_profile_id ON public.review_assignments (assignee_profile_id);
CREATE INDEX IF NOT EXISTS idx_review_assignments_assignment_id ON public.review_assignments (assignment_id);
CREATE INDEX IF NOT EXISTS idx_review_assignments_class_id ON public.review_assignments (class_id);
CREATE INDEX IF NOT EXISTS idx_review_assignments_rubric_id ON public.review_assignments (rubric_id);
CREATE INDEX IF NOT EXISTS idx_review_assignments_submission_id ON public.review_assignments (submission_id);
CREATE INDEX IF NOT EXISTS idx_review_assignments_submission_review_id ON public.review_assignments (submission_review_id);

-- ====================
-- REPOSITORY TABLES
-- ====================

-- repositories
CREATE INDEX IF NOT EXISTS idx_repositories_assignment_group_id ON public.repositories (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_repositories_assignment_id ON public.repositories (assignment_id);
CREATE INDEX IF NOT EXISTS idx_repositories_class_id ON public.repositories (class_id);
CREATE INDEX IF NOT EXISTS idx_repositories_profile_id ON public.repositories (profile_id);

-- repository_check_runs (repository_id already has indices)
CREATE INDEX IF NOT EXISTS idx_repository_check_runs_class_id ON public.repository_check_runs (class_id);
CREATE INDEX IF NOT EXISTS idx_repository_check_runs_assignment_group_id ON public.repository_check_runs (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_repository_check_runs_profile_id ON public.repository_check_runs (profile_id);
CREATE INDEX IF NOT EXISTS idx_repository_check_runs_triggered_by ON public.repository_check_runs (triggered_by);

-- ====================
-- RUBRIC TABLES (many already have indices from recent migration)
-- ====================

-- rubric_checks
CREATE INDEX IF NOT EXISTS idx_rubric_checks_class_id ON public.rubric_checks (class_id);

-- rubric_criteria
CREATE INDEX IF NOT EXISTS idx_rubric_criteria_class_id ON public.rubric_criteria (class_id);

-- rubric_parts
CREATE INDEX IF NOT EXISTS idx_rubric_parts_class_id ON public.rubric_parts (class_id);

-- rubrics
CREATE INDEX IF NOT EXISTS idx_rubrics_class_id ON public.rubrics (class_id);

-- ====================
-- SUBMISSION TABLES
-- ====================

-- submissions (many already have indices)
CREATE INDEX IF NOT EXISTS idx_submissions_class_id ON public.submissions (class_id);
CREATE INDEX IF NOT EXISTS idx_submissions_grading_review_id ON public.submissions (grading_review_id);
CREATE INDEX IF NOT EXISTS idx_submissions_profile_id ON public.submissions (profile_id);
CREATE INDEX IF NOT EXISTS idx_submissions_repository_check_run_id ON public.submissions (repository_check_run_id);
CREATE INDEX IF NOT EXISTS idx_submissions_repository_id ON public.submissions (repository_id);
CREATE INDEX IF NOT EXISTS idx_submissions_assignment_id ON public.submissions (assignment_id);

-- submission_artifact_comments
CREATE INDEX IF NOT EXISTS idx_submission_artifact_comments_author ON public.submission_artifact_comments (author);
CREATE INDEX IF NOT EXISTS idx_submission_artifact_comments_class_id ON public.submission_artifact_comments (class_id);
CREATE INDEX IF NOT EXISTS idx_submission_artifact_comments_rubric_check_id ON public.submission_artifact_comments (rubric_check_id);
CREATE INDEX IF NOT EXISTS idx_submission_artifact_comments_submission_artifact_id ON public.submission_artifact_comments (submission_artifact_id);
CREATE INDEX IF NOT EXISTS idx_submission_artifact_comments_submission_id ON public.submission_artifact_comments (submission_id);
CREATE INDEX IF NOT EXISTS idx_submission_artifact_comments_submission_review_id ON public.submission_artifact_comments (submission_review_id);

-- submission_artifacts (submission_id already has index from recent migration)
CREATE INDEX IF NOT EXISTS idx_submission_artifacts_assignment_group_id ON public.submission_artifacts (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_submission_artifacts_autograder_regression_test_id ON public.submission_artifacts (autograder_regression_test_id);
CREATE INDEX IF NOT EXISTS idx_submission_artifacts_class_id ON public.submission_artifacts (class_id);
CREATE INDEX IF NOT EXISTS idx_submission_artifacts_profile_id ON public.submission_artifacts (profile_id);
CREATE INDEX IF NOT EXISTS idx_submission_artifacts_submission_file_id ON public.submission_artifacts (submission_file_id);

-- submission_comments
CREATE INDEX IF NOT EXISTS idx_submission_comments_author ON public.submission_comments (author);
CREATE INDEX IF NOT EXISTS idx_submission_comments_class_id ON public.submission_comments (class_id);
CREATE INDEX IF NOT EXISTS idx_submission_comments_rubric_check_id ON public.submission_comments (rubric_check_id);
CREATE INDEX IF NOT EXISTS idx_submission_comments_submission_review_id ON public.submission_comments (submission_review_id);
CREATE INDEX IF NOT EXISTS idx_submission_comments_submission_id ON public.submission_comments (submission_id);

-- submission_file_comments
CREATE INDEX IF NOT EXISTS idx_submission_file_comments_author ON public.submission_file_comments (author);
CREATE INDEX IF NOT EXISTS idx_submission_file_comments_class_id ON public.submission_file_comments (class_id);
CREATE INDEX IF NOT EXISTS idx_submission_file_comments_rubric_check_id ON public.submission_file_comments (rubric_check_id);
CREATE INDEX IF NOT EXISTS idx_submission_file_comments_submission_file_id ON public.submission_file_comments (submission_file_id);
CREATE INDEX IF NOT EXISTS idx_submission_file_comments_submission_review_id ON public.submission_file_comments (submission_review_id);
CREATE INDEX IF NOT EXISTS idx_submission_file_comments_submission_id ON public.submission_file_comments (submission_id);

-- submission_files (submission_id already has index)
CREATE INDEX IF NOT EXISTS idx_submission_files_assignment_group_id ON public.submission_files (assignment_group_id);
CREATE INDEX IF NOT EXISTS idx_submission_files_class_id ON public.submission_files (class_id);
CREATE INDEX IF NOT EXISTS idx_submission_files_profile_id ON public.submission_files (profile_id);

-- submission_reviews
CREATE INDEX IF NOT EXISTS idx_submission_reviews_class_id ON public.submission_reviews (class_id);
CREATE INDEX IF NOT EXISTS idx_submission_reviews_completed_by ON public.submission_reviews (completed_by);
CREATE INDEX IF NOT EXISTS idx_submission_reviews_grader ON public.submission_reviews (grader);
CREATE INDEX IF NOT EXISTS idx_submission_reviews_meta_grader ON public.submission_reviews (meta_grader);
CREATE INDEX IF NOT EXISTS idx_submission_reviews_rubric_id ON public.submission_reviews (rubric_id);
CREATE INDEX IF NOT EXISTS idx_submission_reviews_submission_id ON public.submission_reviews (submission_id);

-- ====================
-- MISCELLANEOUS TABLES
-- ====================

-- tags
CREATE INDEX IF NOT EXISTS idx_tags_class_id ON public.tags (class_id);
CREATE INDEX IF NOT EXISTS idx_tags_creator_id ON public.tags (creator_id);
CREATE INDEX IF NOT EXISTS idx_tags_profile_id ON public.tags (profile_id);

-- user_roles (private_profile_id already has index)
CREATE INDEX IF NOT EXISTS idx_user_roles_class_id ON public.user_roles (class_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_class_section_id ON public.user_roles (class_section_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_public_profile_id ON public.user_roles (public_profile_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON public.user_roles (user_id);
