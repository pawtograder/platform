-- Lock down SECURITY DEFINER functions exposed through PostgREST.
--
-- Supabase's default privileges grant EXECUTE on every new function in `public` to anon and
-- authenticated directly (not via PUBLIC), so the long-standing
--   REVOKE ALL ... FROM PUBLIC; GRANT ... TO service_role;
-- pattern left "service-role only" functions callable by anyone holding the anon key. Because
-- they are SECURITY DEFINER they bypass RLS. An audit of all 282 non-trigger SECURITY DEFINER
-- functions found roughly 100 with no caller check (gradebook writes, GitHub/Discord job
-- enqueues with caller-chosen org/repo/usernames, the assessment export pepper, enrollment
-- merges, assignment deletion, ...) and several guarded ones with bypassable checks.
--
-- This migration:
--   1. Stops new functions from being executable by PUBLIC/anon/authenticated by default.
--      New user-facing RPCs (and functions called from RLS policies or security_invoker
--      views) must now GRANT EXECUTE ... TO authenticated explicitly.
--   2. Revokes anon/authenticated from functions only reached by service-role clients,
--      triggers, cron, or other SECURITY DEFINER functions.
--   3. Revokes anon from the remaining (user-facing, guarded) functions. Helpers used by RLS
--      policies that apply to anon keep anon EXECUTE; they key on auth.uid() and return false.
--   4. Fixes guards that could be bypassed:
--        - authorize_for_admin(p_user_id) trusted a caller-supplied id, so every admin_* RPC
--          that passed its own p_*_by argument could be satisfied with any admin's uuid.
--        - instructors could create, retarget or remove platform admins (user_roles.role =
--          'admin' in their own class counts as admin everywhere) via
--          create_user_role_for_existing_user, bulk_csv_import_enrollment, create_invitation,
--          or the user_roles and invitations RLS policies.
--        - update_gradebook_column_student_with_recalc had no check at all.
--        - release_instructor_only_gradebook_column allowed graders.
--        - soft_delete_survey deleted every class's surveys sharing a logical survey_id.
--        - update_rubric_full did not check the rubric's assignment or referenced checks are in
--          the class.
--        - update_regrade_request_status let any user open/escalate any class's requests.
--        - get_student_summary returned unreleased private grades to the student.
--        - send_signup_welcome_message, calculate_effective_due_date,
--          calculate_final_due_date and user_is_in_help_request answered for any user.

-- ---------------------------------------------------------------------------------------------
-- 1. Default privileges for functions created by migrations from here on.
-- ---------------------------------------------------------------------------------------------
-- The built-in EXECUTE-to-PUBLIC default can only be revoked globally (per-schema default
-- privileges can add to the global defaults but not remove from them), so this applies to every
-- function the role creates, in any schema. anon/authenticated are granted per schema by
-- Supabase, so those are revoked per schema.
--
-- Default privileges belong to the creating role. The Supabase CLI (local, CI, hosted) runs
-- migrations as postgres; the chart's migrations Job (charts/pawtograder/images/migrations)
-- runs them as supabase_admin, which has the same anon/authenticated defaults in public. Change
-- both where the running role may: postgres is not a member of supabase_admin, so a CLI run
-- skips it, and the superuser supabase_admin covers both.
DO $default_privileges$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role)
       AND pg_has_role(current_user, v_role, 'MEMBER') THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon, authenticated', v_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role', v_role);
    END IF;
  END LOOP;
END
$default_privileges$;

-- ---------------------------------------------------------------------------------------------
-- 2. Internal functions: no user-client caller. Each line notes what calls it today.
-- ---------------------------------------------------------------------------------------------
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public._grade_targets_for_submission(p_submission_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._grade_targets_for_submission(p_submission_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public._help_request_public_payload(tg_op text, new_row help_requests, old_row help_requests) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._help_request_public_payload(tg_op text, new_row help_requests, old_row help_requests) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public._materialize_bare_check_regrade_comment(p_request submission_regrade_requests, p_author uuid, p_points numeric, p_regrade_request_id bigint, p_submission_file_id bigint, p_line integer, p_submission_artifact_id bigint, OUT o_submission_comment_id bigint, OUT o_submission_file_comment_id bigint, OUT o_submission_artifact_comment_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._materialize_bare_check_regrade_comment(p_request submission_regrade_requests, p_author uuid, p_points numeric, p_regrade_request_id bigint, p_submission_file_id bigint, p_line integer, p_submission_artifact_id bigint, OUT o_submission_comment_id bigint, OUT o_submission_file_comment_id bigint, OUT o_submission_artifact_comment_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public._submission_review_is_completable(p_submission_review_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._submission_review_is_completable(p_submission_review_id bigint) TO service_role;
-- edge fn: _shared; admin client in lib
REVOKE ALL ON FUNCTION public._submission_review_recompute_scores(p_submission_review_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._submission_review_recompute_scores(p_submission_review_id bigint) TO service_role;
-- edge fn: autograder-create-submission, github-repo-webhook
REVOKE ALL ON FUNCTION public.apply_late_token_extension(p_assignment_id bigint, p_student_id uuid, p_assignment_group_id bigint, p_class_id bigint, p_creator_id uuid, p_hours_late integer, p_tokens_needed integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_late_token_extension(p_assignment_id bigint, p_student_id uuid, p_assignment_group_id bigint, p_class_id bigint, p_creator_id uuid, p_hours_late integer, p_tokens_needed integer) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.audit_maintain_partitions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.audit_maintain_partitions() TO service_role;
-- admin client in lib
REVOKE ALL ON FUNCTION public.call_cache_invalidate(tags text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.call_cache_invalidate(tags text[]) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.check_assignment_deadlines_passed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_assignment_deadlines_passed() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.check_assignment_release_dates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_assignment_release_dates() TO service_role;
-- edge fn: autograder-create-submission, github-async-worker
REVOKE ALL ON FUNCTION public.check_github_error_threshold(p_org text, p_threshold integer, p_window_minutes integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_github_error_threshold(p_org text, p_threshold integer, p_window_minutes integer) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.check_no_submission_release_dates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_no_submission_release_dates() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.check_required_check_satisfied_for_uncovered(p_submission_review_id bigint, p_rubric_check_id bigint, p_is_individual boolean, p_targets uuid[], p_num_targets integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_required_check_satisfied_for_uncovered(p_submission_review_id bigint, p_rubric_check_id bigint, p_is_individual boolean, p_targets uuid[], p_num_targets integer) TO service_role;
-- edge fn: github-async-worker
REVOKE ALL ON FUNCTION public.class_team_member_usernames(p_class_id bigint, p_kind text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.class_team_member_usernames(p_class_id bigint, p_kind text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.cleanup_expired_realtime_subscriptions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_realtime_subscriptions() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.cleanup_github_async_errors() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_github_async_errors() TO service_role;
-- edge fn: github-repo-webhook
REVOKE ALL ON FUNCTION public.clear_org_membership_and_repair(p_user_id uuid, p_org text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_org_membership_and_repair(p_user_id uuid, p_org text) TO service_role;
-- edge fn: cli
REVOKE ALL ON FUNCTION public.cli_import_submission_comments_batch(p_class_id bigint, p_assignment_id bigint, p_mode text, p_dry_run boolean, p_file_comments jsonb, p_artifact_comments jsonb, p_submission_comments jsonb, p_sync_submission_ids bigint[], p_default_author uuid, p_authors_by_submission jsonb, p_skip_sync boolean, p_run_sync_only boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cli_import_submission_comments_batch(p_class_id bigint, p_assignment_id bigint, p_mode text, p_dry_run boolean, p_file_comments jsonb, p_artifact_comments jsonb, p_submission_comments jsonb, p_sync_submission_ids bigint[], p_default_author uuid, p_authors_by_submission jsonb, p_skip_sync boolean, p_run_sync_only boolean) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.create_all_manual_submissions_for_assignment(p_class_id bigint, p_assignment_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_all_manual_submissions_for_assignment(p_class_id bigint, p_assignment_id bigint) TO service_role;
-- admin client in scripts
REVOKE ALL ON FUNCTION public.create_all_repos_for_assignment(course_id bigint, assignment_id bigint, p_force boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_all_repos_for_assignment(course_id bigint, assignment_id bigint, p_force boolean) TO service_role;
-- admin client in scripts
REVOKE ALL ON FUNCTION public.create_all_repos_for_assignment(course_id integer, assignment_id integer, p_force boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_all_repos_for_assignment(course_id integer, assignment_id integer, p_force boolean) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.create_all_repos_for_assignment_internal(course_id bigint, assignment_id bigint, p_force boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_all_repos_for_assignment_internal(course_id bigint, assignment_id bigint, p_force boolean) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.create_help_request_message_notification(p_class_id bigint, p_help_request_id bigint, p_help_queue_id bigint, p_help_queue_name text, p_message_id bigint, p_author_profile_id uuid, p_author_name text, p_message_preview text, p_help_request_creator_profile_id uuid, p_help_request_creator_name text, p_is_private boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_help_request_message_notification(p_class_id bigint, p_help_request_id bigint, p_help_queue_id bigint, p_help_queue_name text, p_message_id bigint, p_author_profile_id uuid, p_author_name text, p_message_preview text, p_help_request_creator_profile_id uuid, p_help_request_creator_name text, p_is_private boolean) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.create_help_request_notification(p_class_id bigint, p_notification_type text, p_help_request_id bigint, p_help_queue_id bigint, p_help_queue_name text, p_creator_profile_id uuid, p_creator_name text, p_assignee_profile_id uuid, p_assignee_name text, p_status help_request_status, p_request_preview text, p_is_private boolean, p_action text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_help_request_notification(p_class_id bigint, p_notification_type text, p_help_request_id bigint, p_help_queue_id bigint, p_help_queue_name text, p_creator_profile_id uuid, p_creator_name text, p_assignee_profile_id uuid, p_assignee_name text, p_status help_request_status, p_request_preview text, p_is_private boolean, p_action text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.create_manual_submission_internal(p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_manual_submission_internal(p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.create_no_repo_submission_internal(p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_no_repo_submission_internal(p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.create_repos_for_student(user_id uuid, class_id integer, p_force boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_repos_for_student(user_id uuid, class_id integer, p_force boolean) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.create_user_role_for_existing_user(p_user_id uuid, p_class_id bigint, p_role app_role, p_name text, p_sis_id integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_user_role_for_existing_user(p_user_id uuid, p_class_id bigint, p_role app_role, p_name text, p_sis_id integer) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.criteria_max_satisfied_for_uncovered(p_submission_review_id bigint, p_rubric_criteria_id bigint, p_max integer, p_is_individual boolean, p_targets uuid[], p_num_targets integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criteria_max_satisfied_for_uncovered(p_submission_review_id bigint, p_rubric_criteria_id bigint, p_max integer, p_is_individual boolean, p_targets uuid[], p_num_targets integer) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.criteria_min_satisfied_for_uncovered(p_submission_review_id bigint, p_rubric_criteria_id bigint, p_min integer, p_is_individual boolean, p_targets uuid[], p_num_targets integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criteria_min_satisfied_for_uncovered(p_submission_review_id bigint, p_rubric_criteria_id bigint, p_min integer, p_is_individual boolean, p_targets uuid[], p_num_targets integer) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.deactivate_expired_polls() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deactivate_expired_polls() TO service_role;
-- edge fn: assignment-delete
REVOKE ALL ON FUNCTION public.delete_assignment_with_all_data(p_assignment_id bigint, p_class_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_assignment_with_all_data(p_assignment_id bigint, p_class_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.delete_queued_messages_for_class(p_class_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_queued_messages_for_class(p_class_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.delete_queued_messages_for_class_simple(p_class_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_queued_messages_for_class_simple(p_class_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.delete_system_notifications_by_campaign(p_campaign_id text, p_deleted_by uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_system_notifications_by_campaign(p_campaign_id text, p_deleted_by uuid) TO service_role;
-- edge fn: discord-async-worker
REVOKE ALL ON FUNCTION public.discord_student_join_enabled(p_class_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discord_student_join_enabled(p_class_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_create_repo_for_repository(p_repository_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_create_repo_for_repository(p_repository_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_batch_role_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_batch_role_sync() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_channel_creation(p_class_id bigint, p_channel_type discord_channel_type, p_resource_id bigint, p_channel_name text, p_guild_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_channel_creation(p_class_id bigint, p_channel_type discord_channel_type, p_resource_id bigint, p_channel_name text, p_guild_id text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_discussion_thread_message(p_thread_id bigint, p_action text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_discussion_thread_message(p_thread_id bigint, p_action text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_help_request_message(p_help_request_id bigint, p_action text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_help_request_message(p_help_request_id bigint, p_action text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_invites_for_existing_users(p_class_id bigint, p_guild_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_invites_for_existing_users(p_class_id bigint, p_guild_id text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_queue_assignment_message(p_queue_assignment_id bigint, p_action text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_queue_assignment_message(p_queue_assignment_id bigint, p_action text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_register_commands() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_register_commands() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_regrade_request_message(p_regrade_request_id bigint, p_action text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_regrade_request_message(p_regrade_request_id bigint, p_action text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_role_creation(p_class_id bigint, p_role_type text, p_guild_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_role_creation(p_class_id bigint, p_role_type text, p_guild_id text) TO service_role;
-- edge fn: discord-async-worker; admin client in app
REVOKE ALL ON FUNCTION public.enqueue_discord_role_sync(p_user_id uuid, p_class_id bigint, p_role app_role, p_action text, p_membership_verified_at timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_role_sync(p_user_id uuid, p_class_id bigint, p_role app_role, p_action text, p_membership_verified_at timestamp with time zone) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_discord_roles_creation(p_class_id bigint, p_guild_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_discord_roles_creation(p_class_id bigint, p_guild_id text) TO service_role;
-- edge fn: _shared
REVOKE ALL ON FUNCTION public.enqueue_github_archive_repo(p_class_id bigint, p_org text, p_repo text, p_debug_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_archive_repo(p_class_id bigint, p_org text, p_repo text, p_debug_id text) TO service_role;
-- edge fn: assignment-group-create, assignment-group-instructor-create
REVOKE ALL ON FUNCTION public.enqueue_github_create_repo(p_class_id bigint, p_org text, p_repo_name text, p_template_repo text, p_course_slug text, p_github_usernames text[], p_is_template_repo boolean, p_debug_id text, p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint, p_latest_template_sha text, p_creation_method text, p_source_repo text, p_branch_protection jsonb, p_student_team_permission text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_create_repo(p_class_id bigint, p_org text, p_repo_name text, p_template_repo text, p_course_slug text, p_github_usernames text[], p_is_template_repo boolean, p_debug_id text, p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint, p_latest_template_sha text, p_creation_method text, p_source_repo text, p_branch_protection jsonb, p_student_team_permission text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.enqueue_github_org_reinvite(p_class_id bigint, p_org text, p_course_slug text, p_user_id uuid, p_is_staff boolean, p_debug_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_org_reinvite(p_class_id bigint, p_org text, p_course_slug text, p_user_id uuid, p_is_staff boolean, p_debug_id text) TO service_role;
-- edge fn: _shared
REVOKE ALL ON FUNCTION public.enqueue_github_sync_repo_permissions(p_class_id bigint, p_org text, p_repo text, p_course_slug text, p_github_usernames text[], p_debug_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_sync_repo_permissions(p_class_id bigint, p_org text, p_repo text, p_course_slug text, p_github_usernames text[], p_debug_id text) TO service_role;
-- admin client in scripts
REVOKE ALL ON FUNCTION public.enqueue_github_sync_staff_team(p_class_id bigint, p_org text, p_course_slug text, p_affected_user_id uuid, p_debug_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_sync_staff_team(p_class_id bigint, p_org text, p_course_slug text, p_affected_user_id uuid, p_debug_id text) TO service_role;
-- admin client in scripts
REVOKE ALL ON FUNCTION public.enqueue_github_sync_student_team(p_class_id bigint, p_org text, p_course_slug text, p_affected_user_id uuid, p_debug_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_github_sync_student_team(p_class_id bigint, p_org text, p_course_slug text, p_affected_user_id uuid, p_debug_id text) TO service_role;
-- edge fn: gradebook-column-recalculate
REVOKE ALL ON FUNCTION public.enqueue_gradebook_row_recalculation(p_class_id bigint, p_gradebook_id bigint, p_student_id uuid, p_is_private boolean, p_reason text, p_trigger_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_gradebook_row_recalculation(p_class_id bigint, p_gradebook_id bigint, p_student_id uuid, p_is_private boolean, p_reason text, p_trigger_id bigint) TO service_role;
-- edge fn: gradebook-column-inserted
REVOKE ALL ON FUNCTION public.enqueue_gradebook_row_recalculation_batch(p_rows jsonb[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_gradebook_row_recalculation_batch(p_rows jsonb[]) TO service_role;
-- edge fn: github-async-worker
REVOKE ALL ON FUNCTION public.enqueue_sync_repo_permissions_for_repo(p_repo_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_sync_repo_permissions_for_repo(p_repo_id bigint) TO service_role;
-- edge fn: cli
REVOKE ALL ON FUNCTION public.get_assessment_export_pepper() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_assessment_export_pepper() TO service_role;
-- edge fn: metrics
REVOKE ALL ON FUNCTION public.get_async_queue_sizes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_async_queue_sizes() TO service_role;
-- edge fn: metrics
REVOKE ALL ON FUNCTION public.get_circuit_breaker_statuses() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_circuit_breaker_statuses() TO service_role;
-- edge fn: _shared, autograder-create-submission, github-async-worker, github-repo-webhook
REVOKE ALL ON FUNCTION public.get_github_circuit(p_scope text, p_key text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_github_circuit(p_scope text, p_key text) TO service_role;
-- edge fn: github-membership-reconciler
REVOKE ALL ON FUNCTION public.get_stuck_org_membership_alerts(p_days integer, p_invitation_age_days integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_stuck_org_membership_alerts(p_days integer, p_invitation_age_days integer) TO service_role;
-- edge fn: enrollments-add
REVOKE ALL ON FUNCTION public.get_user_id_by_email(email text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_id_by_email(email text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.help_request_is_private(p_help_request_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.help_request_is_private(p_help_request_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.help_request_notification(p_help_request_id bigint, p_action text, p_class_id bigint, p_help_queue_id bigint, p_help_queue_name text, p_creator_profile_id uuid, p_creator_name text, p_assignee_profile_id uuid, p_assignee_name text, p_status text, p_request_preview text, p_is_private boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.help_request_notification(p_help_request_id bigint, p_action text, p_class_id bigint, p_help_queue_id bigint, p_help_queue_name text, p_creator_profile_id uuid, p_creator_name text, p_assignee_profile_id uuid, p_assignee_name text, p_status text, p_request_preview text, p_is_private boolean) TO service_role;
-- edge fn: github-repo-webhook, pr-link-confirm
REVOKE ALL ON FUNCTION public.ingest_pr_submission(p_assignment_id bigint, p_pr_repo text, p_pr_number integer, p_base_sha text, p_head_sha text, p_pr_state text, p_profile_id uuid, p_assignment_group_id bigint, p_auto_confirm boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_pr_submission(p_assignment_id bigint, p_pr_repo text, p_pr_number integer, p_base_sha text, p_head_sha text, p_pr_state text, p_profile_id uuid, p_assignment_group_id bigint, p_auto_confirm boolean) TO service_role;
-- edge fn: discord-async-worker
REVOKE ALL ON FUNCTION public.insert_discord_message(p_class_id bigint, p_discord_message_id text, p_discord_channel_id text, p_resource_type text, p_resource_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insert_discord_message(p_class_id bigint, p_discord_message_id text, p_discord_channel_id text, p_resource_type text, p_resource_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.invoke_github_membership_reconciler_background_task() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_github_membership_reconciler_background_task() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.invoke_github_repo_reconciler_background_task() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoke_github_repo_reconciler_background_task() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.is_allowed_grader_key(graderkey text, class bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_allowed_grader_key(graderkey text, class bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.is_in_class(userid uuid, classid bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_in_class(userid uuid, classid bigint) TO service_role;
-- edge fn: github-async-worker
REVOKE ALL ON FUNCTION public.log_api_gateway_call(p_method text, p_status_code integer, p_class_id bigint, p_debug_id text, p_message_processed_at timestamp with time zone, p_latency_ms integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_api_gateway_call(p_method text, p_status_code integer, p_class_id bigint, p_debug_id text, p_message_processed_at timestamp with time zone, p_latency_ms integer) TO service_role;
-- admin client in lib
REVOKE ALL ON FUNCTION public.lti_consume_nonce(p_nonce text, p_ttl_seconds integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lti_consume_nonce(p_nonce text, p_ttl_seconds integer) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.lti_grade_drain_safety_net() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lti_grade_drain_safety_net() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.lti_kick_grade_drain() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lti_kick_grade_drain() TO service_role;
-- admin client in lib
REVOKE ALL ON FUNCTION public.lti_upsert_line_item(p_context_link_id bigint, p_class_id bigint, p_assignment_id bigint, p_gradebook_column_id bigint, p_line_item_url text, p_label text, p_score_maximum numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lti_upsert_line_item(p_context_link_id bigint, p_class_id bigint, p_assignment_id bigint, p_gradebook_column_id bigint, p_line_item_url text, p_label text, p_score_maximum numeric) TO service_role;
-- edge fn: discord-async-worker; admin client in app, components
REVOKE ALL ON FUNCTION public.mark_discord_invite_used(p_user_id uuid, p_guild_id text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_discord_invite_used(p_user_id uuid, p_guild_id text) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.merge_duplicate_class_enrollments(p_class_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_duplicate_class_enrollments(p_class_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.only_discord_ids_changed(new_row classes) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.only_discord_ids_changed(new_row classes) TO service_role;
-- edge fn: autograder-create-submission, github-async-worker
REVOKE ALL ON FUNCTION public.open_github_circuit(p_scope text, p_key text, p_event text, p_retry_after_seconds integer, p_reason text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_github_circuit(p_scope text, p_key text, p_event text, p_retry_after_seconds integer, p_reason text) TO service_role;
-- edge fn: calendar-sync
REVOKE ALL ON FUNCTION public.process_calendar_announcements() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_calendar_announcements() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.recalculate_discussion_thread_children_counts(target_class_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_discussion_thread_children_counts(target_class_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.recalculate_gradebook_columns_in_range(start_id bigint, end_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_gradebook_columns_in_range(start_id bigint, end_id bigint) TO service_role;
-- edge fn: _shared, github-membership-reconciler
REVOKE ALL ON FUNCTION public.reconcile_stale_org_invitations(p_stale_days integer, p_new_role_grace_minutes integer, p_max integer, p_max_per_class integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_org_invitations(p_stale_days integer, p_new_role_grace_minutes integer, p_max integer, p_max_per_class integer) TO service_role;
-- edge fn: _shared, github-repo-reconciler
REVOKE ALL ON FUNCTION public.reconcile_stuck_repo_creations(p_stale_minutes integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stuck_repo_creations(p_stale_minutes integer) TO service_role;
-- edge fn: autograder-create-submission, github-async-worker
REVOKE ALL ON FUNCTION public.record_github_async_error(p_org text, p_method text, p_error_data jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_github_async_error(p_org text, p_method text, p_error_data jsonb) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.repo_ids_with_queued_create() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.repo_ids_with_queued_create() TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.resolve_calendar_event_queues(p_class_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_calendar_event_queues(p_class_id bigint) TO service_role;
-- edge fn: github-repo-webhook
REVOKE ALL ON FUNCTION public.set_pr_state(p_assignment_id bigint, p_pr_repo text, p_pr_number integer, p_pr_state text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_pr_state(p_assignment_id bigint, p_pr_repo text, p_pr_number integer, p_pr_state text) TO service_role;
-- edge fn: calendar-sync
REVOKE ALL ON FUNCTION public.sync_calendar_events(p_class_id bigint, p_calendar_type text, p_parsed_events jsonb, p_has_discord_server boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_calendar_events(p_class_id bigint, p_calendar_type text, p_parsed_events jsonb, p_has_discord_server boolean) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.sync_existing_users_after_roles_created(p_class_id bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_existing_users_after_roles_created(p_class_id bigint) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.sync_repo_permissions_for_student(p_user_id uuid, p_class_id integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_repo_permissions_for_student(p_user_id uuid, p_class_id integer) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.sync_staff_github_team(class_id integer, user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_staff_github_team(class_id integer, user_id uuid) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.sync_student_github_team(class_id integer, user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_student_github_team(class_id integer, user_id uuid) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.test_discussion_thread_insert_performance(test_class_id bigint, test_topic_id bigint, test_author_id uuid, num_inserts integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.test_discussion_thread_insert_performance(test_class_id bigint, test_topic_id bigint, test_author_id uuid, num_inserts integer) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.trigger_lti_roster_sync() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trigger_lti_roster_sync() TO service_role;
-- edge fn: github-async-worker
REVOKE ALL ON FUNCTION public.update_api_gateway_call(p_log_id bigint, p_status_code integer, p_latency_ms integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_api_gateway_call(p_log_id bigint, p_status_code integer, p_latency_ms integer) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.update_gradebook_column_students_batch_with_recalc(p_updates jsonb[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_gradebook_column_students_batch_with_recalc(p_updates jsonb[]) TO service_role;
-- edge fn: gradebook-column-recalculate
REVOKE ALL ON FUNCTION public.update_gradebook_row(p_class_id bigint, p_gradebook_id bigint, p_student_id uuid, p_is_private boolean, p_updates jsonb[], p_expected_version bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_gradebook_row(p_class_id bigint, p_gradebook_id bigint, p_student_id uuid, p_is_private boolean, p_updates jsonb[], p_expected_version bigint) TO service_role;
-- edge fn: _shared, gradebook-column-recalculate
REVOKE ALL ON FUNCTION public.update_gradebook_rows_batch(p_batch_updates jsonb[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_gradebook_rows_batch(p_batch_updates jsonb[]) TO service_role;
-- edge fn: github-repo-webhook; admin client in app
REVOKE ALL ON FUNCTION public.upsert_github_deployment(p_class_id bigint, p_repository_name text, p_repository_id bigint, p_sha text, p_environment text, p_state text, p_target_url text, p_github_deployment_id bigint, p_github_deployment_status_id bigint, p_creator_login text, p_payload jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_github_deployment(p_class_id bigint, p_repository_name text, p_repository_id bigint, p_sha text, p_environment text, p_state text, p_target_url text, p_github_deployment_id bigint, p_github_deployment_status_id bigint, p_creator_login text, p_payload jsonb) TO service_role;
-- SQL only (triggers / cron / other SECURITY DEFINER functions)
REVOKE ALL ON FUNCTION public.vacuum_health_check() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vacuum_health_check() TO service_role;
-- SECURITY INVOKER wrapper around enqueue_discord_role_sync; only update_discord_profile() calls it
REVOKE ALL ON FUNCTION public.check_discord_role_sync_after_link(p_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_discord_role_sync_after_link(p_user_id uuid) TO service_role;
-- no caller; the body requires service_role (20250830163212 revoked it from authenticated)
REVOKE ALL ON FUNCTION public.get_assignment_llm_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_assignment_llm_metrics() TO service_role;
-- no caller; the body requires service_role (20250830163212 revoked it from authenticated)
REVOKE ALL ON FUNCTION public.get_llm_tags_breakdown() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_llm_tags_breakdown() TO service_role;
-- service-role client in tests/e2e only; the body requires service_role
REVOKE ALL ON FUNCTION public.merge_class_feature_as_service_role(p_class_id bigint, p_name text, p_enabled boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_class_feature_as_service_role(p_class_id bigint, p_name text, p_enabled boolean) TO service_role;
-- no caller; answered for any _person_id
REVOKE ALL ON FUNCTION public.is_instructor_for_student(_person_id uuid, _student_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_instructor_for_student(_person_id uuid, _student_id uuid) TO service_role;
-- only trigger_signup_welcome_message() (SECURITY DEFINER below) calls it
REVOKE ALL ON FUNCTION public.send_signup_welcome_message(p_user_id uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_signup_welcome_message(p_user_id uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. User-facing functions: guarded by an in-body check; remove anon.
-- ---------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_bind_lti_context(p_context_link_id bigint, p_class_id bigint, p_section_role text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_bind_lti_context(p_context_link_id bigint, p_class_id bigint, p_section_role text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_bulk_set_user_roles_disabled(p_user_role_ids bigint[], p_disabled boolean, p_admin_user_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_bulk_set_user_roles_disabled(p_user_role_ids bigint[], p_disabled boolean, p_admin_user_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_create_class(p_name text, p_term integer, p_description text, p_github_org_name text, p_github_template_prefix text, p_created_by uuid, p_course_title text, p_start_date date, p_end_date date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_class(p_name text, p_term integer, p_description text, p_github_org_name text, p_github_template_prefix text, p_created_by uuid, p_course_title text, p_start_date date, p_end_date date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_create_class_section(p_class_id bigint, p_name text, p_created_by uuid, p_meeting_location text, p_meeting_times text, p_campus text, p_sis_crn integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_class_section(p_class_id bigint, p_name text, p_created_by uuid, p_meeting_location text, p_meeting_times text, p_campus text, p_sis_crn integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_create_lab_section(p_class_id bigint, p_name text, p_created_by uuid, p_meeting_location text, p_meeting_times text, p_campus text, p_sis_crn integer, p_day_of_week day_of_week, p_start_time time without time zone, p_end_time time without time zone, p_description text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_lab_section(p_class_id bigint, p_name text, p_created_by uuid, p_meeting_location text, p_meeting_times text, p_campus text, p_sis_crn integer, p_day_of_week day_of_week, p_start_time time without time zone, p_end_time time without time zone, p_description text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_create_lti_sections_from_canvas(p_context_link_id bigint, p_section_names text[], p_created_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_lti_sections_from_canvas(p_context_link_id bigint, p_section_names text[], p_created_by uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_class(p_class_id bigint, p_deleted_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_class(p_class_id bigint, p_deleted_by uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_class_section(p_section_id bigint, p_deleted_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_class_section(p_section_id bigint, p_deleted_by uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_lab_section(p_section_id bigint, p_deleted_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_lab_section(p_section_id bigint, p_deleted_by uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_lti_platform(p_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_lti_platform(p_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_enter_course_as_instructor(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_enter_course_as_instructor(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_get_class_sections(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_class_sections(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_get_classes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_classes() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_get_disabled_users(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_disabled_users(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_get_github_orgs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_github_orgs() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_get_org_courses(p_org_name text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_org_courses(p_org_name text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_get_sis_sync_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_sis_sync_status() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_list_lti_contexts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_lti_contexts() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_lookup_user_by_email(p_email text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_lookup_user_by_email(p_email text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_set_section_sync_enabled(p_course_id bigint, p_enabled boolean, p_course_section_id bigint, p_lab_section_id bigint, p_admin_user_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_section_sync_enabled(p_course_id bigint, p_enabled boolean, p_course_section_id bigint, p_lab_section_id bigint, p_admin_user_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_set_sis_sync_enabled(p_class_id bigint, p_enabled boolean, p_admin_user_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_sis_sync_enabled(p_class_id bigint, p_enabled boolean, p_admin_user_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_set_user_role_disabled(p_user_role_id bigint, p_disabled boolean, p_admin_user_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_user_role_disabled(p_user_role_id bigint, p_disabled boolean, p_admin_user_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_trigger_sis_sync(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_trigger_sis_sync(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_update_class(p_class_id bigint, p_name text, p_term integer, p_description text, p_github_org_name text, p_github_template_prefix text, p_updated_by uuid, p_course_title text, p_start_date date, p_end_date date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_class(p_class_id bigint, p_name text, p_term integer, p_description text, p_github_org_name text, p_github_template_prefix text, p_updated_by uuid, p_course_title text, p_start_date date, p_end_date date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_update_class_section(p_section_id bigint, p_name text, p_updated_by uuid, p_sis_crn integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_class_section(p_section_id bigint, p_name text, p_updated_by uuid, p_sis_crn integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_update_lab_section(p_section_id bigint, p_name text, p_updated_by uuid, p_sis_crn integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_lab_section(p_section_id bigint, p_name text, p_updated_by uuid, p_sis_crn integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_upsert_github_org(p_org_name text, p_handout text, p_solution text, p_permission_sync_exempt_users text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_github_org(p_org_name text, p_handout text, p_solution text, p_permission_sync_exempt_users text[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_upsert_lti_platform(p_id bigint, p_name text, p_issuer text, p_client_id text, p_auth_login_url text, p_token_url text, p_jwks_url text, p_enabled boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_lti_platform(p_id bigint, p_name text, p_issuer text, p_client_id text, p_auth_login_url text, p_token_url text, p_jwks_url text, p_enabled boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.attach_no_repo_submission_files(p_submission_id bigint, p_files jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attach_no_repo_submission_files(p_submission_id bigint, p_files jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorize_for_submission_reviewable(requested_submission_id bigint, requested_submission_review_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_for_submission_reviewable(requested_submission_id bigint, requested_submission_review_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorize_to_create_own_due_date_extension(_student_id uuid, _assignment_group_id bigint, _assignment_id bigint, _class_id bigint, _creator_id uuid, _hours_to_extend integer, _tokens_consumed integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorize_to_create_own_due_date_extension(_student_id uuid, _assignment_group_id bigint, _assignment_id bigint, _class_id bigint, _creator_id uuid, _hours_to_extend integer, _tokens_consumed integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorizeforinstructorofstudent(_user_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorizeforinstructorofstudent(_user_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorizeforinstructororgraderofstudent(_user_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorizeforinstructororgraderofstudent(_user_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorizeforpoll(poll__id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorizeforpoll(poll__id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.authorizeforpoll(poll__id bigint, class__id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.authorizeforpoll(poll__id bigint, class__id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bulk_assign_reviews(p_class_id bigint, p_assignment_id bigint, p_rubric_id bigint, p_draft_assignments jsonb, p_due_date timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_assign_reviews(p_class_id bigint, p_assignment_id bigint, p_rubric_id bigint, p_draft_assignments jsonb, p_due_date timestamp with time zone) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bulk_csv_import_enrollment(p_class_id bigint, p_import_mode text, p_enrollment_data jsonb, p_notify boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_csv_import_enrollment(p_class_id bigint, p_import_mode text, p_enrollment_data jsonb, p_notify boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.bulk_update_review_assignment_due_dates(p_class_id bigint, p_assignment_id bigint, p_rubric_id bigint, p_due_date timestamp with time zone, p_only_incomplete boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bulk_update_review_assignment_due_dates(p_class_id bigint, p_assignment_id bigint, p_rubric_id bigint, p_due_date timestamp with time zone, p_only_incomplete boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.calculate_effective_due_date(assignment_id_param bigint, student_profile_id_param uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_effective_due_date(assignment_id_param bigint, student_profile_id_param uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.calculate_final_due_date(assignment_id_param bigint, student_profile_id_param uuid, assignment_group_id_param bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_final_due_date(assignment_id_param bigint, student_profile_id_param uuid, assignment_group_id_param bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_access_help_request(help_request_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_help_request(help_request_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_access_submission_storage_path(path text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_submission_storage_path(path text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.channel_has_subscribers(p_channel text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.channel_has_subscribers(p_channel text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.check_can_remove_from_help_request(p_help_request_id bigint, p_profile_id_to_remove uuid, p_user_id uuid, p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_can_remove_from_help_request(p_help_request_id bigint, p_profile_id_to_remove uuid, p_user_id uuid, p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.check_gradebook_realtime_authorization(topic_text text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_gradebook_realtime_authorization(topic_text text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.check_grading_completion_eligibility(p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_grading_completion_eligibility(p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.check_unified_realtime_authorization(topic_text text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_unified_realtime_authorization(topic_text text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.cleanup_individual_repositories_for_assignment(p_class_id bigint, p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cleanup_individual_repositories_for_assignment(p_class_id bigint, p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.clear_all_incomplete_review_assignments(p_class_id bigint, p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_all_incomplete_review_assignments(p_class_id bigint, p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.clear_incomplete_assignments_for_user(p_class_id bigint, p_assignment_id bigint, p_assignee_profile_id uuid, p_rubric_id bigint, p_rubric_part_ids bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_incomplete_assignments_for_user(p_class_id bigint, p_assignment_id bigint, p_assignee_profile_id uuid, p_rubric_id bigint, p_rubric_part_ids bigint[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.clear_unfinished_review_assignments(p_class_id bigint, p_assignment_id bigint, p_rubric_id bigint, p_rubric_part_ids bigint[], p_class_section_ids bigint[], p_lab_section_ids bigint[], p_student_tag_filters jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clear_unfinished_review_assignments(p_class_id bigint, p_assignment_id bigint, p_rubric_id bigint, p_rubric_part_ids bigint[], p_class_section_ids bigint[], p_lab_section_ids bigint[], p_student_tag_filters jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_eligible_grading_reviews(p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_eligible_grading_reviews(p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.copy_groups_from_assignment(p_class_id bigint, p_source_assignment_id bigint, p_target_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.copy_groups_from_assignment(p_class_id bigint, p_source_assignment_id bigint, p_target_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_help_request_with_participants(p_help_queue_id bigint, p_request text, p_is_private boolean, p_location_type location_type, p_student_profile_ids uuid[], p_template_id bigint, p_referenced_submission_id bigint, p_file_references jsonb, p_followup_to bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_help_request_with_participants(p_help_queue_id bigint, p_request text, p_is_private boolean, p_location_type location_type, p_student_profile_ids uuid[], p_template_id bigint, p_referenced_submission_id bigint, p_file_references jsonb, p_followup_to bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_invitation(p_class_id bigint, p_role app_role, p_sis_user_id integer, p_email text, p_name text, p_invited_by uuid, p_class_section_id bigint, p_lab_section_id bigint, p_sis_managed boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_invitation(p_class_id bigint, p_role app_role, p_sis_user_id integer, p_email text, p_name text, p_invited_by uuid, p_class_section_id bigint, p_lab_section_id bigint, p_sis_managed boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_manual_submission(p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_submission(p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_manual_submissions_for_non_submitters(p_assignment_id bigint, p_profile_ids uuid[], p_assignment_group_ids bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_submissions_for_non_submitters(p_assignment_id bigint, p_profile_ids uuid[], p_assignment_group_ids bigint[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_no_repo_submission(p_assignment_id bigint, p_files jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_no_repo_submission(p_assignment_id bigint, p_files jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_regrade_request(private_profile_id uuid, submission_file_comment_id bigint, submission_comment_id bigint, submission_artifact_comment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_regrade_request(private_profile_id uuid, submission_file_comment_id bigint, submission_comment_id bigint, submission_artifact_comment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_regrade_request_for_check(private_profile_id uuid, p_submission_review_id bigint, p_rubric_check_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_regrade_request_for_check(private_profile_id uuid, p_submission_review_id bigint, p_rubric_check_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_submission_for_student(p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_submission_for_student(p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_survey_assignments(p_survey_id uuid, p_profile_ids uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_survey_assignments(p_survey_id uuid, p_profile_ids uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_system_notification(p_title text, p_message text, p_display text, p_severity text, p_icon text, p_persistent boolean, p_expires_at timestamp with time zone, p_campaign_id text, p_track_engagement boolean, p_max_width text, p_position text, p_backdrop_dismiss boolean, p_target_roles app_role[], p_target_course_ids bigint[], p_target_user_ids uuid[], p_created_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_system_notification(p_title text, p_message text, p_display text, p_severity text, p_icon text, p_persistent boolean, p_expires_at timestamp with time zone, p_campaign_id text, p_track_engagement boolean, p_max_width text, p_position text, p_backdrop_dismiss boolean, p_target_roles app_role[], p_target_course_ids bigint[], p_target_user_ids uuid[], p_created_by uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_autograder_reruns(p_submission_ids bigint[], p_class_id bigint, p_grader_sha text, p_auto_promote boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_autograder_reruns(p_submission_ids bigint[], p_class_id bigint, p_grader_sha text, p_auto_promote boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_repo_analytics_fetch(p_class_id bigint, p_assignment_id bigint, p_org text, p_repository_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_repo_analytics_fetch(p_class_id bigint, p_assignment_id bigint, p_org text, p_repository_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.finalize_submission_early(this_assignment_id bigint, this_profile_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finalize_submission_early(this_assignment_id bigint, this_profile_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fix_assignment_repo_permissions(p_class_id bigint, p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fix_assignment_repo_permissions(p_class_id bigint, p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_assignments_for_student_dashboard(p_class_id bigint, p_student_profile_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_assignments_for_student_dashboard(p_class_id bigint, p_student_profile_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_common_test_errors_for_assignment(p_assignment_id bigint, p_test_name text, p_test_part text, p_min_occurrences integer, p_limit integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_common_test_errors_for_assignment(p_assignment_id bigint, p_test_name text, p_test_part text, p_min_occurrences integer, p_limit integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_discussion_engagement(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_discussion_engagement(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_error_pin_matches_for_submission(p_submission_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_error_pin_matches_for_submission(p_submission_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_error_pins_for_error_pattern(p_assignment_id bigint, p_test_name text, p_error_output text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_error_pins_for_error_pattern(p_assignment_id bigint, p_test_name text, p_error_output text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_gradebook_records_for_all_students(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gradebook_records_for_all_students(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_gradebook_records_for_all_students_array(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_gradebook_records_for_all_students_array(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_grading_progress_for_assignment(p_class_id bigint, p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_grading_progress_for_assignment(p_class_id bigint, p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_instructor_dashboard_overview_metrics(p_class_id bigint, p_now timestamp with time zone) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_instructor_dashboard_overview_metrics(p_class_id bigint, p_now timestamp with time zone) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_rubric_check_application_stats(p_assignment_id bigint, p_filter jsonb, p_review_round text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_rubric_check_application_stats(p_assignment_id bigint, p_filter jsonb, p_review_round text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_rubric_report_cohort_members(p_assignment_id bigint, p_filter jsonb, p_review_round text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_rubric_report_cohort_members(p_assignment_id bigint, p_filter jsonb, p_review_round text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_student_summary(p_class_id bigint, p_student_profile_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_student_summary(p_class_id bigint, p_student_profile_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_submissions_limits(p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_submissions_limits(p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_submissions_to_full_marks(p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_submissions_to_full_marks(p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_survey_responses_for_submission(p_submission_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_survey_responses_for_submission(p_submission_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_survey_responses_with_full_context(p_survey_id uuid, p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_survey_responses_with_full_context(p_survey_id uuid, p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_survey_responses_with_group_context(p_survey_id uuid, p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_survey_responses_with_group_context(p_survey_id uuid, p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_survey_series_trend_data(p_series_id uuid, p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_survey_series_trend_data(p_series_id uuid, p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_survey_status_for_assignment(p_assignment_id bigint, p_profile_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_survey_status_for_assignment(p_assignment_id bigint, p_profile_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_system_notification_stats(p_requested_by uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_system_notification_stats(p_requested_by uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_test_statistics_for_assignment(p_assignment_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_test_statistics_for_assignment(p_assignment_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_workflow_events_summary_for_class(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_workflow_events_summary_for_class(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_workflow_statistics(p_class_id bigint, p_duration_hours integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_workflow_statistics(p_class_id bigint, p_duration_hours integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.gift_tokens_to_student(p_student_id uuid, p_class_id bigint, p_assignment_id bigint, p_tokens_to_gift integer, p_note text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gift_tokens_to_student(p_student_id uuid, p_class_id bigint, p_assignment_id bigint, p_tokens_to_gift integer, p_note text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.gradebook_auto_layout(p_gradebook_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gradebook_auto_layout(p_gradebook_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.gradebook_columns_reorder(p_ordered_column_ids bigint[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gradebook_columns_reorder(p_ordered_column_ids bigint[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.import_gradebook_scores(p_class_id bigint, p_updates jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_gradebook_scores(p_class_id bigint, p_updates jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_instructor_for_class(_person_id uuid, _class_id integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_instructor_for_class(_person_id uuid, _class_id integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_instructor_for_class(_person_id uuid, classid bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_instructor_for_class(_person_id uuid, classid bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_discussion_thread_duplicate(p_duplicate_root_id bigint, p_original_root_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_discussion_thread_duplicate(p_duplicate_root_id bigint, p_original_root_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.merge_class_feature(p_class_id bigint, p_name text, p_enabled boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_class_feature(p_class_id bigint, p_name text, p_enabled boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.only_calendar_or_discord_ids_changed(new_row classes) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.only_calendar_or_discord_ids_changed(new_row classes) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.preview_error_pin_matches(p_assignment_id bigint, p_rules jsonb, p_rule_logic text, p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_error_pin_matches(p_assignment_id bigint, p_rules jsonb, p_rule_logic text, p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.promote_whatif_grader_result(p_grader_result_id bigint, p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promote_whatif_grader_result(p_grader_result_id bigint, p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.publish_assignment_group_changes(p_class_id bigint, p_assignment_id bigint, p_groups_to_create jsonb, p_moves_to_fulfill jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.publish_assignment_group_changes(p_class_id bigint, p_assignment_id bigint, p_groups_to_create jsonb, p_moves_to_fulfill jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.queue_repository_syncs(p_repository_ids bigint[], p_force boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.queue_repository_syncs(p_repository_ids bigint[], p_force boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.refresh_realtime_subscription(p_channel text, p_client_id uuid, p_lease_seconds integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_realtime_subscription(p_channel text, p_client_id uuid, p_lease_seconds integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.register_realtime_subscription(p_channel text, p_client_id uuid, p_lease_seconds integer, p_profile_id uuid, p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_realtime_subscription(p_channel text, p_client_id uuid, p_lease_seconds integer, p_profile_id uuid, p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_instructor_only_gradebook_column(p_column_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_instructor_only_gradebook_column(p_column_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.reset_error_pin_matches(p_error_pin_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reset_error_pin_matches(p_error_pin_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_class_template_repos(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_class_template_repos(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.retry_repository_creation(p_repository_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_repository_creation(p_repository_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_error_pin(p_error_pin jsonb, p_rules jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_error_pin(p_error_pin jsonb, p_rules jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_class_template_overrides(p_class_id bigint, p_handout text, p_solution text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_class_template_overrides(p_class_id bigint, p_handout text, p_solution text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_discussion_thread_topic(p_thread_id bigint, p_topic_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_discussion_thread_topic(p_thread_id bigint, p_topic_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_discussion_thread_visibility(p_thread_id bigint, p_instructors_only boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_discussion_thread_visibility(p_thread_id bigint, p_instructors_only boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.sis_sync_enrollment(p_class_id bigint, p_roster_data jsonb, p_sync_options jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sis_sync_enrollment(p_class_id bigint, p_roster_data jsonb, p_sync_options jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.soft_delete_survey(p_survey_id uuid, p_survey_logical_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.soft_delete_survey(p_survey_id uuid, p_survey_logical_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.submission_set_active(_submission_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submission_set_active(_submission_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.submit_ai_help_feedback(p_class_id integer, p_context_type text, p_resource_id integer, p_rating text, p_comment text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_ai_help_feedback(p_class_id integer, p_context_type text, p_resource_id integer, p_rating text, p_comment text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.toggle_discussion_thread_author_anonymity(p_thread_id bigint, p_make_anonymous boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.toggle_discussion_thread_author_anonymity(p_thread_id bigint, p_make_anonymous boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.trigger_discord_role_sync_for_user(p_class_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trigger_discord_role_sync_for_user(p_class_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.unregister_realtime_subscription(p_channel text, p_client_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unregister_realtime_subscription(p_channel text, p_client_id uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_class_late_tokens_per_student(p_class_id bigint, p_late_tokens_per_student integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_class_late_tokens_per_student(p_class_id bigint, p_late_tokens_per_student integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_gradebook_column_student_with_recalc(p_id bigint, p_updates jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_gradebook_column_student_with_recalc(p_id bigint, p_updates jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_regrade_request_points(regrade_request_id bigint, profile_id uuid, resolved_points numeric, closed_points numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_regrade_request_points(regrade_request_id bigint, profile_id uuid, resolved_points numeric, closed_points numeric) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_regrade_request_status(regrade_request_id bigint, new_status regrade_status, profile_id uuid, resolved_points numeric, closed_points numeric, p_submission_file_id bigint, p_line integer, p_submission_artifact_id bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_regrade_request_status(regrade_request_id bigint, new_status regrade_status, profile_id uuid, resolved_points numeric, closed_points numeric, p_submission_file_id bigint, p_line integer, p_submission_artifact_id bigint) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_rubric_full(p_rubric jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_rubric_full(p_rubric jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.user_is_in_help_request(p_help_request_id bigint, p_user_id uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_is_in_help_request(p_help_request_id bigint, p_user_id uuid) TO authenticated, service_role;

-- These security_invoker views call calculate_*_due_date, which no longer has anon EXECUTE, so an
-- anon read would fail on the function instead of returning no rows. Nothing reads them
-- signed out; take anon's table grants away so the view is denied up front instead.
REVOKE ALL ON public.assignments_with_effective_due_dates FROM anon;
REVOKE ALL ON public.submissions_with_grades_for_assignment_and_regression_test FROM anon;

-- ---------------------------------------------------------------------------------------------
-- 4. Guard fixes.
-- ---------------------------------------------------------------------------------------------

-- 4a. authorize_for_admin: a non-service caller may only ask about itself. Every caller that
--     passes an argument passes either auth.uid() or a caller-supplied p_*_by parameter
--     (admin_create_class, admin_update_class, admin_delete_class, admin_*_section,
--     admin_set_*_sync_enabled, admin_*set_user_role*_disabled, delete_system_notifications_by_campaign);
--     for the latter the caller-supplied id now has to be the caller.
CREATE OR REPLACE FUNCTION public.authorize_for_admin(p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    -- Allow service role (for edge functions)
    IF auth.role() = 'service_role' THEN
        RETURN true;
    END IF;
    
    -- Only the caller's own admin status is answerable. Accepting an arbitrary id let any
    -- caller satisfy the check with some admin's uuid.
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        RETURN false;
    END IF;

    -- Optimized admin check using SQL
    RETURN EXISTS (
        SELECT 1 
        FROM public.user_roles ur
        WHERE ur.user_id = p_user_id 
          AND ur.role = 'admin'
          AND ur.disabled = false
    );
END;
$function$;

-- 4b. Only platform admins (or service_role / migrations) can change who holds an admin role.
--     An enabled admin row in any class is global admin (authorize_for_admin,
--     authorize_for_submission), and instructors can otherwise insert, update and delete
--     user_roles and invitations rows in their own class with any role. So an end user who is
--     not an admin may not:
--       - create an admin row, transfer one to another user, or re-enable a disabled one;
--       - demote, disable, transfer or delete an enabled admin row (admin_create_class puts the
--         creating admin's row in every class, and removing it could revoke their admin);
--       - create an admin invitation, or retarget (sis_user_id, class_id) or reactivate (status
--         back to 'pending') one. Invitations are accepted later as service_role (user sign-in
--         sets users.sis_user_id; handle_user_sis_id_update copies i.role), where this trigger
--         cannot tell who set the invitation up, so the check has to happen here.
--     Service-role callers are trusted. Edge functions that write user_roles from request input
--     (enrollments-add) validate the role themselves.
CREATE OR REPLACE FUNCTION public.guard_admin_role_grant()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_changes_admin boolean;
BEGIN
  IF TG_TABLE_NAME = 'invitations' THEN
    v_changes_admin := CASE TG_OP
      WHEN 'INSERT' THEN NEW.role = 'admin'::public.app_role
      ELSE NEW.role = 'admin'::public.app_role AND (
             OLD.role IS DISTINCT FROM 'admin'::public.app_role
          OR OLD.sis_user_id IS DISTINCT FROM NEW.sis_user_id
          OR OLD.class_id IS DISTINCT FROM NEW.class_id
          OR (NEW.status = 'pending' AND OLD.status IS DISTINCT FROM 'pending'))
    END;
  ELSE
    v_changes_admin := CASE TG_OP
      WHEN 'INSERT' THEN NEW.role = 'admin'::public.app_role
      WHEN 'DELETE' THEN OLD.role = 'admin'::public.app_role AND NOT OLD.disabled
      ELSE
        -- Granting: becomes admin, moves to another user, or is re-enabled.
        (NEW.role = 'admin'::public.app_role AND (
             OLD.role IS DISTINCT FROM 'admin'::public.app_role
          OR OLD.user_id IS DISTINCT FROM NEW.user_id
          OR (OLD.disabled AND NOT NEW.disabled)))
        -- Revoking: an enabled admin row stops being one for the same user.
        OR (OLD.role = 'admin'::public.app_role AND NOT OLD.disabled AND (
             NEW.role IS DISTINCT FROM 'admin'::public.app_role
          OR NEW.disabled
          OR OLD.user_id IS DISTINCT FROM NEW.user_id))
    END;
  END IF;

  -- Only end-user API requests are restricted; migrations, seeds, cron and service-role
  -- callers carry no anon/authenticated role.
  IF NOT v_changes_admin
     OR coalesce(auth.role(), '') NOT IN ('anon', 'authenticated')
     OR public.authorize_for_admin() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  RAISE EXCEPTION 'Only platform admins can grant or remove the admin role'
    USING ERRCODE = 'insufficient_privilege';
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_admin_role_grant() FROM PUBLIC, anon, authenticated;

-- CREATE OR REPLACE rather than DROP + CREATE: DROP TRIGGER takes an ACCESS EXCLUSIVE lock, which
-- blocks every read of user_roles (most RLS checks) until commit. This takes SHARE ROW EXCLUSIVE,
-- which only blocks writes.
CREATE OR REPLACE TRIGGER guard_admin_role_grant
  BEFORE INSERT OR DELETE OR UPDATE OF role, user_id, disabled ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.guard_admin_role_grant();

-- No column list: an UPDATE OF trigger fires only for columns named in the statement's SET
-- list, and every column that matters here (role, sis_user_id, class_id, status) has to be
-- covered. The function only acts on rows whose new role is admin, so the WHEN clause keeps it
-- from being called for every other invitation write (SIS sync updates them in bulk).
CREATE OR REPLACE TRIGGER guard_admin_role_grant
  BEFORE INSERT OR UPDATE ON public.invitations
  FOR EACH ROW WHEN (NEW.role = 'admin'::public.app_role)
  EXECUTE FUNCTION public.guard_admin_role_grant();

-- 4c. update_gradebook_column_student_with_recalc had no caller check. Match the
--     gradebook_column_students UPDATE policy (instructors and graders of the row's class).
CREATE OR REPLACE FUNCTION public.update_gradebook_column_student_with_recalc(p_id bigint, p_updates jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  updated_row public.gradebook_column_students%ROWTYPE;
  old_row public.gradebook_column_students%ROWTYPE;
  recalc_input_changed boolean;
BEGIN
  -- Lock the row while reading the pre-update snapshot so concurrent edits
  -- serialize and old_row reflects the latest committed value (not a stale
  -- pre-concurrent-writer snapshot). See migration header for the race.
  SELECT * INTO old_row
  FROM public.gradebook_column_students
  WHERE id = p_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gradebook_column_students row with id % not found', p_id;
  END IF;

  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.authorizeforclassgrader(old_row.class_id) THEN
    RAISE EXCEPTION 'Access denied: instructor or grader role required'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.gradebook_column_students
  SET
    score = CASE WHEN p_updates ? 'score' THEN (p_updates->>'score')::numeric ELSE score END,
    score_override = CASE WHEN p_updates ? 'score_override' THEN (p_updates->>'score_override')::numeric ELSE score_override END,
    is_missing = CASE WHEN p_updates ? 'is_missing' THEN (p_updates->>'is_missing')::boolean ELSE is_missing END,
    is_excused = CASE WHEN p_updates ? 'is_excused' THEN (p_updates->>'is_excused')::boolean ELSE is_excused END,
    is_droppable = CASE WHEN p_updates ? 'is_droppable' THEN (p_updates->>'is_droppable')::boolean ELSE is_droppable END,
    released = CASE WHEN p_updates ? 'released' THEN (p_updates->>'released')::boolean ELSE released END,
    score_override_note = CASE WHEN p_updates ? 'score_override_note' THEN (p_updates->>'score_override_note')::text ELSE score_override_note END,
    incomplete_values = CASE WHEN p_updates ? 'incomplete_values' THEN p_updates->'incomplete_values' ELSE incomplete_values END
  WHERE id = p_id
  RETURNING * INTO updated_row;

  recalc_input_changed := (
    updated_row.score IS DISTINCT FROM old_row.score OR
    updated_row.score_override IS DISTINCT FROM old_row.score_override OR
    updated_row.is_missing IS DISTINCT FROM old_row.is_missing OR
    updated_row.is_droppable IS DISTINCT FROM old_row.is_droppable OR
    updated_row.is_excused IS DISTINCT FROM old_row.is_excused
  );

  IF recalc_input_changed THEN
    PERFORM public.enqueue_gradebook_row_recalculation_batch(ARRAY[
      jsonb_build_object(
        'class_id', updated_row.class_id,
        'gradebook_id', updated_row.gradebook_id,
        'student_id', updated_row.student_id,
        'is_private', updated_row.is_private
      )
    ]);
  END IF;
END;
$function$;

-- 4d. Releasing an instructor-only column is an instructor action (gradebook_columns writes are
--     instructor-only under RLS); graders could release staff-only grades to students.
CREATE OR REPLACE FUNCTION public.release_instructor_only_gradebook_column(p_column_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_class_id bigint;
BEGIN
  SELECT class_id INTO v_class_id
  FROM public.gradebook_columns
  WHERE id = p_column_id;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'Column % does not exist', p_column_id;
  END IF;

  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Access denied: insufficient permissions for class %', v_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Step 1: Release while still instructor_only — triggers snapshot sync
  UPDATE public.gradebook_columns
  SET released = true
  WHERE id = p_column_id AND instructor_only = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Column % is not an instructor-only column', p_column_id;
  END IF;

  -- Step 2: Clear instructor_only — column now behaves normally; triggers recalc
  UPDATE public.gradebook_columns
  SET instructor_only = false
  WHERE id = p_column_id;
END;
$function$;

-- 4e. soft_delete_survey authorized against one class, then deleted every survey and response
--     sharing the logical survey_id in any class. surveys.survey_id is instructor-writable, so
--     an instructor could adopt another class's logical id and delete that class's surveys.
CREATE OR REPLACE FUNCTION public.soft_delete_survey(p_survey_id uuid, p_survey_logical_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_class_id BIGINT;
BEGIN
  SET LOCAL search_path = pg_catalog, public;

  -- Verify survey exists and capture class for authorization
  SELECT class_id
  INTO v_class_id
  FROM public.surveys
  WHERE id = p_survey_id
    AND survey_id = p_survey_logical_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Survey not found';
  END IF;

  IF NOT authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Permission denied: instructor access required';
  END IF;

  -- Soft delete responses tied to any version of this survey
  UPDATE public.survey_responses
  SET deleted_at = NOW()
  WHERE survey_id IN (
    SELECT id FROM public.surveys WHERE survey_id = p_survey_logical_id AND class_id = v_class_id
  )
    AND deleted_at IS NULL;

  -- Soft delete all survey versions sharing the logical id
  UPDATE public.surveys
  SET deleted_at = NOW()
  WHERE survey_id = p_survey_logical_id
    AND class_id = v_class_id
    AND deleted_at IS NULL;
END;
$function$;

-- 4f. update_rubric_full checked the caller instructs p_rubric.class_id but never that the
--     rubric's assignment is in that class, so a rubric (and, for code-walk rubrics, gradebook
--     columns and submission reviews via triggers) could be created against another class.
--     It also accepted any referenced_rubric_check_id, linking this class's rubric to checks
--     in other classes.
CREATE OR REPLACE FUNCTION public.update_rubric_full(p_rubric jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '3min'
AS $function$
DECLARE
  v_rubric_id bigint;
  v_class_id bigint;
  v_assignment_id bigint;
  v_review_round review_round;

  v_is_new_rubric boolean := false;
  v_broad_change boolean := false;

  v_old_name text;
  v_old_description text;
  v_old_is_private boolean;
  v_old_cap boolean;
  v_old_hide_unless_assigned boolean;
  v_old_assignment_id bigint;

  v_new_name text;
  v_new_description text;
  v_new_is_private boolean;
  v_new_cap boolean;
  v_new_hide_unless_assigned boolean;

  v_parts_added int := 0;
  v_parts_updated int := 0;
  v_parts_removed int := 0;
  v_criteria_added int := 0;
  v_criteria_updated int := 0;
  v_criteria_removed int := 0;
  v_checks_added int := 0;
  v_checks_updated int := 0;
  v_checks_removed int := 0;
  v_checks_points_cascaded int := 0;
  v_refs_added int := 0;
  v_refs_removed int := 0;
  v_reviews_recomputed int := 0;
  v_foreign_ids_remapped int := 0;
  v_ref_ids bigint[];

  -- Input map key -> real DB id, after insert/update phases.
  v_part_id_map jsonb := '{}'::jsonb;
  v_criteria_id_map jsonb := '{}'::jsonb;
  v_check_id_map jsonb := '{}'::jsonb;

  v_part jsonb;
  v_criterion jsonb;
  v_check jsonb;
  v_ref jsonb;

  v_input_part_id bigint;
  v_input_criteria_id bigint;
  v_input_check_id bigint;
  v_part_id bigint;
  v_criteria_id bigint;
  v_check_id bigint;
  v_review_id bigint;

  v_part_ord int;
  v_crit_ord int;
  v_check_ord int;
  v_part_map_key text;
  v_criteria_map_key text;
  v_check_map_key text;

  v_points_changed_check_ids bigint[] := ARRAY[]::bigint[];
  v_removed_check_ids bigint[] := ARRAY[]::bigint[];
  v_affected_review_ids bigint[] := ARRAY[]::bigint[];

  v_old_is_individual_grading boolean;
  v_old_is_assign_to_student boolean;
  v_old_rubric_part_id bigint;
  v_old_total_points int;
  v_old_is_additive boolean;
  v_old_is_deduction_only boolean;
  v_old_points numeric;
  v_old_criteria_id bigint;

  v_bad_name text;
  v_bad_parent_name text;
  v_bad_points numeric;

  v_changes text[] := ARRAY[]::text[];
  v_summary text;
BEGIN
  v_rubric_id := NULLIF((p_rubric->>'id')::bigint, 0);
  v_class_id := (p_rubric->>'class_id')::bigint;
  v_assignment_id := (p_rubric->>'assignment_id')::bigint;
  v_review_round := (p_rubric->>'review_round')::review_round;
  v_new_name := p_rubric->>'name';
  v_new_description := p_rubric->>'description';
  v_new_is_private := COALESCE((p_rubric->>'is_private')::boolean, false);
  v_new_cap := COALESCE((p_rubric->>'cap_score_to_assignment_points')::boolean, false);
  -- NULL when the key is absent: only overwrite hide_unless_assigned on update
  -- when the caller actually sent it.
  v_new_hide_unless_assigned := CASE
    WHEN p_rubric ? 'hide_unless_assigned'
    THEN (p_rubric->>'hide_unless_assigned')::boolean
  END;

  IF v_class_id IS NULL THEN
    RAISE EXCEPTION 'class_id is required';
  END IF;
  IF NOT public.authorizeforclassinstructor(v_class_id) THEN
    RAISE EXCEPTION 'Not authorized to edit rubrics in this class';
  END IF;
  IF v_assignment_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.assignments a WHERE a.id = v_assignment_id AND a.class_id = v_class_id
  ) THEN
    RAISE EXCEPTION 'Assignment % does not belong to class %', v_assignment_id, v_class_id;
  END IF;
  IF v_new_name IS NULL OR length(trim(v_new_name)) = 0 THEN
    RAISE EXCEPTION 'Rubric name is required';
  END IF;
  -- rubric_check_references rows are inserted without RLS, so a reference may only name a
  -- rubric check in this class. The ids are collected first and matched with id = ANY(...): a
  -- join against the nested jsonb_array_elements is estimated at 100^4 rows and planned as a
  -- sequential scan of rubric_checks.
  SELECT array_agg(DISTINCT (ref->>'referenced_rubric_check_id')::bigint)
  INTO v_ref_ids
  FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
       jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
       jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk,
       jsonb_array_elements(COALESCE(chk->'references', '[]'::jsonb)) ref
  WHERE ref->>'referenced_rubric_check_id' IS NOT NULL;

  IF v_ref_ids IS NOT NULL AND cardinality(v_ref_ids) <> (
    SELECT count(*) FROM public.rubric_checks rc
    WHERE rc.id = ANY (v_ref_ids) AND rc.class_id = v_class_id
  ) THEN
    RAISE EXCEPTION 'Referenced rubric check does not belong to class %', v_class_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  ----------------------------------------------------------------
  -- Reject negative points before touching anything.
  --
  -- Deductions are stored POSITIVE and subtracted by
  -- _submission_review_recompute_scores, which reads sum(comments.points) as a
  -- magnitude in all three scoring modes:
  --   is_deduction_only -> greatest(-sum, -total_points)
  --   is_additive       -> least(sum, total_points)
  --   otherwise         -> greatest(total_points - sum, 0)
  -- so a negative value inverts the sign the mode intends: it credits points on a
  -- deduction-only criterion, subtracts them on an additive one, and pushes a
  -- deduct-from-total criterion above its own total.
  --
  -- Raised here rather than left to chk_rubric_checks_points_non_negative /
  -- chk_rubric_criteria_total_points_non_negative so the editor shows the offending
  -- criterion and check by name instead of a bare 23514 constraint violation. Runs
  -- before Phase 0, so a rejected payload cannot have already deleted rows.
  ----------------------------------------------------------------
  SELECT crit->>'name', part->>'name', (crit->>'total_points')::numeric
  INTO v_bad_name, v_bad_parent_name, v_bad_points
  FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
       jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit
  WHERE COALESCE((crit->>'total_points')::numeric, 0) < 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Criterion "%" in part "%" has negative total_points (%). Total points must be zero or greater; for deductions set the criterion scoring mode to deduct-from-total or deduction-only instead of using negative points.',
      COALESCE(v_bad_name, '(unnamed)'), COALESCE(v_bad_parent_name, '(unnamed)'), v_bad_points
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT chk->>'name', crit->>'name', (chk->>'points')::numeric
  INTO v_bad_name, v_bad_parent_name, v_bad_points
  FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
       jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
       jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk
  WHERE COALESCE((chk->>'points')::numeric, 0) < 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Check "%" in criterion "%" has negative points (%). Points must be zero or greater; for deductions set the criterion scoring mode to deduct-from-total or deduction-only instead of using negative points.',
      COALESCE(v_bad_name, '(unnamed)'), COALESCE(v_bad_parent_name, '(unnamed)'), v_bad_points
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  ----------------------------------------------------------------
  -- Option points, inside rubric_checks.data.
  --
  -- The two guards above cover the columns, and the CHECK constraints back them. Neither reaches
  -- an option's points: that value lives in jsonb, which is why the header records it as not
  -- constrainable from a column CHECK. Without this guard the only thing standing between a
  -- negative option and the database was sanitizeCheckPoints in lib/rubric/pointsSanitize.ts,
  -- which runs in the browser -- so the CLI, the YAML import path (rubric_checks.data rides the
  -- round-trip opaquely), and any direct RPC caller could still persist one. An option's points
  -- become a comment's points when a grader selects it, so a negative there inverts the scoring
  -- mode's intended sign exactly as a negative check points does.
  --
  -- Raised by name here rather than left to a constraint, matching the two guards above.
  ----------------------------------------------------------------
  SELECT opt->>'label', chk->>'name', (opt->>'points')::numeric
  INTO v_bad_name, v_bad_parent_name, v_bad_points
  FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
       jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
       jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk,
       jsonb_array_elements(
         CASE WHEN jsonb_typeof(chk->'data'->'options') = 'array'
              THEN chk->'data'->'options'
              ELSE '[]'::jsonb
         END
       ) opt
  WHERE COALESCE((opt->>'points')::numeric, 0) < 0
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Option "%" in check "%" has negative points (%). Points must be zero or greater; for deductions set the criterion scoring mode to deduct-from-total or deduction-only instead of using negative points.',
      COALESCE(v_bad_name, '(unnamed)'), COALESCE(v_bad_parent_name, '(unnamed)'), v_bad_points
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF v_rubric_id IS NULL THEN
    INSERT INTO public.rubrics (
      name, description, assignment_id, class_id, is_private, review_round,
      cap_score_to_assignment_points, hide_unless_assigned
    )
    VALUES (
      v_new_name, v_new_description, v_assignment_id, v_class_id, v_new_is_private,
      v_review_round, v_new_cap, COALESCE(v_new_hide_unless_assigned, false)
    )
    RETURNING id INTO v_rubric_id;
    v_is_new_rubric := true;
    v_broad_change := true;
  ELSE
    SELECT name, description, is_private, cap_score_to_assignment_points, hide_unless_assigned,
           assignment_id
    INTO v_old_name, v_old_description, v_old_is_private, v_old_cap, v_old_hide_unless_assigned,
         v_old_assignment_id
    FROM public.rubrics
    WHERE id = v_rubric_id AND class_id = v_class_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rubric % not found in class %', v_rubric_id, v_class_id;
    END IF;

    -- The class is pinned above, but assignment_id was not checked against the rubric,
    -- and the part/criteria/check inserts below write v_assignment_id straight into the
    -- child rows. A payload naming a rubric on assignment A while carrying assignment
    -- B's id therefore produced children whose assignment_id disagreed with their
    -- rubric's, and the export path filters rubric_check_references by assignment_id,
    -- so those rows read back inconsistently.
    IF v_assignment_id IS DISTINCT FROM v_old_assignment_id THEN
      RAISE EXCEPTION 'assignment_id % does not match rubric %''s assignment %',
        v_assignment_id, v_rubric_id, v_old_assignment_id;
    END IF;

    IF v_old_name IS DISTINCT FROM v_new_name
       OR v_old_description IS DISTINCT FROM v_new_description
       OR v_old_is_private IS DISTINCT FROM v_new_is_private
       OR v_old_cap IS DISTINCT FROM v_new_cap
       OR (v_new_hide_unless_assigned IS NOT NULL AND v_old_hide_unless_assigned IS DISTINCT FROM v_new_hide_unless_assigned) THEN
      UPDATE public.rubrics
      SET name = v_new_name,
          description = v_new_description,
          is_private = v_new_is_private,
          cap_score_to_assignment_points = v_new_cap,
          hide_unless_assigned = COALESCE(v_new_hide_unless_assigned, hide_unless_assigned)
      WHERE id = v_rubric_id;
    END IF;

    IF v_old_cap IS DISTINCT FROM v_new_cap THEN
      v_broad_change := true;
    END IF;
  END IF;

  ----------------------------------------------------------------
  -- Phase 0: deletes (leaf → root). FKs on rubric_criteria→parts and
  -- rubric_checks→criteria are NO ACTION, so we must remove checks before
  -- criteria before parts. rubric_check_references CASCADE when checks go.
  ----------------------------------------------------------------
  WITH input_check_ids AS (
    SELECT (chk->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
         jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit,
         jsonb_array_elements(COALESCE(crit->'checks', '[]'::jsonb)) chk
    WHERE COALESCE((chk->>'id')::bigint, 0) > 0
      AND EXISTS (
        SELECT 1 FROM public.rubric_checks rc
        WHERE rc.id = (chk->>'id')::bigint AND rc.rubric_id = v_rubric_id
      )
  )
  SELECT COALESCE(array_agg(id), ARRAY[]::bigint[]) INTO v_removed_check_ids
  FROM public.rubric_checks
  WHERE rubric_id = v_rubric_id
    AND id NOT IN (SELECT id FROM input_check_ids);

  IF array_length(v_removed_check_ids, 1) > 0 THEN
    DELETE FROM public.rubric_checks WHERE id = ANY(v_removed_check_ids);
    v_checks_removed := array_length(v_removed_check_ids, 1);
    v_broad_change := true;
  END IF;

  WITH input_criteria_ids AS (
    SELECT (crit->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) part,
         jsonb_array_elements(COALESCE(part->'criteria', '[]'::jsonb)) crit
    WHERE COALESCE((crit->>'id')::bigint, 0) > 0
      AND EXISTS (
        SELECT 1 FROM public.rubric_criteria rc
        WHERE rc.id = (crit->>'id')::bigint AND rc.rubric_id = v_rubric_id
      )
  ),
  del AS (
    DELETE FROM public.rubric_criteria
    WHERE rubric_id = v_rubric_id
      AND id NOT IN (SELECT id FROM input_criteria_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_criteria_removed FROM del;

  IF v_criteria_removed > 0 THEN
    v_broad_change := true;
  END IF;

  WITH input_part_ids AS (
    SELECT (elem->>'id')::bigint AS id
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) elem
    WHERE COALESCE((elem->>'id')::bigint, 0) > 0
      AND EXISTS (
        SELECT 1 FROM public.rubric_parts rp
        WHERE rp.id = (elem->>'id')::bigint AND rp.rubric_id = v_rubric_id
      )
  ),
  del AS (
    DELETE FROM public.rubric_parts
    WHERE rubric_id = v_rubric_id
      AND id NOT IN (SELECT id FROM input_part_ids)
    RETURNING id
  )
  SELECT count(*) INTO v_parts_removed FROM del;

  IF v_parts_removed > 0 THEN
    v_broad_change := true;
  END IF;

  ----------------------------------------------------------------
  -- Phase 1: upsert parts.
  ----------------------------------------------------------------
  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);

    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;

      -- _submission_review_recompute_scores joins rubric_criteria to rubric_parts and
      -- branches on these two flags to decide whether a criterion's points land in the
      -- shared total, one student's individual total, or a per-student assigned total.
      -- Flipping either therefore reclassifies every criterion under the part, so the
      -- existing reviews have to be recomputed -- and this branch never said so, leaving
      -- individual_scores and per_student_grading_totals computed under the old mode
      -- while the gradebook displayed them as current.
      SELECT is_individual_grading, is_assign_to_student
      INTO v_old_is_individual_grading, v_old_is_assign_to_student
      FROM public.rubric_parts WHERE id = v_input_part_id;

      IF v_old_is_individual_grading IS DISTINCT FROM COALESCE((v_part->>'is_individual_grading')::boolean, false)
         OR v_old_is_assign_to_student IS DISTINCT FROM COALESCE((v_part->>'is_assign_to_student')::boolean, false) THEN
        v_broad_change := true;
      END IF;

      UPDATE public.rubric_parts
      SET name = v_part->>'name',
          description = v_part->>'description',
          ordinal = COALESCE((v_part->>'ordinal')::int, 0),
          data = v_part->'data',
          is_individual_grading = COALESCE((v_part->>'is_individual_grading')::boolean, false),
          is_assign_to_student = COALESCE((v_part->>'is_assign_to_student')::boolean, false)
      WHERE id = v_input_part_id AND rubric_id = v_rubric_id;

      v_part_id := v_input_part_id;
      v_parts_updated := v_parts_updated + 1;
    ELSE
      IF v_input_part_id > 0 THEN
        v_foreign_ids_remapped := v_foreign_ids_remapped + 1;
      END IF;
      v_part_map_key := 'new_part_' || v_part_ord::text;

      INSERT INTO public.rubric_parts (
        name, description, ordinal, rubric_id, class_id, assignment_id,
        data, is_individual_grading, is_assign_to_student
      ) VALUES (
        v_part->>'name',
        v_part->>'description',
        COALESCE((v_part->>'ordinal')::int, 0),
        v_rubric_id, v_class_id, v_assignment_id,
        v_part->'data',
        COALESCE((v_part->>'is_individual_grading')::boolean, false),
        COALESCE((v_part->>'is_assign_to_student')::boolean, false)
      ) RETURNING id INTO v_part_id;

      v_parts_added := v_parts_added + 1;
      v_broad_change := true;
    END IF;

    v_part_id_map := v_part_id_map || jsonb_build_object(v_part_map_key, v_part_id);
  END LOOP;

  ----------------------------------------------------------------
  -- Phase 2: upsert criteria.
  ----------------------------------------------------------------
  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;
    ELSE
      v_part_map_key := 'new_part_' || v_part_ord::text;
    END IF;
    v_part_id := (v_part_id_map->>v_part_map_key)::bigint;

    FOR v_criterion, v_crit_ord IN
      SELECT elem, ord::int
      FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);

      IF v_input_criteria_id > 0
         AND EXISTS (
           SELECT 1 FROM public.rubric_criteria
           WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id
         ) THEN
        v_criteria_map_key := v_input_criteria_id::text;

        -- rubric_part_id is in the snapshot because the UPDATE below rewrites it: YAML
        -- can keep a criterion's id while moving it under a different part. If the new
        -- parent has a different grading mode, recompute_scores classifies the
        -- criterion's points differently through its rubric_parts join, so the move is
        -- as broad a change as editing the part's own flags.
        SELECT total_points, is_additive, is_deduction_only, rubric_part_id
        INTO v_old_total_points, v_old_is_additive, v_old_is_deduction_only, v_old_rubric_part_id
        FROM public.rubric_criteria WHERE id = v_input_criteria_id;

        IF v_old_total_points IS DISTINCT FROM COALESCE((v_criterion->>'total_points')::int, 0)
           OR v_old_is_additive IS DISTINCT FROM COALESCE((v_criterion->>'is_additive')::boolean, false)
           OR v_old_is_deduction_only IS DISTINCT FROM COALESCE((v_criterion->>'is_deduction_only')::boolean, false)
           OR v_old_rubric_part_id IS DISTINCT FROM v_part_id THEN
          v_broad_change := true;
        END IF;

        UPDATE public.rubric_criteria
        SET name = v_criterion->>'name',
            description = v_criterion->>'description',
            ordinal = COALESCE((v_criterion->>'ordinal')::int, 0),
            rubric_part_id = v_part_id,
            data = v_criterion->'data',
            is_additive = COALESCE((v_criterion->>'is_additive')::boolean, false),
            is_deduction_only = COALESCE((v_criterion->>'is_deduction_only')::boolean, false),
            total_points = COALESCE((v_criterion->>'total_points')::int, 0),
            max_checks_per_submission = NULLIF(v_criterion->>'max_checks_per_submission', '')::int,
            min_checks_per_submission = NULLIF(v_criterion->>'min_checks_per_submission', '')::int
        WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id;

        v_criteria_id := v_input_criteria_id;
        v_criteria_updated := v_criteria_updated + 1;
      ELSE
        IF v_input_criteria_id > 0 THEN
          v_foreign_ids_remapped := v_foreign_ids_remapped + 1;
        END IF;
        v_criteria_map_key := 'new_crit_' || v_part_ord::text || '_' || v_crit_ord::text;

        INSERT INTO public.rubric_criteria (
          name, description, ordinal, rubric_id, rubric_part_id, class_id, assignment_id,
          data, is_additive, is_deduction_only, total_points,
          max_checks_per_submission, min_checks_per_submission
        ) VALUES (
          v_criterion->>'name',
          v_criterion->>'description',
          COALESCE((v_criterion->>'ordinal')::int, 0),
          v_rubric_id, v_part_id, v_class_id, v_assignment_id,
          v_criterion->'data',
          COALESCE((v_criterion->>'is_additive')::boolean, false),
          COALESCE((v_criterion->>'is_deduction_only')::boolean, false),
          COALESCE((v_criterion->>'total_points')::int, 0),
          NULLIF(v_criterion->>'max_checks_per_submission', '')::int,
          NULLIF(v_criterion->>'min_checks_per_submission', '')::int
        ) RETURNING id INTO v_criteria_id;

        v_criteria_added := v_criteria_added + 1;
        v_broad_change := true;
      END IF;

      v_criteria_id_map := v_criteria_id_map || jsonb_build_object(v_criteria_map_key, v_criteria_id);
    END LOOP;
  END LOOP;

  ----------------------------------------------------------------
  -- Phase 3: upsert checks.
  ----------------------------------------------------------------
  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;
    ELSE
      v_part_map_key := 'new_part_' || v_part_ord::text;
    END IF;

    FOR v_criterion, v_crit_ord IN
      SELECT elem, ord::int
      FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);
      IF v_input_criteria_id > 0
         AND EXISTS (
           SELECT 1 FROM public.rubric_criteria
           WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id
         ) THEN
        v_criteria_map_key := v_input_criteria_id::text;
      ELSE
        v_criteria_map_key := 'new_crit_' || v_part_ord::text || '_' || v_crit_ord::text;
      END IF;
      v_criteria_id := (v_criteria_id_map->>v_criteria_map_key)::bigint;

      FOR v_check, v_check_ord IN
        SELECT elem, ord::int
        FROM jsonb_array_elements(COALESCE(v_criterion->'checks', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      LOOP
        v_input_check_id := COALESCE((v_check->>'id')::bigint, 0);

        IF v_input_check_id > 0
           AND EXISTS (
             SELECT 1 FROM public.rubric_checks
             WHERE id = v_input_check_id AND rubric_id = v_rubric_id
           ) THEN
          v_check_map_key := v_input_check_id::text;

          SELECT points, rubric_criteria_id INTO v_old_points, v_old_criteria_id
          FROM public.rubric_checks WHERE id = v_input_check_id;

          IF v_old_points IS DISTINCT FROM COALESCE((v_check->>'points')::numeric, 0) THEN
            v_points_changed_check_ids := array_append(v_points_changed_check_ids, v_input_check_id);
          END IF;

          -- Reparenting a check is a scoring change even when its points do not move.
          -- _submission_review_recompute_scores joins rubric_checks to rubric_criteria on
          -- rubric_criteria_id and groups by the criterion, applying *that* criterion's
          -- is_additive / is_deduction_only / total_points. So a check moved under a
          -- different criterion is scored by different rules, and recording only point
          -- changes left every affected submission_reviews.total_score computed against
          -- the old parent until some unrelated edit happened to trigger a recompute.
          IF v_old_criteria_id IS DISTINCT FROM v_criteria_id THEN
            v_broad_change := true;
          END IF;

          UPDATE public.rubric_checks
          SET name = v_check->>'name',
              description = v_check->>'description',
              ordinal = COALESCE((v_check->>'ordinal')::int, 0),
              rubric_criteria_id = v_criteria_id,
              data = v_check->'data',
              file = v_check->>'file',
              artifact = v_check->>'artifact',
              "group" = v_check->>'group',
              is_annotation = COALESCE((v_check->>'is_annotation')::boolean, false),
              is_comment_required = COALESCE((v_check->>'is_comment_required')::boolean, false),
              is_required = COALESCE((v_check->>'is_required')::boolean, false),
              max_annotations = NULLIF(v_check->>'max_annotations', '')::int,
              points = COALESCE((v_check->>'points')::numeric, 0),
              annotation_target = v_check->>'annotation_target',
              student_visibility = COALESCE(
                (v_check->>'student_visibility')::rubric_check_student_visibility,
                'always'::rubric_check_student_visibility
              ),
              kpi_category = NULLIF(v_check->>'kpi_category', '')::repo_analytics_kpi_category
          WHERE id = v_input_check_id AND rubric_id = v_rubric_id;

          v_check_id := v_input_check_id;
          v_checks_updated := v_checks_updated + 1;
        ELSE
          IF v_input_check_id > 0 THEN
            v_foreign_ids_remapped := v_foreign_ids_remapped + 1;
          END IF;
          v_check_map_key := 'new_check_' || v_part_ord::text || '_' || v_crit_ord::text || '_' || v_check_ord::text;

          INSERT INTO public.rubric_checks (
            name, description, ordinal, rubric_criteria_id, rubric_id, class_id, assignment_id,
            data, file, artifact, "group",
            is_annotation, is_comment_required, is_required,
            max_annotations, points, annotation_target, student_visibility, kpi_category
          ) VALUES (
            v_check->>'name',
            v_check->>'description',
            COALESCE((v_check->>'ordinal')::int, 0),
            v_criteria_id, v_rubric_id, v_class_id, v_assignment_id,
            v_check->'data',
            v_check->>'file',
            v_check->>'artifact',
            v_check->>'group',
            COALESCE((v_check->>'is_annotation')::boolean, false),
            COALESCE((v_check->>'is_comment_required')::boolean, false),
            COALESCE((v_check->>'is_required')::boolean, false),
            NULLIF(v_check->>'max_annotations', '')::int,
            COALESCE((v_check->>'points')::numeric, 0),
            v_check->>'annotation_target',
            COALESCE((v_check->>'student_visibility')::rubric_check_student_visibility, 'always'::rubric_check_student_visibility),
            NULLIF(v_check->>'kpi_category', '')::repo_analytics_kpi_category
          ) RETURNING id INTO v_check_id;

          v_checks_added := v_checks_added + 1;
          v_broad_change := true;
        END IF;

        v_check_id_map := v_check_id_map || jsonb_build_object(v_check_map_key, v_check_id);
      END LOOP;
    END LOOP;
  END LOOP;

  IF array_length(v_points_changed_check_ids, 1) > 0 THEN
    UPDATE public.submission_comments sc
    SET points = rc.points
    FROM public.rubric_checks rc
    WHERE sc.rubric_check_id = rc.id
      AND rc.id = ANY(v_points_changed_check_ids);

    UPDATE public.submission_file_comments sfc
    SET points = rc.points
    FROM public.rubric_checks rc
    WHERE sfc.rubric_check_id = rc.id
      AND rc.id = ANY(v_points_changed_check_ids);

    UPDATE public.submission_artifact_comments sac
    SET points = rc.points
    FROM public.rubric_checks rc
    WHERE sac.rubric_check_id = rc.id
      AND rc.id = ANY(v_points_changed_check_ids);

    v_checks_points_cascaded := array_length(v_points_changed_check_ids, 1);
  END IF;

  ----------------------------------------------------------------
  -- Phase 4: rubric_check_references.
  ----------------------------------------------------------------
  CREATE TEMP TABLE IF NOT EXISTS _desired_refs (
    referencing_check_id bigint NOT NULL,
    referenced_check_id bigint NOT NULL
  ) ON COMMIT DROP;
  TRUNCATE _desired_refs;

  FOR v_part, v_part_ord IN
    SELECT elem, ord::int
    FROM jsonb_array_elements(COALESCE(p_rubric->'parts', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
  LOOP
    v_input_part_id := COALESCE((v_part->>'id')::bigint, 0);
    IF v_input_part_id > 0
       AND EXISTS (
         SELECT 1 FROM public.rubric_parts
         WHERE id = v_input_part_id AND rubric_id = v_rubric_id
       ) THEN
      v_part_map_key := v_input_part_id::text;
    ELSE
      v_part_map_key := 'new_part_' || v_part_ord::text;
    END IF;

    FOR v_criterion, v_crit_ord IN
      SELECT elem, ord::int
      FROM jsonb_array_elements(COALESCE(v_part->'criteria', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
    LOOP
      v_input_criteria_id := COALESCE((v_criterion->>'id')::bigint, 0);
      IF v_input_criteria_id > 0
         AND EXISTS (
           SELECT 1 FROM public.rubric_criteria
           WHERE id = v_input_criteria_id AND rubric_id = v_rubric_id
         ) THEN
        v_criteria_map_key := v_input_criteria_id::text;
      ELSE
        v_criteria_map_key := 'new_crit_' || v_part_ord::text || '_' || v_crit_ord::text;
      END IF;

      FOR v_check, v_check_ord IN
        SELECT elem, ord::int
        FROM jsonb_array_elements(COALESCE(v_criterion->'checks', '[]'::jsonb)) WITH ORDINALITY AS t(elem, ord)
      LOOP
        v_input_check_id := COALESCE((v_check->>'id')::bigint, 0);
        IF v_input_check_id > 0
           AND EXISTS (
             SELECT 1 FROM public.rubric_checks
             WHERE id = v_input_check_id AND rubric_id = v_rubric_id
           ) THEN
          v_check_map_key := v_input_check_id::text;
        ELSE
          v_check_map_key := 'new_check_' || v_part_ord::text || '_' || v_crit_ord::text || '_' || v_check_ord::text;
        END IF;
        v_check_id := (v_check_id_map->>v_check_map_key)::bigint;

        FOR v_ref IN SELECT * FROM jsonb_array_elements(COALESCE(v_check->'references', '[]'::jsonb))
        LOOP
          INSERT INTO _desired_refs (referencing_check_id, referenced_check_id)
          VALUES (v_check_id, (v_ref->>'referenced_rubric_check_id')::bigint);
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;

  WITH del AS (
    DELETE FROM public.rubric_check_references rcr
    WHERE rcr.rubric_id = v_rubric_id
      AND NOT EXISTS (
        SELECT 1 FROM _desired_refs d
        WHERE d.referencing_check_id = rcr.referencing_rubric_check_id
          AND d.referenced_check_id = rcr.referenced_rubric_check_id
      )
    RETURNING id
  )
  SELECT count(*) INTO v_refs_removed FROM del;

  WITH ins AS (
    INSERT INTO public.rubric_check_references (
      referencing_rubric_check_id, referenced_rubric_check_id,
      rubric_id, class_id, assignment_id
    )
    SELECT d.referencing_check_id, d.referenced_check_id,
           v_rubric_id, v_class_id, v_assignment_id
    FROM _desired_refs d
    WHERE NOT EXISTS (
      SELECT 1 FROM public.rubric_check_references rcr
      WHERE rcr.referencing_rubric_check_id = d.referencing_check_id
        AND rcr.referenced_rubric_check_id = d.referenced_check_id
        AND rcr.rubric_id = v_rubric_id
    )
    RETURNING id
  )
  SELECT count(*) INTO v_refs_added FROM ins;

  IF v_is_new_rubric THEN
    v_affected_review_ids := ARRAY[]::bigint[];
  ELSIF v_broad_change THEN
    SELECT COALESCE(array_agg(DISTINCT sr.id), ARRAY[]::bigint[])
    INTO v_affected_review_ids
    FROM public.submission_reviews sr
    WHERE sr.rubric_id = v_rubric_id;
  ELSE
    WITH touched_check_ids AS (
      SELECT unnest(v_points_changed_check_ids || v_removed_check_ids) AS id
    ),
    touched AS (
      SELECT submission_review_id FROM public.submission_comments
      WHERE rubric_check_id IN (SELECT id FROM touched_check_ids)
        AND deleted_at IS NULL AND submission_review_id IS NOT NULL
      UNION
      SELECT submission_review_id FROM public.submission_file_comments
      WHERE rubric_check_id IN (SELECT id FROM touched_check_ids)
        AND deleted_at IS NULL AND submission_review_id IS NOT NULL
      UNION
      SELECT submission_review_id FROM public.submission_artifact_comments
      WHERE rubric_check_id IN (SELECT id FROM touched_check_ids)
        AND deleted_at IS NULL AND submission_review_id IS NOT NULL
    )
    SELECT COALESCE(array_agg(DISTINCT submission_review_id), ARRAY[]::bigint[])
    INTO v_affected_review_ids
    FROM touched;
  END IF;

  FOREACH v_review_id IN ARRAY v_affected_review_ids LOOP
    PERFORM public._submission_review_recompute_scores(v_review_id);
    v_reviews_recomputed := v_reviews_recomputed + 1;
  END LOOP;

  v_summary := CASE WHEN v_is_new_rubric THEN 'Created rubric.' ELSE 'Saved rubric.' END;

  IF v_parts_added > 0 THEN v_changes := v_changes || (v_parts_added || ' part' || CASE WHEN v_parts_added = 1 THEN '' ELSE 's' END || ' added'); END IF;
  IF v_parts_updated > 0 THEN v_changes := v_changes || (v_parts_updated || ' part' || CASE WHEN v_parts_updated = 1 THEN '' ELSE 's' END || ' updated'); END IF;
  IF v_parts_removed > 0 THEN v_changes := v_changes || (v_parts_removed || ' part' || CASE WHEN v_parts_removed = 1 THEN '' ELSE 's' END || ' removed'); END IF;
  IF v_criteria_added > 0 THEN v_changes := v_changes || (v_criteria_added || ' criteri' || CASE WHEN v_criteria_added = 1 THEN 'on' ELSE 'a' END || ' added'); END IF;
  IF v_criteria_updated > 0 THEN v_changes := v_changes || (v_criteria_updated || ' criteri' || CASE WHEN v_criteria_updated = 1 THEN 'on' ELSE 'a' END || ' updated'); END IF;
  IF v_criteria_removed > 0 THEN v_changes := v_changes || (v_criteria_removed || ' criteri' || CASE WHEN v_criteria_removed = 1 THEN 'on' ELSE 'a' END || ' removed'); END IF;
  IF v_checks_added > 0 THEN v_changes := v_changes || (v_checks_added || ' check' || CASE WHEN v_checks_added = 1 THEN '' ELSE 's' END || ' added'); END IF;
  IF v_checks_updated > 0 THEN v_changes := v_changes || (v_checks_updated || ' check' || CASE WHEN v_checks_updated = 1 THEN '' ELSE 's' END || ' updated'); END IF;
  IF v_checks_removed > 0 THEN v_changes := v_changes || (v_checks_removed || ' check' || CASE WHEN v_checks_removed = 1 THEN '' ELSE 's' END || ' removed'); END IF;
  IF v_refs_added > 0 THEN v_changes := v_changes || (v_refs_added || ' reference' || CASE WHEN v_refs_added = 1 THEN '' ELSE 's' END || ' added'); END IF;
  IF v_refs_removed > 0 THEN v_changes := v_changes || (v_refs_removed || ' reference' || CASE WHEN v_refs_removed = 1 THEN '' ELSE 's' END || ' removed'); END IF;

  IF array_length(v_changes, 1) > 0 THEN
    v_summary := v_summary || ' ' || array_to_string(v_changes, ', ') || '.';
  ELSIF NOT v_is_new_rubric THEN
    v_summary := v_summary || ' No structural changes.';
  END IF;

  IF v_foreign_ids_remapped > 0 THEN
    v_summary := v_summary || ' ' || v_foreign_ids_remapped || ' item(s) with unrecognized ids treated as new.';
  END IF;

  IF v_checks_points_cascaded > 0 THEN
    v_summary := v_summary || ' Cascaded new points to existing comments on '
              || v_checks_points_cascaded || ' check'
              || CASE WHEN v_checks_points_cascaded = 1 THEN '' ELSE 's' END || '.';
  END IF;

  IF v_reviews_recomputed > 0 THEN
    v_summary := v_summary || ' Recomputed scores on '
              || v_reviews_recomputed || ' submission review'
              || CASE WHEN v_reviews_recomputed = 1 THEN '' ELSE 's' END || '.';
  END IF;

  RETURN v_summary;
END;
$function$;

-- 4g. update_regrade_request_status only checked that the caller owns profile_id. Any user could
--     therefore open or escalate any class's regrade request (notifying its instructors under the
--     attacker's name), and record a profile from another class as resolver/closer.
CREATE OR REPLACE FUNCTION public.update_regrade_request_status(regrade_request_id bigint, new_status regrade_status, profile_id uuid, resolved_points numeric DEFAULT NULL::numeric, closed_points numeric DEFAULT NULL::numeric, p_submission_file_id bigint DEFAULT NULL::bigint, p_line integer DEFAULT NULL::integer, p_submission_artifact_id bigint DEFAULT NULL::bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    current_request public.submission_regrade_requests%ROWTYPE;
    param_resolved_points numeric;
    param_closed_points numeric;
    new_submission_comment_id bigint;
    new_submission_file_comment_id bigint;
    new_submission_artifact_comment_id bigint;
    is_bare_check boolean;
begin
    param_resolved_points := resolved_points;
    param_closed_points := closed_points;

    -- Lock the request row so two concurrent transitions cannot both observe the same
    -- pre-transition state and (for bare-check requests) both materialize a backing
    -- comment, which would double-count points in grade recomputation.
    select *
    into current_request
    from public.submission_regrade_requests
    where id = regrade_request_id
    for update;

    if not found then
        raise exception 'Regrade request not found';
    end if;

    -- The acting profile must belong to an active member of the request's class. Graders in
    -- pseudonymous mode act with their public profile, so accept either.
    if not exists (
        select 1
        from public.user_roles ur
        where ur.class_id = current_request.class_id
          and (ur.private_profile_id = update_regrade_request_status.profile_id
               or ur.public_profile_id = update_regrade_request_status.profile_id)
          and ur.disabled = false
    ) then
        raise exception 'Profile is not enrolled in this class';
    end if;

    if new_status = 'resolved' and resolved_points is null then
        raise exception 'resolved_points parameter is required when status is resolved';
    end if;

    if new_status = 'closed' and closed_points is null then
        raise exception 'closed_points parameter is required when status is closed';
    end if;

    -- A "bare check" request targets a rubric check but has no comment yet.
    is_bare_check := current_request.submission_file_comment_id is null
        and current_request.submission_comment_id is null
        and current_request.submission_artifact_comment_id is null
        and current_request.rubric_check_id is not null;

    case new_status
        when 'opened' then
            if current_request.status != 'draft' then
                raise exception 'Can only open regrade requests that are in draft status';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Only submission owners can open regrade requests';
            end if;
            if not exists (
                select 1
                from public.submissions s
                where s.id = current_request.submission_id
                  and (
                    s.profile_id = update_regrade_request_status.profile_id
                    or exists (
                        select 1
                        from public.assignment_groups_members agm
                        where agm.assignment_group_id = s.assignment_group_id
                          and agm.profile_id = update_regrade_request_status.profile_id
                    )
                  )
            ) then
                raise exception 'Only submission owners can open regrade requests';
            end if;

            update public.submission_regrade_requests
            set status = new_status,
                opened_at = now(),
                last_updated_at = now()
            where id = regrade_request_id;

            -- Notify the assignee. For comment-backed requests the assignee is the comment
            -- author; for bare-check requests it is the review's grader (stored on creation).
            insert into public.notifications (class_id, subject, body, style, user_id)
            select
                distinct on (ur.user_id)
                current_request.class_id,
                '{}'::jsonb as subject,
                jsonb_build_object(
                    'type', 'regrade_request',
                    'action', 'comment_challenged',
                    'regrade_request_id', regrade_request_id,
                    'submission_id', current_request.submission_id,
                    'assignment_id', current_request.assignment_id,
                    'opened_by', profile_id,
                    'opened_by_name', (select name from public.profiles where id = profile_id)
                ) as body,
                'info' as style,
                ur.user_id
            from public.user_roles ur
            where ur.class_id = current_request.class_id
              and ur.private_profile_id = (
                case
                    when current_request.submission_file_comment_id is not null then
                        (select author from public.submission_file_comments where id = current_request.submission_file_comment_id)
                    when current_request.submission_comment_id is not null then
                        (select author from public.submission_comments where id = current_request.submission_comment_id)
                    when current_request.submission_artifact_comment_id is not null then
                        (select author from public.submission_artifact_comments where id = current_request.submission_artifact_comment_id)
                    else current_request.assignee
                end
              );

        when 'resolved' then
            if current_request.status != 'opened' then
                raise exception 'Can only resolve regrade requests that are opened';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Unauthorized to act as this profile';
            end if;
            if not authorizeforclassgrader(current_request.class_id) then
                raise exception 'Only graders can resolve regrade requests';
            end if;

            -- For a bare-check request, materialize the real comment now so the score
            -- recompute (which sums comment points by rubric_check_id) picks it up.
            if is_bare_check then
                select
                    m.o_submission_comment_id,
                    m.o_submission_file_comment_id,
                    m.o_submission_artifact_comment_id
                into
                    new_submission_comment_id,
                    new_submission_file_comment_id,
                    new_submission_artifact_comment_id
                from public._materialize_bare_check_regrade_comment(
                    current_request,
                    profile_id,
                    param_resolved_points,
                    regrade_request_id,
                    p_submission_file_id,
                    p_line,
                    p_submission_artifact_id
                ) as m;

                update public.submission_regrade_requests
                set status = new_status,
                    resolved_by = profile_id,
                    resolved_at = now(),
                    resolved_points = param_resolved_points,
                    submission_comment_id = new_submission_comment_id,
                    submission_file_comment_id = new_submission_file_comment_id,
                    submission_artifact_comment_id = new_submission_artifact_comment_id,
                    resolution_reason = 'grader',
                    last_updated_at = now()
                where id = regrade_request_id;
            else
                update public.submission_regrade_requests
                set status = new_status,
                    resolved_by = profile_id,
                    resolved_at = now(),
                    resolved_points = param_resolved_points,
                    resolution_reason = 'grader',
                    last_updated_at = now()
                where id = regrade_request_id;

                if current_request.submission_file_comment_id is not null then
                    update public.submission_file_comments
                    set points = param_resolved_points
                    where id = current_request.submission_file_comment_id;
                elsif current_request.submission_comment_id is not null then
                    update public.submission_comments
                    set points = param_resolved_points
                    where id = current_request.submission_comment_id;
                elsif current_request.submission_artifact_comment_id is not null then
                    update public.submission_artifact_comments
                    set points = param_resolved_points
                    where id = current_request.submission_artifact_comment_id;
                end if;
            end if;

        when 'escalated' then
            if current_request.status != 'resolved' then
                raise exception 'Can only escalate regrade requests that are resolved';
            end if;
            if not authorizeforprofile(profile_id) then
                raise exception 'Only submission owners can escalate regrade requests';
            end if;
            if not exists (
                select 1
                from public.submissions s
                where s.id = current_request.submission_id
                  and (
                    s.profile_id = update_regrade_request_status.profile_id
                    or exists (
                        select 1
                        from public.assignment_groups_members agm
                        where agm.assignment_group_id = s.assignment_group_id
                          and agm.profile_id = update_regrade_request_status.profile_id
                    )
                  )
            ) then
                raise exception 'Only submission owners can escalate regrade requests';
            end if;

            update public.submission_regrade_requests
            set status = new_status,
                escalated_by = profile_id,
                escalated_at = now(),
                last_updated_at = now()
            where id = regrade_request_id;

        when 'closed' then
            if current_request.status not in ('resolved', 'escalated', 'opened') then
                raise exception 'Can only close regrade requests that are resolved, escalated, or opened';
            end if;
            if not public.authorizeforprofile(profile_id) then
                raise exception 'Unauthorized to act as this profile';
            end if;
            if not public.authorizeforclassinstructor(current_request.class_id) then
                raise exception 'Only instructors can close regrade requests';
            end if;

            -- A bare-check request can be closed directly from 'opened' without a grader
            -- having resolved it; materialize the comment in that case too.
            if is_bare_check and current_request.submission_comment_id is null
               and current_request.submission_file_comment_id is null
               and current_request.submission_artifact_comment_id is null then
                select
                    m.o_submission_comment_id,
                    m.o_submission_file_comment_id,
                    m.o_submission_artifact_comment_id
                into
                    new_submission_comment_id,
                    new_submission_file_comment_id,
                    new_submission_artifact_comment_id
                from public._materialize_bare_check_regrade_comment(
                    current_request,
                    profile_id,
                    param_closed_points,
                    regrade_request_id,
                    p_submission_file_id,
                    p_line,
                    p_submission_artifact_id
                ) as m;

                update public.submission_regrade_requests
                set status = new_status,
                    closed_by = profile_id,
                    closed_at = now(),
                    closed_points = param_closed_points,
                    submission_comment_id = new_submission_comment_id,
                    submission_file_comment_id = new_submission_file_comment_id,
                    submission_artifact_comment_id = new_submission_artifact_comment_id,
                    resolution_reason = 'instructor',
                    last_updated_at = now()
                where id = regrade_request_id;
            else
                update public.submission_regrade_requests
                set status = new_status,
                    closed_by = profile_id,
                    closed_at = now(),
                    closed_points = param_closed_points,
                    resolution_reason = 'instructor',
                    last_updated_at = now()
                where id = regrade_request_id;

                if current_request.submission_file_comment_id is not null then
                    update public.submission_file_comments
                    set points = param_closed_points
                    where id = current_request.submission_file_comment_id;
                elsif current_request.submission_comment_id is not null then
                    update public.submission_comments
                    set points = param_closed_points
                    where id = current_request.submission_comment_id;
                elsif current_request.submission_artifact_comment_id is not null then
                    update public.submission_artifact_comments
                    set points = param_closed_points
                    where id = current_request.submission_artifact_comment_id;
                end if;
            end if;

        when 'draft' then
            raise exception 'Cannot transition back to draft status';

        else
            raise exception 'Invalid status: %', new_status;
    end case;

    -- Notify all students connected to the submission of the status change.
    insert into public.notifications (class_id, subject, body, style, user_id)
    select
        current_request.class_id,
        '{}'::jsonb as subject,
        jsonb_build_object(
            'type', 'regrade_request',
            'action', 'status_change',
            'regrade_request_id', regrade_request_id,
            'old_status', current_request.status,
            'new_status', new_status,
            'submission_id', current_request.submission_id,
            'assignment_id', current_request.assignment_id,
            'updated_by', profile_id,
            'updated_by_name', (select name from public.profiles where id = profile_id)
        ) as body,
        'info' as style,
        ur.user_id
    from public.user_roles ur
    where ur.class_id = current_request.class_id
      and ur.role = 'student'
      and ur.private_profile_id != profile_id
      and ur.private_profile_id in (
        select s.profile_id
        from public.submissions s
        where s.id = current_request.submission_id

        union

        select agm.profile_id
        from public.submissions s
        inner join public.assignment_groups_members agm
            on agm.assignment_group_id = s.assignment_group_id
        where s.id = current_request.submission_id
          and s.assignment_group_id is not null
      );

    if new_status = 'escalated' then
        insert into public.notifications (class_id, subject, body, style, user_id)
        select
            current_request.class_id,
            '{}'::jsonb as subject,
            jsonb_build_object(
                'type', 'regrade_request',
                'action', 'escalated',
                'regrade_request_id', regrade_request_id,
                'old_status', current_request.status,
                'new_status', new_status,
                'submission_id', current_request.submission_id,
                'assignment_id', current_request.assignment_id,
                'escalated_by', profile_id,
                'escalated_by_name', (select name from public.profiles where id = profile_id)
            ) as body,
            'warning' as style,
            ur.user_id
        from public.user_roles ur
        where ur.class_id = current_request.class_id
          and ur.role = 'instructor';
    end if;

    return true;
end;
$function$;

-- 4h. get_student_summary is student-callable for the student's own profile (its assignment
--     scores are already gated on release for non-staff), but its grades_private section returned
--     is_private gradebook rows -- unreleased and instructor-only scores that RLS hides from
--     students. Return those to staff only.
CREATE OR REPLACE FUNCTION public.get_student_summary(p_class_id bigint, p_student_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_public_profile_id uuid;
  v_profile_ids uuid[];
  v_is_staff boolean;
begin
  -- Authorization: allow if caller is the student (private_profile) or staff (instructor/grader) in the class
  if not exists (
    select 1
    from public.user_privileges ur
    where ur.class_id = p_class_id
      and ur.user_id = auth.uid()
      and (
        ur.role in ('instructor','grader')
        or ur.private_profile_id = p_student_profile_id
      )
  ) then
    raise exception 'Access denied'
      using errcode = 'insufficient_privilege';
  end if;

  -- Staff (instructor/grader) may see in-progress grading totals; students may not see a
  -- grading review's scores until it is released (see join predicate below).
  select exists (
    select 1
    from public.user_privileges ur
    where ur.class_id = p_class_id
      and ur.user_id = auth.uid()
      and ur.role in ('instructor','grader')
  ) into v_is_staff;

  -- Resolve both profile IDs for the student in this class
  select up.public_profile_id
    into v_public_profile_id
    from public.user_privileges up
   where up.class_id = p_class_id
     and up.private_profile_id = p_student_profile_id
   limit 1;

  v_profile_ids := array_remove(ARRAY[p_student_profile_id, v_public_profile_id], NULL);

  -- Build JSON in parts
  with
  -- Recent help requests the student is a participant in this class (latest 50)
  help_requests as (
    select hr.id,
           hr.created_at,
           hr.help_queue,
           hr.request,
           hr.assignee,
           hr.resolved_by,
           hr.resolved_at,
           hr.is_private,
           hr.status
      from public.help_requests hr
      join public.help_request_students hrs on hrs.help_request_id = hr.id and hrs.class_id = hr.class_id
     where hr.class_id = p_class_id
       and hrs.profile_id = any (v_profile_ids)
     order by hr.created_at desc
     limit 50
  ),
  help_request_ids as (
    select id from help_requests
  ),
  -- Latest 50 messages authored by the student across all help requests in the class
  help_messages as (
    select hrm.id,
           hrm.created_at,
           hrm.author,
           hrm.message,
           hrm.instructors_only,
           hrm.help_request_id
      from public.help_request_messages hrm
     where hrm.class_id = p_class_id
       and hrm.author = any (v_profile_ids)
     order by hrm.created_at desc
     limit 50
  ),
  -- Recent discussion threads (student-authored) and replies (latest 50 each)
  discussion_posts as (
    select dt.id,
           dt.created_at,
           dt.subject,
           dt.body,
           dt.instructors_only,
           dt.parent,
           dt.root,
           dt.topic_id
      from public.discussion_threads dt
     where dt.class_id = p_class_id
       and dt.author = any (v_profile_ids)
       and dt.parent is null
     order by dt.created_at desc
     limit 50
  ),
  discussion_replies as (
    select dt.id,
           dt.created_at,
           dt.subject,
           dt.body,
           dt.instructors_only,
           dt.parent,
           dt.root,
           dt.topic_id
      from public.discussion_threads dt
     where dt.class_id = p_class_id
       and dt.author = any (v_profile_ids)
       and dt.parent is not null
     order by dt.created_at desc
     limit 50
  ),
  -- Assignment summary for released assignments
  assignments as (
    select a.id as assignment_id,
           a.title,
           a.release_date,
           public.calculate_final_due_date(a.id, p_student_profile_id, agm.assignment_group_id) as effective_due_date,
           a.total_points,
           s.id as submission_id,
           s.created_at as submission_timestamp,
           s.ordinal as submission_ordinal,
           sr.total_autograde_score as autograder_score,
           sr.total_score as total_score
      from public.assignments a
      left join public.assignment_groups_members agm
        on agm.assignment_id = a.id and agm.profile_id = any (v_profile_ids)
      left join public.submissions s
        on s.assignment_id = a.id
       and s.is_active = true
       and (
         (s.profile_id = any (v_profile_ids) and s.assignment_group_id is null)
         or (s.profile_id is null and s.assignment_group_id = agm.assignment_group_id)
       )
      -- Release gate: only join the grading review's scores for non-staff once it is
      -- released. Staff (v_is_staff) always see them; students see NULL until release.
      left join public.submission_reviews sr
        on sr.id = s.grading_review_id
       and (v_is_staff or sr.released = true)
     where a.class_id = p_class_id
       and a.release_date is not null
       and a.release_date <= now()
  ),
  -- Private grades only
  private_grades as (
    select gcs.gradebook_column_id,
           gcs.score,
           gcs.score_override,
           gcs.released,
           gcs.incomplete_values
      from public.gradebook_column_students gcs
     where gcs.class_id = p_class_id
       and gcs.student_id = p_student_profile_id
       and gcs.is_private = true
       and v_is_staff
  )
  select jsonb_build_object(
    'help_requests', coalesce(jsonb_agg(to_jsonb(help_requests) order by help_requests.created_at desc), '[]'::jsonb),
    'help_messages', coalesce((select jsonb_agg(to_jsonb(help_messages) order by help_messages.created_at desc) from help_messages), '[]'::jsonb),
    'discussion_posts', coalesce((select jsonb_agg(to_jsonb(discussion_posts) order by discussion_posts.created_at desc) from discussion_posts), '[]'::jsonb),
    'discussion_replies', coalesce((select jsonb_agg(to_jsonb(discussion_replies) order by discussion_replies.created_at desc) from discussion_replies), '[]'::jsonb),
    'assignments', coalesce((select jsonb_agg(to_jsonb(assignments) order by assignments.effective_due_date asc nulls last) from assignments), '[]'::jsonb),
    'grades_private', coalesce((select jsonb_agg(to_jsonb(private_grades)) from private_grades), '[]'::jsonb)
  ) into v_result
  from help_requests
  limit 1;

  -- If no help requests existed, still build result from empty selects
  if v_result is null then
    select jsonb_build_object(
      'help_requests', '[]'::jsonb,
      'help_messages', coalesce((select jsonb_agg(to_jsonb(help_messages) order by help_messages.created_at desc) from help_messages), '[]'::jsonb),
      'discussion_posts', coalesce((select jsonb_agg(to_jsonb(discussion_posts) order by discussion_posts.created_at desc) from discussion_posts), '[]'::jsonb),
      'discussion_replies', coalesce((select jsonb_agg(to_jsonb(discussion_replies) order by discussion_replies.created_at desc) from discussion_replies), '[]'::jsonb),
      'assignments', coalesce((select jsonb_agg(to_jsonb(assignments) order by assignments.effective_due_date asc nulls last) from assignments), '[]'::jsonb),
      'grades_private', coalesce((select jsonb_agg(to_jsonb(private_grades)) from private_grades), '[]'::jsonb)
    ) into v_result;
  end if;

  return v_result;
end;
$function$;

-- 4i. trigger_signup_welcome_message was SECURITY INVOKER, so the instructor or student whose
--     insert created the role needed EXECUTE on send_signup_welcome_message, which inserts a
--     notification for any p_user_id. Running the trigger as definer lets section 2 revoke the
--     function from authenticated. The first-role check also now sees the user's roles in every
--     class, not only the ones visible to the inserting user under RLS.
CREATE OR REPLACE FUNCTION public.trigger_signup_welcome_message()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
    -- Check if this is the user's first role
    IF NOT EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = NEW.user_id 
        AND id != NEW.id
    ) THEN
        -- Send welcome message asynchronously (don't block if it fails)
        PERFORM public.send_signup_welcome_message(NEW.user_id);
    END IF;
    
    RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.trigger_signup_welcome_message() FROM PUBLIC, anon, authenticated;

-- 4j. calculate_effective_due_date and calculate_final_due_date answered for any assignment and
--     profile, exposing another student's lab-based due date and summed extension hours across
--     classes. They stay granted to authenticated because the security_invoker views
--     assignments_with_effective_due_dates and submissions_with_grades_for_assignment_and_regression_test
--     call them per row; those rows are already limited by RLS to the caller's own profile (and
--     group) for students, and to the class for staff, which is exactly what the check allows.
--     SECURITY DEFINER callers (finalize_submission_early, submission_set_active,
--     get_student_summary, get_assignments_for_student_dashboard) pass the same arguments, and
--     cron/service-role callers are not checked.
--     The views call these once per row, so the check is one query over the caller's own
--     user_privileges rows, in a SQL function with no SET clause (a separate SECURITY DEFINER
--     plpgsql check with SET search_path made the per-row call about 5x slower for staff). It
--     runs with the calling SECURITY DEFINER function's privileges.
CREATE OR REPLACE FUNCTION public._due_date_lookup_allowed(
  p_assignment_id bigint, p_profile_id uuid, p_assignment_group_id bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT coalesce(auth.role(), '') NOT IN ('anon', 'authenticated')
    OR EXISTS (
      SELECT 1
      FROM public.user_privileges up
      WHERE up.user_id = auth.uid()
        AND (
          -- Staff of the assignment's class.
          (up.role IN ('instructor', 'grader')
           AND up.class_id = (SELECT a.class_id FROM public.assignments a WHERE a.id = p_assignment_id))
          -- No group: the profile is the caller's own (or absent, which reads nothing).
          OR (p_assignment_group_id IS NULL
              AND (p_profile_id IS NULL OR up.private_profile_id = p_profile_id))
          -- A group's exceptions are summed in: the caller is in the group, and the profile (if
          -- any) is the caller's or another member's.
          OR (p_assignment_group_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.assignment_groups_members m
                WHERE m.assignment_group_id = p_assignment_group_id
                  AND m.profile_id = up.private_profile_id)
              AND (p_profile_id IS NULL
                   OR up.private_profile_id = p_profile_id
                   OR EXISTS (
                     SELECT 1 FROM public.assignment_groups_members m
                     WHERE m.assignment_group_id = p_assignment_group_id
                       AND m.profile_id = p_profile_id)))
        )
    );
$function$;

REVOKE ALL ON FUNCTION public._due_date_lookup_allowed(bigint, uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._due_date_lookup_allowed(bigint, uuid, bigint) TO service_role;

-- The unchecked computation, so calculate_final_due_date does not run the check twice.
CREATE OR REPLACE FUNCTION public._calculate_effective_due_date(assignment_id_param bigint, student_profile_id_param uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public._calculate_effective_due_date(bigint, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._calculate_effective_due_date(bigint, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.calculate_effective_due_date(assignment_id_param bigint, student_profile_id_param uuid)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN
    IF NOT public._due_date_lookup_allowed(assignment_id_param, student_profile_id_param, NULL) THEN
        RAISE EXCEPTION 'Access denied: not your due date' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN public._calculate_effective_due_date(assignment_id_param, student_profile_id_param);
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_final_due_date(assignment_id_param bigint, student_profile_id_param uuid, assignment_group_id_param bigint DEFAULT NULL::bigint)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
    effective_due_date timestamp with time zone;
    total_extension_hours integer := 0;
    total_extension_minutes integer := 0;
BEGIN
    IF NOT public._due_date_lookup_allowed(assignment_id_param, student_profile_id_param, assignment_group_id_param) THEN
        RAISE EXCEPTION 'Access denied: not your due date' USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- Get the effective due date (lab-based or regular)
    effective_due_date := public._calculate_effective_due_date(assignment_id_param, student_profile_id_param);
    
    -- Calculate total extensions for this student/group
    SELECT 
        COALESCE(SUM(hours), 0),
        COALESCE(SUM(minutes), 0)
    INTO 
        total_extension_hours,
        total_extension_minutes
    FROM public.assignment_due_date_exceptions
    WHERE assignment_id = assignment_id_param
    AND (
        student_id = student_profile_id_param 
        OR (assignment_group_id_param IS NOT NULL AND assignment_group_id = assignment_group_id_param)
    );
    
    -- Apply extensions to the effective due date
    RETURN effective_due_date 
           + (total_extension_hours * INTERVAL '1 hour')
           + (total_extension_minutes * INTERVAL '1 minute');
END;
$function$;

-- 4k. user_is_in_help_request(id, p_user_id) answered for any p_user_id. Every policy and
--     function that calls it uses the auth.uid() default, so end users may only ask about
--     themselves. The body is 20261014120000_help_request_write_rls_hardening's (profiles in the
--     request's own class only); only the first condition is new.
CREATE OR REPLACE FUNCTION public.user_is_in_help_request(p_help_request_id bigint, p_user_id uuid DEFAULT auth.uid())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT (p_user_id = auth.uid() OR coalesce(auth.role(), '') NOT IN ('anon', 'authenticated'))
     AND EXISTS (
    SELECT 1
      FROM public.help_requests hr
      JOIN public.user_privileges up
        ON up.user_id = p_user_id AND up.class_id = hr.class_id
     WHERE hr.id = p_help_request_id
       AND (hr.created_by = up.private_profile_id
            OR EXISTS (SELECT 1 FROM public.help_request_students hrs
                        WHERE hrs.help_request_id = hr.id
                          AND hrs.profile_id IN (up.private_profile_id, up.public_profile_id)))
  );
$function$;
