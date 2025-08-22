drop policy "Users can manage their own preferences" on "public"."notification_preferences";

revoke delete on table "public"."notification_preferences" from "anon";

revoke insert on table "public"."notification_preferences" from "anon";

revoke references on table "public"."notification_preferences" from "anon";

revoke select on table "public"."notification_preferences" from "anon";

revoke trigger on table "public"."notification_preferences" from "anon";

revoke truncate on table "public"."notification_preferences" from "anon";

revoke update on table "public"."notification_preferences" from "anon";

revoke delete on table "public"."notification_preferences" from "authenticated";

revoke insert on table "public"."notification_preferences" from "authenticated";

revoke references on table "public"."notification_preferences" from "authenticated";

revoke select on table "public"."notification_preferences" from "authenticated";

revoke trigger on table "public"."notification_preferences" from "authenticated";

revoke truncate on table "public"."notification_preferences" from "authenticated";

revoke update on table "public"."notification_preferences" from "authenticated";

revoke delete on table "public"."notification_preferences" from "service_role";

revoke insert on table "public"."notification_preferences" from "service_role";

revoke references on table "public"."notification_preferences" from "service_role";

revoke select on table "public"."notification_preferences" from "service_role";

revoke trigger on table "public"."notification_preferences" from "service_role";

revoke truncate on table "public"."notification_preferences" from "service_role";

revoke update on table "public"."notification_preferences" from "service_role";

alter table "public"."notification_preferences" drop constraint "notification_preferences_class_id_fkey";

alter table "public"."notification_preferences" drop constraint "notification_preferences_user_id_fkey";

alter table "public"."notification_preferences" drop constraint "notification_preferences_pkey";

drop index if exists "public"."notification_preferences_pkey";

drop table "public"."notification_preferences";

drop type "public"."email_digest_frequency";

drop type "public"."notification_type";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.create_help_request_notification(p_class_id bigint, p_notification_type text, p_help_request_id bigint, p_help_queue_id bigint, p_help_queue_name text, p_creator_profile_id uuid, p_creator_name text, p_assignee_profile_id uuid DEFAULT NULL::uuid, p_assignee_name text DEFAULT NULL::text, p_status help_request_status DEFAULT NULL::help_request_status, p_request_preview text DEFAULT ''::text, p_is_private boolean DEFAULT false, p_action text DEFAULT 'created'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  notification_body jsonb;
begin
  if p_notification_type = 'help_request' then
    notification_body := jsonb_build_object(
      'type', 'help_request',
      'action', p_action,
      'help_request_id', p_help_request_id,
      'help_queue_id', p_help_queue_id,
      'help_queue_name', p_help_queue_name,
      'creator_profile_id', p_creator_profile_id,
      'creator_name', p_creator_name,
      'assignee_profile_id', p_assignee_profile_id,
      'assignee_name', p_assignee_name,
      'status', p_status,
      'request_preview', p_request_preview,
      -- Enrich with subject/body for email templates and digests
      'request_subject', coalesce(
        (
          select hrt.name
          from public.help_request_templates hrt
          where hrt.id = (
            select hr.template_id from public.help_requests hr where hr.id = p_help_request_id
          )
        ),
        'General'
      ),
      'request_body', (
        select hr.request from public.help_requests hr where hr.id = p_help_request_id
      ),
      'is_private', p_is_private
    );
  elsif p_notification_type is null then
    raise exception 'create_help_request_notification: p_notification_type must not be null';
  else
    -- Future-proof: explicitly reject unsupported types
    raise exception 'create_help_request_notification: unsupported p_notification_type=%', p_notification_type;
  end if;

  -- On creation: notify instructors and graders only (do NOT blast the entire class)
  if p_action = 'created' then
    insert into public.notifications (user_id, class_id, subject, body)
    select distinct
      ur.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.user_roles ur
    where ur.class_id = p_class_id
      and ur.role in ('instructor', 'grader');

    -- Ensure the creator is watching their own request
    insert into public.help_request_watchers (user_id, help_request_id, class_id, enabled)
    select ur.user_id, p_help_request_id, p_class_id, true
    from public.user_roles ur
    where ur.private_profile_id = p_creator_profile_id
      and ur.class_id = p_class_id
    on conflict (user_id, help_request_id) do nothing;

  else
    -- For assignment/status changes: notify watchers
    insert into public.notifications (user_id, class_id, subject, body)
    select 
      hrw.user_id,
      p_class_id,
      jsonb_build_object('text', 'Help Request ' || p_action),
      notification_body
    from public.help_request_watchers hrw
    join public.user_roles ur on ur.user_id = hrw.user_id and ur.class_id = p_class_id
    where hrw.help_request_id = p_help_request_id
      and hrw.enabled = true
      and (
        -- For private requests, only notify instructors, graders, creator, and assignee
        (p_is_private and ur.role in ('instructor', 'grader'))
        or (p_is_private and ur.private_profile_id = p_creator_profile_id)
        or (p_is_private and ur.private_profile_id = p_assignee_profile_id)
        -- For public requests, notify all watching users
        or not p_is_private
      );
  end if;
end;
$function$
;

-- CRITICAL SECURITY FIX: Revoke dangerous anonymous permissions
-- Anonymous users should NOT have access to any functions or tables

-- Revoke ALL function permissions from anon
REVOKE ALL ON FUNCTION "public"."admin_bulk_set_user_roles_disabled"("p_user_role_ids" bigint[], "p_disabled" boolean, "p_admin_user_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_create_class"("p_name" "text", "p_term" integer, "p_description" "text", "p_github_org_name" "text", "p_github_template_prefix" "text", "p_created_by" "uuid", "p_course_title" "text", "p_start_date" "date", "p_end_date" "date") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_create_class_section"("p_class_id" bigint, "p_name" "text", "p_created_by" "uuid", "p_meeting_location" "text", "p_meeting_times" "text", "p_campus" "text", "p_sis_crn" integer) FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_create_lab_section"("p_class_id" bigint, "p_name" "text", "p_created_by" "uuid", "p_meeting_location" "text", "p_meeting_times" "text", "p_campus" "text", "p_sis_crn" integer, "p_day_of_week" "public"."day_of_week", "p_start_time" time without time zone, "p_end_time" time without time zone, "p_description" "text") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_delete_class"("p_class_id" bigint, "p_deleted_by" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_delete_class_section"("p_section_id" bigint, "p_deleted_by" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_delete_lab_section"("p_section_id" bigint, "p_deleted_by" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_get_class_sections"("p_class_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_get_classes"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_get_disabled_users"("p_class_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_get_sis_sync_status"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_set_section_sync_enabled"("p_course_id" bigint, "p_enabled" boolean, "p_course_section_id" bigint, "p_lab_section_id" bigint, "p_admin_user_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_set_sis_sync_enabled"("p_class_id" bigint, "p_enabled" boolean, "p_admin_user_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_set_user_role_disabled"("p_user_role_id" bigint, "p_disabled" boolean, "p_admin_user_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_trigger_sis_sync"("p_class_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_update_class"("p_class_id" bigint, "p_name" "text", "p_term" integer, "p_description" "text", "p_github_org_name" "text", "p_github_template_prefix" "text", "p_updated_by" "uuid", "p_course_title" "text", "p_start_date" "date", "p_end_date" "date") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_update_class_section"("p_section_id" bigint, "p_name" "text", "p_updated_by" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."admin_update_lab_section"("p_section_id" bigint, "p_name" "text", "p_updated_by" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."assignment_before_update"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."assignment_group_join_request_decision"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."assignments_grader_config_auto_populate"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."audit_discussion_threads_statement"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."audit_insert_and_update"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."audit_insert_and_update_and_delete"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorize_for_admin"("p_user_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorize_for_private_discussion_thread"("root" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorize_for_submission"("requested_submission_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorize_for_submission_regrade_comment"("submission_regrade_request_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorize_for_submission_review"("submission_review_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorize_for_submission_review_writable"("submission_review_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorize_for_submission_reviewable"("requested_submission_id" bigint, "requested_submission_review_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorize_to_create_own_due_date_extension"("_student_id" "uuid", "_assignment_group_id" bigint, "_assignment_id" bigint, "_class_id" bigint, "_creator_id" "uuid", "_hours_to_extend" integer, "_tokens_consumed" integer) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorizeforassignmentgroup"("_assignment_group_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorizeforclass"("class__id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorizeforclassgrader"("class__id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorizeforclassinstructor"("class__id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorizeforinstructorofstudent"("_user_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorizeforinstructororgraderofstudent"("_user_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorizeforpoll"("poll__id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorizeforpoll"("poll__id" bigint, "class__id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."authorizeforprofile"("profile_id" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."auto_create_role_tags"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_course_table_change_unified"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_discussion_thread_read_status_unified"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_discussion_threads_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_gradebook_column_students_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_gradebook_columns_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_gradebook_data_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_help_queue_data_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_help_request_data_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_help_request_staff_data_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_regrade_request_data_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_review_assignment_data_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_review_assignment_rubric_part_data_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."broadcast_submission_data_change"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."calculate_effective_due_date"("assignment_id_param" bigint, "student_profile_id_param" "uuid") FROM "anon";
REVOKE ALL ON FUNCTION "public"."calculate_final_due_date"("assignment_id_param" bigint, "student_profile_id_param" "uuid", "assignment_group_id_param" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."call_edge_function_internal"("url_path" "text", "method" "text", "headers" "jsonb", "params" "jsonb", "timeout_ms" integer, "old_record" "jsonb", "new_record" "jsonb", "op" "text", "table_name" "text", "schema_name" "text") FROM "anon";
REVOKE ALL ON FUNCTION "public"."can_access_help_request"("help_request_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."check_and_complete_submission_review"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."check_assignment_deadlines_passed"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."check_assignment_for_repo_creation"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."check_assignment_release_dates"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."check_gradebook_realtime_authorization"("topic_text" "text") FROM "anon";
REVOKE ALL ON FUNCTION "public"."check_unified_realtime_authorization"("topic_text" "text") FROM "anon";
REVOKE ALL ON FUNCTION "public"."classes_populate_default_structures"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."complete_remaining_review_assignments"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_all_repos_for_assignment"("course_id" integer, "assignment_id" integer) FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_all_repos_for_assignment"("course_id" bigint, "assignment_id" bigint) FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_gradebook_column_for_assignment"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_gradebook_staff_channel"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_gradebook_student_channel"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_help_queue_channels"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_help_request_channels"() FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_help_request_message_notification"("p_class_id" bigint, "p_help_request_id" bigint, "p_help_queue_id" bigint, "p_help_queue_name" "text", "p_message_id" bigint, "p_author_profile_id" "uuid", "p_author_name" "text", "p_message_preview" "text", "p_help_request_creator_profile_id" "uuid", "p_help_request_creator_name" "text", "p_is_private" boolean) FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_help_request_notification"("p_class_id" bigint, "p_notification_type" "text", "p_help_request_id" bigint, "p_help_queue_id" bigint, "p_help_queue_name" "text", "p_creator_profile_id" "uuid", "p_creator_name" "text", "p_assignee_profile_id" "uuid", "p_assignee_name" "text", "p_status" "public"."help_request_status", "p_request_preview" "text", "p_is_private" boolean, "p_action" "text") FROM "anon";
REVOKE ALL ON FUNCTION "public"."create_invitation"("p_class_id" bigint, "p_role" "public"."app_role", "p_sis_user_id" integer, "p_email" "text", "p_name" "text", "p_invited_by" "uuid", "p_class_section_id" bigint, "p_lab_section_id" bigint) FROM "anon";

-- Revoke ALL table permissions from anon
REVOKE ALL ON TABLE "public"."gradebook_columns" FROM "anon";
REVOKE ALL ON TABLE "public"."assignment_groups" FROM "anon";
REVOKE ALL ON TABLE "public"."assignment_groups_members" FROM "anon";
REVOKE ALL ON TABLE "public"."submissions" FROM "anon";
REVOKE ALL ON TABLE "public"."active_submissions_for_class" FROM "anon";
REVOKE ALL ON TABLE "public"."assignment_due_date_exceptions" FROM "anon";
REVOKE ALL ON TABLE "public"."assignment_group_invitations" FROM "anon";
REVOKE ALL ON TABLE "public"."assignment_group_join_request" FROM "anon";
REVOKE ALL ON TABLE "public"."assignment_handout_commits" FROM "anon";
REVOKE ALL ON TABLE "public"."assignments" FROM "anon";
REVOKE ALL ON TABLE "public"."submission_regrade_requests" FROM "anon";
REVOKE ALL ON TABLE "public"."assignment_overview" FROM "anon";
REVOKE ALL ON TABLE "public"."rubrics" FROM "anon";
REVOKE ALL ON TABLE "public"."assignment_self_review_settings" FROM "anon";
REVOKE ALL ON TABLE "public"."grader_results" FROM "anon";
REVOKE ALL ON TABLE "public"."repositories" FROM "anon";
REVOKE ALL ON TABLE "public"."review_assignments" FROM "anon";
REVOKE ALL ON TABLE "public"."submission_reviews" FROM "anon";
REVOKE ALL ON TABLE "public"."assignments_for_student_dashboard" FROM "anon";
REVOKE ALL ON TABLE "public"."assignments_with_effective_due_dates" FROM "anon";
REVOKE ALL ON TABLE "public"."audit" FROM "anon";
REVOKE ALL ON TABLE "public"."autograder" FROM "anon";
REVOKE ALL ON TABLE "public"."autograder_commits" FROM "anon";
REVOKE ALL ON TABLE "public"."autograder_regression_test" FROM "anon";
REVOKE ALL ON TABLE "public"."profiles" FROM "anon";
REVOKE ALL ON TABLE "public"."autograder_regression_test_by_grader" FROM "anon";
REVOKE ALL ON TABLE "public"."class_sections" FROM "anon";
REVOKE ALL ON TABLE "public"."classes" FROM "anon";
REVOKE ALL ON TABLE "public"."discussion_threads" FROM "anon";
REVOKE ALL ON TABLE "public"."discussion_thread_likes" FROM "anon";
REVOKE ALL ON TABLE "public"."discussion_thread_ordinal_counters" FROM "anon";
REVOKE ALL ON TABLE "public"."discussion_thread_read_status" FROM "anon";
REVOKE ALL ON TABLE "public"."discussion_thread_watcher_cache" FROM "anon";
REVOKE ALL ON TABLE "public"."discussion_thread_watchers" FROM "anon";
REVOKE ALL ON TABLE "public"."discussion_topics" FROM "anon";
REVOKE ALL ON TABLE "public"."email_batches" FROM "anon";
REVOKE ALL ON TABLE "public"."emails" FROM "anon";
REVOKE ALL ON TABLE "public"."flashcard_interaction_logs" FROM "anon";
REVOKE ALL ON TABLE "public"."flashcard_card_analytics" FROM "anon";
REVOKE ALL ON TABLE "public"."flashcard_decks" FROM "anon";
REVOKE ALL ON TABLE "public"."flashcard_deck_analytics" FROM "anon";
REVOKE ALL ON TABLE "public"."flashcard_student_card_analytics" FROM "anon";
REVOKE ALL ON TABLE "public"."flashcards" FROM "anon";
REVOKE ALL ON TABLE "public"."student_flashcard_deck_progress" FROM "anon";
REVOKE ALL ON TABLE "public"."flashcard_student_deck_analytics" FROM "anon";
REVOKE ALL ON TABLE "public"."gradebook_column_students" FROM "anon";
REVOKE ALL ON TABLE "public"."gradebooks" FROM "anon";
REVOKE ALL ON TABLE "public"."grader_keys" FROM "anon";
REVOKE ALL ON TABLE "public"."grader_result_output" FROM "anon";
REVOKE ALL ON TABLE "public"."grader_result_test_output" FROM "anon";
REVOKE ALL ON TABLE "public"."grader_result_tests" FROM "anon";
REVOKE ALL ON TABLE "public"."grading_conflicts" FROM "anon";
REVOKE ALL ON TABLE "public"."help_queue_assignments" FROM "anon";
REVOKE ALL ON TABLE "public"."help_queues" FROM "anon";
REVOKE ALL ON TABLE "public"."help_request_feedback" FROM "anon";
REVOKE ALL ON TABLE "public"."help_request_file_references" FROM "anon";
REVOKE ALL ON TABLE "public"."help_request_message_read_receipts" FROM "anon";
REVOKE ALL ON TABLE "public"."help_request_messages" FROM "anon";
REVOKE ALL ON TABLE "public"."help_request_moderation" FROM "anon";
REVOKE ALL ON TABLE "public"."help_request_students" FROM "anon";
REVOKE ALL ON TABLE "public"."help_request_templates" FROM "anon";
REVOKE ALL ON TABLE "public"."help_request_watchers" FROM "anon";
REVOKE ALL ON TABLE "public"."help_requests" FROM "anon";
REVOKE ALL ON TABLE "public"."invitations" FROM "anon";
REVOKE ALL ON TABLE "public"."lab_section_meetings" FROM "anon";
REVOKE ALL ON TABLE "public"."lab_sections" FROM "anon";
REVOKE ALL ON TABLE "public"."name_generation_words" FROM "anon";
REVOKE ALL ON TABLE "public"."notifications" FROM "anon";
REVOKE ALL ON TABLE "public"."permissions" FROM "anon";
REVOKE ALL ON TABLE "public"."poll_question_answers" FROM "anon";
REVOKE ALL ON TABLE "public"."poll_question_results" FROM "anon";
REVOKE ALL ON TABLE "public"."poll_questions" FROM "anon";
REVOKE ALL ON TABLE "public"."poll_response_answers" FROM "anon";
REVOKE ALL ON TABLE "public"."poll_responses" FROM "anon";
REVOKE ALL ON TABLE "public"."polls" FROM "anon";
REVOKE ALL ON TABLE "public"."repository_check_runs" FROM "anon";
REVOKE ALL ON TABLE "public"."review_assignment_rubric_parts" FROM "anon";
REVOKE ALL ON TABLE "public"."review_assignments_summary_by_assignee" FROM "anon";
REVOKE ALL ON TABLE "public"."rubric_check_references" FROM "anon";
REVOKE ALL ON TABLE "public"."rubric_checks" FROM "anon";
REVOKE ALL ON TABLE "public"."rubric_criteria" FROM "anon";
REVOKE ALL ON TABLE "public"."rubric_parts" FROM "anon";
REVOKE ALL ON TABLE "public"."sis_sync_status" FROM "anon";
REVOKE ALL ON TABLE "public"."student_help_activity" FROM "anon";
REVOKE ALL ON TABLE "public"."student_karma_notes" FROM "anon";
REVOKE ALL ON TABLE "public"."submission_artifact_comments" FROM "anon";
REVOKE ALL ON TABLE "public"."submission_artifacts" FROM "anon";
REVOKE ALL ON TABLE "public"."submission_comments" FROM "anon";
REVOKE ALL ON TABLE "public"."submission_file_comments" FROM "anon";
REVOKE ALL ON TABLE "public"."submission_files" FROM "anon";
REVOKE ALL ON TABLE "public"."submission_ordinal_counters" FROM "anon";
REVOKE ALL ON TABLE "public"."submission_regrade_request_comments" FROM "anon";
REVOKE ALL ON TABLE "public"."submissions_agg" FROM "anon";
REVOKE ALL ON TABLE "public"."submissions_with_grades_for_assignment" FROM "anon";
REVOKE ALL ON TABLE "public"."submissions_with_grades_for_assignment_and_regression_test" FROM "anon";
REVOKE ALL ON TABLE "public"."tags" FROM "anon";
REVOKE ALL ON TABLE "public"."users" FROM "anon";
REVOKE ALL ON TABLE "public"."video_meeting_sessions" FROM "anon";
REVOKE ALL ON TABLE "public"."webhook_process_status" FROM "anon";
REVOKE ALL ON TABLE "public"."workflow_events" FROM "anon";
REVOKE ALL ON TABLE "public"."workflow_events_summary" FROM "anon";
REVOKE ALL ON TABLE "public"."workflow_run_error" FROM "anon";

-- Revoke ALL sequence permissions from anon
REVOKE ALL ON SEQUENCE "public"."assignment_due_date_exceptions_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."assignment_group_invitations_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."assignment_group_join_request_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."assignment_groups_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."assignment_groups_members_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."assignment_handout_commits_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."assignment_rubric_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."assignments_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."audit_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."autograder_commits_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."autograder_regression_test_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."class_sections_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."classes_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."dicussion_threads_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."discussion_thread_likes_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."discussion_thread_read_status_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."discussion_thread_watchers_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."discussion_topics_id_seq" FROM "anon";
REVOKE ALL ON SEQUENCE "public"."email_batches_id_seq" FROM "anon";

-- Revoke dangerous default privileges
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon";

