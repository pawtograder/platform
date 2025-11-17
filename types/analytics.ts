/**
 * PostHog Analytics Event Types
 *
 * This file defines all tracked events and their properties for type safety.
 * Each event should have a clearly defined interface with all its properties.
 */

// ============================================================================
// ASSIGNMENT & SUBMISSION EVENTS
// ============================================================================

export interface AssignmentViewedEvent {
  assignment_id: number;
  course_id: number;
  is_group_assignment: boolean;
  days_until_due: number | null;
  has_submissions: boolean;
  assignment_slug: string | null;
}

export interface LateTokenConsumedEvent {
  assignment_id: number;
  course_id: number;
  tokens_remaining: number;
  tokens_on_this_assignment: number;
  is_group_assignment: boolean;
  assignment_slug: string | null;
}

export interface AssignmentCreatedEvent {
  course_id: number;
  assignment_id: number;
  has_autograder: boolean;
  has_handgrader: boolean;
  is_group_assignment: boolean;
  max_late_tokens: number;
  assignment_slug: string | null;
}

// ============================================================================
// GRADING EVENTS
// ============================================================================

export interface GradingStartedEvent {
  submission_id: number;
  assignment_id: number;
  course_id: number;
  grader_role: "instructor" | "grader";
  submission_review_id: number;
}

export interface GradingCompletedEvent {
  submission_id: number;
  assignment_id: number;
  course_id: number;
  time_spent_seconds?: number;
  num_comments_added: number;
  num_file_comments: number;
  grader_role: "instructor" | "grader";
  submission_review_id: number;
  total_score: number | null;
}

export interface RubricCheckAppliedEvent {
  rubric_check_id: number;
  submission_id: number;
  assignment_id: number;
  course_id: number;
  is_file_comment: boolean;
  points: number;
  comment_type: "file" | "general" | "artifact";
}

export interface GradesReleasedEvent {
  assignment_id: number;
  course_id: number;
  num_submissions_released: number;
}

// ============================================================================
// OFFICE HOURS / HELP QUEUE EVENTS
// ============================================================================

export interface HelpRequestCreatedEvent {
  help_queue_id: number;
  course_id: number;
  queue_type: "text" | "video" | "in_person";
  queue_length: number;
  has_file_references: boolean;
  help_request_id: number;
}

export interface HelpRequestResolvedEvent {
  help_request_id: number;
  course_id: number;
  wait_time_minutes: number;
  session_duration_minutes: number;
  queue_type: "text" | "video" | "in_person";
}

export interface QueueAssignmentStartedEvent {
  help_queue_id: number;
  course_id: number;
  max_concurrent_students: number;
  queue_assignment_id: number;
}

export interface QueueAssignmentEndedEvent {
  help_queue_id: number;
  course_id: number;
  queue_assignment_id: number;
  duration_minutes: number;
}

export interface HelpRequestClaimedEvent {
  help_request_id: number;
  course_id: number;
  student_wait_time_minutes: number;
  queue_type: "text" | "video" | "in_person";
}

export interface VideoCallStartedEvent {
  help_request_id: number;
  course_id: number;
}

// ============================================================================
// DISCUSSION FORUM EVENTS
// ============================================================================

export interface DiscussionThreadCreatedEvent {
  course_id: number;
  thread_id: number;
  topic_id: number | null;
  is_question: boolean;
  is_private: boolean;
  is_anonymous: boolean;
}

export interface DiscussionReplyPostedEvent {
  thread_id: number;
  root_thread_id: number;
  course_id: number;
  is_anonymous: boolean;
}

export interface DiscussionThreadMarkedAsAnswerEvent {
  thread_id: number;
  root_thread_id: number;
  course_id: number;
}

export interface DiscussionThreadWatchedEvent {
  thread_id: number;
  course_id: number;
  is_watching: boolean;
}

export interface DiscussionThreadPinnedEvent {
  thread_id: number;
  course_id: number;
  is_pinned: boolean;
}

export interface DiscussionThreadLikedEvent {
  thread_id: number;
  course_id: number;
}

// ============================================================================
// REGRADE REQUEST EVENTS
// ============================================================================

export interface RegradeRequestResolvedEvent {
  regrade_request_id: number;
  assignment_id: number;
  course_id: number;
  resolution_time_hours: number;
  points_changed: boolean;
  initial_points: number | null;
  resolved_points: number | null;
}

export interface RegradeRequestEscalatedEvent {
  regrade_request_id: number;
  assignment_id: number;
  course_id: number;
}

export interface RegradeRequestClosedEvent {
  regrade_request_id: number;
  assignment_id: number;
  course_id: number;
  was_appeal_granted: boolean;
}

export interface RegradeRequestCommentAddedEvent {
  regrade_request_id: number;
  submission_id: number;
  assignment_id: number;
  course_id: number;
  author_role: "student" | "instructor" | "grader";
}

// ============================================================================
// GRADEBOOK EVENTS
// ============================================================================

export interface GradebookViewedEvent {
  course_id: number;
  viewer_role: "student" | "instructor" | "grader";
}

export interface GradebookWhatIfUsedEvent {
  course_id: number;
  num_columns_modified: number;
}

export interface GradeExportedEvent {
  course_id: number;
  export_format: string;
  num_students: number;
}

export interface GradebookColumnCreatedEvent {
  course_id: number;
  gradebook_id: number;
  column_type: "assignment" | "calculated" | "manual";
  has_formula: boolean;
}

export interface GradebookColumnSettingsEditedEvent {
  course_id: number;
  gradebook_id: number;
  column_id: number;
  settings_changed: string[];
}

export interface GradebookScoreOverrideEvent {
  course_id: number;
  gradebook_column_id: number;
  student_id: string;
  has_note: boolean;
}

// ============================================================================
// GITHUB INTEGRATION EVENTS
// ============================================================================

export interface GithubAccountLinkedEvent {
  course_id?: number;
  user_id: string;
}

// ============================================================================
// GENERAL USER EVENTS
// ============================================================================

export interface PageViewedEvent {
  page_path: string;
  course_id?: number;
  page_type: "assignment" | "submission" | "gradebook" | "office_hours" | "discussion" | "course_settings" | "other";
}

// ============================================================================
// SURVEY EVENTS
// ============================================================================

export interface SurveyCreatedEvent {
  course_id: number;
  survey_id: string;
  status: "draft" | "published";
  has_due_date: boolean;
  allow_response_editing: boolean;
  has_validation_errors: boolean;
  is_update: boolean;
}

export interface SurveyUpdatedEvent {
  course_id: number;
  survey_id: string;
  status: "draft" | "published" | "closed";
  has_due_date: boolean;
  allow_response_editing: boolean;
  has_validation_errors?: boolean;
}

export interface SurveyPublishedEvent {
  course_id: number;
  survey_id?: string;
  has_validation_errors: boolean;
}

export interface SurveyClosedEvent {
  course_id: number;
  survey_id?: string;
}

export interface SurveyDeletedEvent {
  course_id: number;
  survey_id?: string;
  had_responses: boolean;
  response_count: number;
  soft_delete: boolean;
}

// ============================================================================
// EVENT MAP (for type safety)
// ============================================================================

export interface AnalyticsEventMap {
  // Assignments & Submissions
  assignment_viewed: AssignmentViewedEvent;
  late_token_consumed: LateTokenConsumedEvent;
  assignment_created: AssignmentCreatedEvent;

  // Grading
  grading_started: GradingStartedEvent;
  grading_completed: GradingCompletedEvent;
  rubric_check_applied: RubricCheckAppliedEvent;
  grades_released: GradesReleasedEvent;

  // Office Hours
  help_request_created: HelpRequestCreatedEvent;
  help_request_resolved: HelpRequestResolvedEvent;
  queue_assignment_started: QueueAssignmentStartedEvent;
  queue_assignment_ended: QueueAssignmentEndedEvent;
  help_request_claimed: HelpRequestClaimedEvent;
  video_call_started: VideoCallStartedEvent;

  // Discussions
  discussion_thread_created: DiscussionThreadCreatedEvent;
  discussion_reply_posted: DiscussionReplyPostedEvent;
  discussion_thread_marked_as_answer: DiscussionThreadMarkedAsAnswerEvent;
  discussion_thread_watched: DiscussionThreadWatchedEvent;
  discussion_thread_pinned: DiscussionThreadPinnedEvent;
  discussion_thread_liked: DiscussionThreadLikedEvent;

  // Regrade Requests
  regrade_request_resolved: RegradeRequestResolvedEvent;
  regrade_request_escalated: RegradeRequestEscalatedEvent;
  regrade_request_closed: RegradeRequestClosedEvent;
  regrade_request_comment_added: RegradeRequestCommentAddedEvent;

  // Gradebook
  gradebook_viewed: GradebookViewedEvent;
  gradebook_what_if_used: GradebookWhatIfUsedEvent;
  grade_exported: GradeExportedEvent;
  gradebook_column_created: GradebookColumnCreatedEvent;
  gradebook_column_settings_edited: GradebookColumnSettingsEditedEvent;
  gradebook_score_override: GradebookScoreOverrideEvent;

  // GitHub Integration
  github_account_linked: GithubAccountLinkedEvent;

  // Surveys
  survey_created: SurveyCreatedEvent;
  survey_updated: SurveyUpdatedEvent;
  survey_published: SurveyPublishedEvent;
  survey_closed: SurveyClosedEvent;
  survey_deleted: SurveyDeletedEvent;

  // General
  page_viewed: PageViewedEvent;
}

export type AnalyticsEventName = keyof AnalyticsEventMap;
