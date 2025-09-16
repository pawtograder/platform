import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { Database, Json } from "./SupabaseTypes";
export type { Json };

export type GradebookColumnExternalData = {
  source: "csv";
  fileName: string;
  date: string;
  creator: string;
};

export type PyretReplConfig = {
  initial_code?: string;
  initial_interactions?: string[];
  repl_contents?: string;
};

export type LLMRateLimitConfig = {
  cooldown?: number;
  assignment_total?: number;
  class_total?: number;
};

export type GraderResultTestExtraData = {
  llm?: {
    prompt: string;
    result?: string;
    model?: string;
    account?: string;
    provider?: "openai" | "azure" | "anthropic";
    temperature?: number;
    max_tokens?: number;
    rate_limit?: LLMRateLimitConfig;
    type: "v1";
  };
  hide_score?: string;
  icon?: string;
  pyret_repl?: PyretReplConfig;
};

export type GraderResultTestsHintFeedback = Database["public"]["Tables"]["grader_result_tests_hint_feedback"]["Row"];
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];

export type AssignmentWithRubricsAndReferences = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignments"]["Row"],
  "assignments",
  Database["public"]["Tables"]["assignments"]["Relationships"],
  "*, assignment_self_review_settings(*), rubrics!rubrics_assignment_id_fkey(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*, rubric_criteria(is_additive, rubric_id), rubric_check_references!referencing_rubric_check_id(*)))))"
>;

export type AggregatedSubmissions = Database["public"]["Views"]["submissions_agg"]["Row"];
export type ActiveSubmissionsWithGradesForAssignment =
  Database["public"]["Views"]["submissions_with_grades_for_assignment"]["Row"] & {
    id: number;
  };
export type ActiveSubmissionsWithRegressionTestResults =
  Database["public"]["Views"]["submissions_with_grades_for_assignment_and_regression_test"]["Row"] & {
    id: number;
  };
export type AuditEvent = Database["public"]["Tables"]["audit"]["Row"];
export type Course = Database["public"]["Tables"]["classes"]["Row"];
export type CourseWithFeatures = Omit<Course, "features"> & {
  features: { name: string; enabled: boolean }[];
};
export type AssignmentGroup = Database["public"]["Tables"]["assignment_groups"]["Row"];
export type AssignmentGroupMember = Database["public"]["Tables"]["assignment_groups_members"]["Row"];
export type AssignmentGroupMembersWithGroup = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignment_groups_members"]["Row"],
  "assignment_groups_members",
  Database["public"]["Tables"]["assignment_groups_members"]["Relationships"],
  "*, assignment_groups(*)"
>;
export type AssignmentGroupJoinRequest = Database["public"]["Tables"]["assignment_groups_join_requests"]["Row"];
export type AssignmentGroupInvitation = Database["public"]["Tables"]["assignment_group_invitations"]["Row"];
export type AssignmentGroupMembersWithGroupMembersInvitationsAndJoinRequests = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignment_groups_members"]["Row"],
  "assignment_groups_members",
  Database["public"]["Tables"]["assignment_groups_members"]["Relationships"],
  "*, assignment_groups(*, assignment_groups_members(*), assignment_group_invitations(*), assignment_group_join_request(*))"
>;
export type AssignmentGroupWithMembersInvitationsAndJoinRequests = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignment_groups"]["Row"],
  "assignment_groups",
  Database["public"]["Tables"]["assignment_groups"]["Relationships"],
  "*, assignment_groups_members(*), assignment_group_invitations(*), assignment_group_join_request(*)"
>;
export type Notification = GetResult<
  Database["public"],
  Database["public"]["Tables"]["notifications"]["Row"],
  "notifications",
  Database["public"]["Tables"]["notifications"]["Relationships"],
  "*"
>;
export type NotificationPreferences = GetResult<
  Database["public"],
  Database["public"]["Tables"]["notification_preferences"]["Row"],
  "notification_preferences",
  Database["public"]["Tables"]["notification_preferences"]["Relationships"],
  "*"
>;
export type Submission = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submissions"]["Row"],
  "submissions",
  Database["public"]["Tables"]["submissions"]["Relationships"],
  "*"
>;
export type SubmissionWithFiles = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submissions"]["Row"],
  "submissions",
  Database["public"]["Tables"]["submissions"]["Relationships"],
  "*, submission_files(*), assignment_groups(*, assignment_groups_members(*, profiles!profile_id(*)))"
>;
export type SubmissionFileComment = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submission_file_comments"]["Row"],
  "submission_file_comments",
  Database["public"]["Tables"]["submission_file_comments"]["Relationships"],
  "*"
>;
export type UserRole = GetResult<
  Database["public"],
  Database["public"]["Tables"]["user_roles"]["Row"],
  "user_roles",
  Database["public"]["Tables"]["user_roles"]["Relationships"],
  "*"
>;
export type UserRoleWithUser = GetResult<
  Database["public"],
  Database["public"]["Tables"]["user_roles"]["Row"],
  "user_roles",
  Database["public"]["Tables"]["user_roles"]["Relationships"],
  "*, users(*)"
>;

export type UserRoleWithPrivateProfileAndUser = GetResult<
  Database["public"],
  Database["public"]["Tables"]["user_roles"]["Row"],
  "user_roles",
  Database["public"]["Tables"]["user_roles"]["Relationships"],
  "*, profiles!private_profile_id(*), users(*)"
>;
export type UserRoleWithCourse = GetResult<
  Database["public"],
  Database["public"]["Tables"]["user_roles"]["Row"],
  "user_roles",
  Database["public"]["Tables"]["user_roles"]["Relationships"],
  "*, classes(*)"
>;
export type UserRoleWithCourseAndUser = GetResult<
  Database["public"],
  Database["public"]["Tables"]["user_roles"]["Row"],
  "user_roles",
  Database["public"]["Tables"]["user_roles"]["Relationships"],
  "*, classes(*), users(*)"
>;

export type Repo = Database["public"]["Tables"]["repositories"]["Row"];

export type SubmissionFile = Database["public"]["Tables"]["submission_files"]["Row"];

export type AssignmentWithRepositoryAndSubmissionsAndGraderResults = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignments"]["Row"],
  "assignments",
  Database["public"]["Tables"]["assignments"]["Relationships"],
  "*, submissions(*, grader_results(*)), repositories(*)"
>;
export type SubmissionFileWithComments = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submission_files"]["Row"],
  "submission_files",
  Database["public"]["Tables"]["submission_files"]["Relationships"],
  "*, submission_file_comments(*, profiles(*))"
>;
export type SubmissionComments = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submission_comments"]["Row"],
  "submission_comments",
  Database["public"]["Tables"]["submission_comments"]["Relationships"],
  "*"
>;
export type SubmissionWithFilesAndComments = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submissions"]["Row"],
  "submissions",
  Database["public"]["Tables"]["submissions"]["Relationships"],
  "*, assignments(*), submission_files(*, submission_file_comments(*, profiles(*))), assignment_groups(*, assignment_groups_members(*, profiles!profile_id(*)))"
>;
export type SubmissionArtifact = Omit<
  GetResult<
    Database["public"],
    Database["public"]["Tables"]["submission_artifacts"]["Row"],
    "submission_artifacts",
    Database["public"]["Tables"]["submission_artifacts"]["Relationships"],
    "*"
  >,
  "data"
> & {
  data: SubmissionArtifactDataType;
};
export type SubmissionArtifactDataType = {
  format: string;
  display: string;
};
export type SubmissionArtifactComment = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submission_artifact_comments"]["Row"],
  "submission_artifact_comments",
  Database["public"]["Tables"]["submission_artifact_comments"]["Relationships"],
  "*"
>;
export type SubmissionReview = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submission_reviews"]["Row"],
  "submission_reviews",
  Database["public"]["Tables"]["submission_reviews"]["Relationships"],
  "*"
>;
export type SubmissionReviewWithRubric = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submission_reviews"]["Row"],
  "submission_reviews",
  Database["public"]["Tables"]["submission_reviews"]["Relationships"],
  "*, rubrics(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*))))"
>;
export type SubmissionWithFilesGraderResultsOutputTestsAndRubric = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submissions"]["Row"],
  "submissions",
  Database["public"]["Tables"]["submissions"]["Relationships"],
  "*, assignment_groups(*, assignment_groups_members(*, profiles!profile_id(*))), assignments(*, rubrics!grading_rubric_id(*,rubric_criteria(*,rubric_checks(*)))), grader_results(*, grader_result_tests(*), grader_result_output(*)), submission_files(*), submission_artifacts(*)"
>;
export type SubmissionWithGraderResultsAndReview = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submissions"]["Row"],
  "submissions",
  Database["public"]["Tables"]["submissions"]["Relationships"],
  "*, assignments(*), grader_results(*, grader_result_tests(*), grader_result_output(*)), submission_reviews(*)"
>;
export type SubmissionWithGraderResults = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submissions"]["Row"],
  "submissions",
  Database["public"]["Tables"]["submissions"]["Relationships"],
  "*, assignments(*), grader_results(*, grader_result_tests(*, grader_result_test_output(*)), grader_result_output(*))"
>;
export type SubmissionWithGraderResultsAndErrors = GetResult<
  Database["public"],
  Database["public"]["Tables"]["submissions"]["Row"],
  "submissions",
  Database["public"]["Tables"]["submissions"]["Relationships"],
  "*, assignments(*), grader_results(*, grader_result_tests(*, grader_result_test_output(*)), grader_result_output(*)), workflow_run_error(*)"
>;
export type GraderResultTest = GetResult<
  Database["public"],
  Database["public"]["Tables"]["grader_result_tests"]["Row"],
  "grader_result_tests",
  Database["public"]["Tables"]["grader_result_tests"]["Relationships"],
  "*"
>;
export type GraderResultOutput = GetResult<
  Database["public"],
  Database["public"]["Tables"]["grader_result_output"]["Row"],
  "grader_result_output",
  Database["public"]["Tables"]["grader_result_output"]["Relationships"],
  "*"
>;

export type DiscussionThreadWithAuthorAndTopic = GetResult<
  Database["public"],
  Database["public"]["Tables"]["discussion_threads"]["Row"],
  "discussion_threads",
  Database["public"]["Tables"]["discussion_threads"]["Relationships"],
  "*, public_profiles(*), discussion_topics(*)"
>;

export type DiscussionThread = GetResult<
  Database["public"],
  Database["public"]["Tables"]["discussion_threads"]["Row"],
  "discussion_threads",
  Database["public"]["Tables"]["discussion_threads"]["Relationships"],
  "*"
>;
export type DiscussionThreadWatcher = GetResult<
  Database["public"],
  Database["public"]["Tables"]["discussion_thread_watchers"]["Row"],
  "discussion_thread_watchers",
  Database["public"]["Tables"]["discussion_thread_watchers"]["Relationships"],
  "*"
>;
export type DiscussionThreadReadStatus = GetResult<
  Database["public"],
  Database["public"]["Tables"]["discussion_thread_read_status"]["Row"],
  "discussion_thread_read_status",
  Database["public"]["Tables"]["discussion_thread_read_status"]["Relationships"],
  "*"
>;

export type ThreadWithChildren = DiscussionThread & {
  children: ThreadWithChildren[];
};

export type RubricWithCriteriaAndChecks = GetResult<
  Database["public"],
  Database["public"]["Tables"]["rubrics"]["Row"],
  "rubrics",
  Database["public"]["Tables"]["rubrics"]["Relationships"],
  "*, rubric_criteria(*, rubric_checks(*))"
>;
export type RubricCriteriaWithRubricChecks = GetResult<
  Database["public"],
  Database["public"]["Tables"]["rubric_criteria"]["Row"],
  "rubric_criteria",
  Database["public"]["Tables"]["rubric_criteria"]["Relationships"],
  "*, rubric_checks(*)"
>;
export type RubricCriteria = GetResult<
  Database["public"],
  Database["public"]["Tables"]["rubric_criteria"]["Row"],
  "rubric_criteria",
  Database["public"]["Tables"]["rubric_criteria"]["Relationships"],
  "*"
>;
export type RubricChecks = GetResult<
  Database["public"],
  Database["public"]["Tables"]["rubric_checks"]["Row"],
  "rubric_checks",
  Database["public"]["Tables"]["rubric_checks"]["Relationships"],
  "*"
>;

export type RubricReviewRound = Database["public"]["Enums"]["review_round"];

export type Rubric = GetResult<
  Database["public"],
  Database["public"]["Tables"]["rubrics"]["Row"],
  "rubrics",
  Database["public"]["Tables"]["rubrics"]["Relationships"],
  "*"
>;

export type DiscussionTopic = GetResult<
  Database["public"],
  Database["public"]["Tables"]["discussion_topics"]["Row"],
  "discussion_topics",
  Database["public"]["Tables"]["discussion_topics"]["Relationships"],
  "*"
>;

export type HelpQueue = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_queues"]["Row"],
  "help_queues",
  Database["public"]["Tables"]["help_queues"]["Relationships"],
  "*"
>;

export type HelpQueueAssignment = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_queue_assignments"]["Row"],
  "help_queue_assignments",
  Database["public"]["Tables"]["help_queue_assignments"]["Relationships"],
  "*"
>;

export type HelpRequest = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_requests"]["Row"],
  "help_requests",
  Database["public"]["Tables"]["help_requests"]["Relationships"],
  "*"
>;

export type HelpRequestStudent = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_students"]["Row"],
  "help_request_students",
  Database["public"]["Tables"]["help_request_students"]["Relationships"],
  "*"
>;

export type HelpRequestModeration = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_moderation"]["Row"],
  "help_request_moderation",
  Database["public"]["Tables"]["help_request_moderation"]["Relationships"],
  "*"
>;

export type HelpRequestMessageReadReceipt = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_message_read_receipts"]["Row"],
  "help_request_message_read_receipts",
  Database["public"]["Tables"]["help_request_message_read_receipts"]["Relationships"],
  "*"
>;

export type HelpRequestLocationType = Database["public"]["Enums"]["location_type"];

export type HelpRequestTemplate = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_templates"]["Row"],
  "help_request_templates",
  Database["public"]["Tables"]["help_request_templates"]["Relationships"],
  "*"
>;

export type HelpRequestModeration = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_moderation"]["Row"],
  "help_request_moderation",
  Database["public"]["Tables"]["help_request_moderation"]["Relationships"],
  "*"
>;

export type HelpRequestFeedback = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_feedback"]["Row"],
  "help_request_feedback",
  Database["public"]["Tables"]["help_request_feedback"]["Relationships"],
  "*"
>;

export type StudentKarmaNotes = GetResult<
  Database["public"],
  Database["public"]["Tables"]["student_karma_notes"]["Row"],
  "student_karma_notes",
  Database["public"]["Tables"]["student_karma_notes"]["Relationships"],
  "*"
>;

export type VideoMeetingSession = GetResult<
  Database["public"],
  Database["public"]["Tables"]["video_meeting_sessions"]["Row"],
  "video_meeting_sessions",
  Database["public"]["Tables"]["video_meeting_sessions"]["Relationships"],
  "*"
>;

export type StudentHelpActivity = GetResult<
  Database["public"],
  Database["public"]["Tables"]["student_help_activity"]["Row"],
  "student_help_activity",
  Database["public"]["Tables"]["student_help_activity"]["Relationships"],
  "*"
>;

export type HelpRequestWatcher = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_watchers"]["Row"],
  "help_request_watchers",
  Database["public"]["Tables"]["help_request_watchers"]["Relationships"],
  "*"
>;

export type OfficeHoursBroadcastMessage = {
  type: "table_change" | "staff_data_change" | "queue_change" | "channel_created" | "system";
  operation?: "INSERT" | "UPDATE" | "DELETE";
  table?: string;
  row_id?: number | string;
  data?: Record<string, unknown>;
  help_request_id?: number;
  help_queue_id?: number;
  class_id: number;
  student_profile_id?: string;
  timestamp: string;
};

export type HelpRequestDataChangeMessage = OfficeHoursBroadcastMessage & {
  type: "table_change";
  operation: "INSERT" | "UPDATE" | "DELETE";
  table:
    | "help_requests"
    | "help_request_messages"
    | "help_request_message_read_receipts"
    | "help_request_file_references"
    | "help_request_students";
  help_request_id: number;
};

export type HelpRequestStaffDataChangeMessage = OfficeHoursBroadcastMessage & {
  type: "staff_data_change";
  operation: "INSERT" | "UPDATE" | "DELETE";
  table: "help_request_moderation" | "student_karma_notes";
  student_profile_id: string;
  help_request_id?: number;
};

export type HelpQueueDataChangeMessage = OfficeHoursBroadcastMessage & {
  type: "queue_change";
  operation: "INSERT" | "UPDATE" | "DELETE";
  table: "help_queues" | "help_queue_assignments" | "help_requests";
  help_queue_id: number;
};

/**
 * Channel subscription filter options for office hours
 */
export type OfficeHoursMessageFilter = {
  type?: OfficeHoursBroadcastMessage["type"];
  table?: string;
  help_request_id?: number;
  help_queue_id?: number;
  student_profile_id?: string;
};

export type OfficeHoursMessageCallback = (message: OfficeHoursBroadcastMessage) => void;

export type OfficeHoursSubscription = {
  id: string;
  filter: OfficeHoursMessageFilter;
  callback: OfficeHoursMessageCallback;
};

export type HelpRequestWithStudentCount = HelpRequest & {
  student_count: number;
};

export type UserProfile = GetResult<
  Database["public"],
  Database["public"]["Tables"]["profiles"]["Row"],
  "profiles",
  Database["public"]["Tables"]["profiles"]["Relationships"],
  "*"
>;
export type UserProfileWithTags = GetResult<
  Database["public"],
  Database["public"]["Tables"]["profiles"]["Row"],
  "profiles",
  Database["public"]["Tables"]["profiles"]["Relationships"],
  "*, tags_profiles(*, tags(*))"
>;

export type UserProfileWithUser = GetResult<
  Database["public"],
  Database["public"]["Tables"]["profiles"]["Row"],
  "profiles",
  Database["public"]["Tables"]["profiles"]["Relationships"],
  "*, users(*)"
>;

export type HelpRequestMessageReadReceipt = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_message_read_receipts"]["Row"],
  "help_request_message_read_receipts",
  Database["public"]["Tables"]["help_request_message_read_receipts"]["Relationships"],
  "*"
>;

export type HelpRequestMessage = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_messages"]["Row"],
  "help_request_messages",
  Database["public"]["Tables"]["help_request_messages"]["Relationships"],
  "*"
>;

export type HelpRequestMessageWithoutId = Omit<HelpRequestMessage, "id">;

export type HelpRequestMessageWithReadReceipts = HelpRequestMessage & {
  read_receipts: HelpRequestMessageReadReceipt[];
};

export type HelpRequestFileReference = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_file_references"]["Row"],
  "help_request_file_references",
  Database["public"]["Tables"]["help_request_file_references"]["Relationships"],
  "*"
>;

export type DiscussionThreadLike = GetResult<
  Database["public"],
  Database["public"]["Tables"]["discussion_thread_likes"]["Row"],
  "discussion_thread_likes",
  Database["public"]["Tables"]["discussion_thread_likes"]["Relationships"],
  "*"
>;

export type AutograderWithAssignment = GetResult<
  Database["public"],
  Database["public"]["Tables"]["autograder"]["Row"],
  "autograder",
  Database["public"]["Tables"]["autograder"]["Relationships"],
  "*, assignments(*)"
>;

export type Autograder = GetResult<
  Database["public"],
  Database["public"]["Tables"]["autograder"]["Row"],
  "autograder",
  Database["public"]["Tables"]["autograder"]["Relationships"],
  "*"
>;

export type AutograderCommit = GetResult<
  Database["public"],
  Database["public"]["Tables"]["autograder_commits"]["Row"],
  "autograder_commits",
  Database["public"]["Tables"]["autograder_commits"]["Relationships"],
  "*"
>;

export type AutograderRegressionTest = GetResult<
  Database["public"],
  Database["public"]["Tables"]["autograder_regression_tests"]["Row"],
  "autograder_regression_tests",
  Database["public"]["Tables"]["autograder_regression_tests"]["Relationships"],
  "*"
>;

export type Repository = GetResult<
  Database["public"],
  Database["public"]["Tables"]["repositories"]["Row"],
  "repositories",
  Database["public"]["Tables"]["repositories"]["Relationships"],
  "*"
>;

export type RepositoryWithSubmissionsAndGraderResults = GetResult<
  Database["public"],
  Database["public"]["Tables"]["repositories"]["Row"],
  "repositories",
  Database["public"]["Tables"]["repositories"]["Relationships"],
  "*, submissions(*, grader_results(*))"
>;

export type PollQuestionWithAnswers = GetResult<
  Database["public"],
  Database["public"]["Tables"]["poll_questions"]["Row"],
  "poll_questions",
  Database["public"]["Tables"]["poll_questions"]["Relationships"],
  "*, poll_question_answers(*)"
>;

export type PollQuestionAnswer = GetResult<
  Database["public"],
  Database["public"]["Tables"]["poll_question_answers"]["Row"],
  "poll_question_answers",
  Database["public"]["Tables"]["poll_question_answers"]["Relationships"],
  "*"
>;

export type PollQuestionResult = GetResult<
  Database["public"],
  Database["public"]["Tables"]["poll_question_results"]["Row"],
  "poll_question_results",
  Database["public"]["Tables"]["poll_question_results"]["Relationships"],
  "*"
>;

export type PollResponseAnswer = GetResult<
  Database["public"],
  Database["public"]["Tables"]["poll_response_answers"]["Row"],
  "poll_response_answers",
  Database["public"]["Tables"]["poll_response_answers"]["Relationships"],
  "*"
>;

export type LegacyRubricWithCriteriaAndChecks = GetResult<
  Database["public"],
  Database["public"]["Tables"]["rubrics"]["Row"],
  "rubrics",
  Database["public"]["Tables"]["rubrics"]["Relationships"],
  "*, rubric_criteria(*, rubric_checks(*))"
>;
export type HydratedRubric = Rubric & {
  rubric_parts: HydratedRubricPart[];
};
export type RubricPart = Database["public"]["Tables"]["rubric_parts"]["Row"];
export type RubricCriteria = Database["public"]["Tables"]["rubric_criteria"]["Row"];
export type RubricCheck = Database["public"]["Tables"]["rubric_checks"]["Row"];

export type HydratedRubricPart = Omit<Database["public"]["Tables"]["rubric_parts"]["Row"], "data"> & {
  rubric_criteria: HydratedRubricCriteria[];
  data?: RubricPartsDataType;
};
export type HydratedRubricCriteria = Omit<Database["public"]["Tables"]["rubric_criteria"]["Row"], "data"> & {
  rubric_checks: HydratedRubricCheck[];
  data?: RubricCriteriaDataType;
};
export type RubricCriteriaDataType = Json;
export type HydratedRubricCheck = Omit<
  Database["public"]["Tables"]["rubric_checks"]["Row"],
  "data" | "student_visibility"
> & {
  data?: Json;
  student_visibility?: Database["public"]["Enums"]["rubric_check_student_visibility"];
};
export type RubricChecksDataType = {
  options: {
    label: string;
    description?: string;
    points: number;
  }[];
};
export type HydratedRubricParts = Database["public"]["Tables"]["rubric_parts"]["Row"] & {
  rubric_criteria: HydratedRubricCriteria[];
  data: RubricPartsDataType;
};
export type RubricPartsDataType = Json;

export type YmlRubricType = Omit<
  HydratedRubric,
  "id" | "description" | "rubric_parts" | "class_id" | "created_at" | "assignment_id" | "review_round" | "is_private"
> & {
  parts: YmlRubricPartType[];
  description?: string;
};
export type YmlRubricPartType = Omit<
  HydratedRubricPart,
  "id" | "rubric_criteria" | "description" | "ordinal" | "class_id" | "created_at" | "rubric_id"
> & {
  criteria: YmlRubricCriteriaType[];
  id?: number;
  description?: string;
};
export type YmlRubricCriteriaType = Omit<
  HydratedRubricCriteria,
  | "id"
  | "class_id"
  | "rubric_checks"
  | "ordinal"
  | "created_at"
  | "rubric_id"
  | "rubric_part_id"
  | "description"
  | "is_additive"
  | "max_checks_per_submission"
  | "min_checks_per_submission"
  | "total_points"
> & {
  checks: YmlRubricChecksType[];
  id?: number;
  description?: string;
  is_additive?: boolean;
  max_checks_per_submission?: number;
  min_checks_per_submission?: number;
  total_points?: number;
};
export type YmlRubricChecksType = Omit<
  HydratedRubricCheck,
  | "id"
  | "class_id"
  | "ordinal"
  | "created_at"
  | "group"
  | "rubric_criteria_id"
  | "rubric_parts"
  | "description"
  | "file"
  | "max_annotations"
  | "artifact"
  | "annotation_target"
  | "data"
> & {
  id?: number;
  description?: string;
  file?: string;
  artifact?: string;
  max_annotations?: number;
  annotation_target?: "file" | "artifact";
  data?: RubricChecksDataType;
};

export type AssignmentDueDateException = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignment_due_date_exceptions"]["Row"],
  "assignment_due_date_exceptions",
  Database["public"]["Tables"]["assignment_due_date_exceptions"]["Relationships"],
  "*"
>;

export type ClassSection = GetResult<
  Database["public"],
  Database["public"]["Tables"]["class_sections"]["Row"],
  "class_sections",
  Database["public"]["Tables"]["class_sections"]["Relationships"],
  "*"
>;

export type Tag = GetResult<
  Database["public"],
  Database["public"]["Tables"]["tags"]["Row"],
  "tags",
  Database["public"]["Tables"]["tags"]["Relationships"],
  "*"
>;

export type RubricCheckReference = GetResult<
  Database["public"],
  Database["public"]["Tables"]["rubric_check_references"]["Row"],
  "rubric_check_references",
  Database["public"]["Tables"]["rubric_check_references"]["Relationships"],
  "*"
>;

export type EmailDistributionList = GetResult<
  Database["public"],
  Database["public"]["Tables"]["email_distribution_list"]["Row"],
  "email_distribution_list",
  Database["public"]["Tables"]["email_distribution_list"]["Relationships"],
  "*"
>;

export type EmailDistributionItem = GetResult<
  Database["public"],
  Database["public"]["Tables"]["email_distribution_item"]["Row"],
  "email_distribution_item",
  Database["public"]["Tables"]["email_distribution_item"]["Relationships"],
  "*"
>;

export type GradebookColumnDependencies = {
  assignments?: int[];
  gradebook_columns?: int[];
};
export type GradebookWithAllData = GetResult<
  Database["public"],
  Database["public"]["Tables"]["gradebooks"]["Row"],
  "gradebooks",
  Database["public"]["Tables"]["gradebooks"]["Relationships"],
  "*, gradebook_columns!gradebook_columns_gradebook_id_fkey(*, gradebook_column_students(*))"
>;

type _GradebookColumnWithEntries = GetResult<
  Database["public"],
  Database["public"]["Tables"]["gradebook_columns"]["Row"],
  "gradebook_columns",
  Database["public"]["Tables"]["gradebook_columns"]["Relationships"],
  "*, gradebook_column_students(*)"
>;
export type GradebookColumnWithEntries = Omit<_GradebookColumnWithEntries, "dependencies"> & {
  dependencies: GradebookColumnDependencies | null;
};
export type Gradebook = Database["public"]["Tables"]["gradebooks"]["Row"];
export type GradebookColumn = Database["public"]["Tables"]["gradebook_columns"]["Row"];
export type GradebookColumnStudent = Database["public"]["Tables"]["gradebook_column_students"]["Row"];

/**
 * Flashcard Deck Types
 */
export type FlashcardDeck = GetResult<
  Database["public"],
  Database["public"]["Tables"]["flashcard_decks"]["Row"],
  "flashcard_decks",
  Database["public"]["Tables"]["flashcard_decks"]["Relationships"],
  "*"
>;

export type Flashcard = GetResult<
  Database["public"],
  Database["public"]["Tables"]["flashcards"]["Row"],
  "flashcards",
  Database["public"]["Tables"]["flashcards"]["Relationships"],
  "*"
>;

export type FlashcardDeckWithCards = GetResult<
  Database["public"],
  Database["public"]["Tables"]["flashcard_decks"]["Row"],
  "flashcard_decks",
  Database["public"]["Tables"]["flashcard_decks"]["Relationships"],
  "*, flashcards(*)"
>;

export type StudentFlashcardDeckProgress = GetResult<
  Database["public"],
  Database["public"]["Tables"]["student_flashcard_deck_progress"]["Row"],
  "student_flashcard_deck_progress",
  Database["public"]["Tables"]["student_flashcard_deck_progress"]["Relationships"],
  "*"
>;

export type FlashcardInteractionLog = GetResult<
  Database["public"],
  Database["public"]["Tables"]["flashcard_interaction_logs"]["Row"],
  "flashcard_interaction_logs",
  Database["public"]["Tables"]["flashcard_interaction_logs"]["Relationships"],
  "*"
>;

export type SelfReviewSettings = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignment_self_review_settings"]["Row"],
  "self_review_settings",
  Database["public"]["Tables"]["assignment_self_review_settings"]["Relationships"],
  "*"
>;

export type ReviewAssignments = GetResult<
  Database["public"],
  Database["public"]["Tables"]["review_assignments"]["Row"],
  "review_assignments",
  Database["public"]["Tables"]["review_assignments"]["Relationships"],
  "*"
>;
export type ReviewAssignmentParts = GetResult<
  Database["public"],
  Database["public"]["Tables"]["review_assignment_rubric_parts"]["Row"],
  "review_assignment_rubric_parts",
  Database["public"]["Tables"]["review_assignment_rubric_parts"]["Relationships"],
  "*"
>;

export type Emails = GetResult<
  Database["public"],
  Database["public"]["Tables"]["emails"]["Row"],
  "emails",
  Database["public"]["Tables"]["emails"]["Relationships"],
  "*"
>;

export type EmailBatches = GetResult<
  Database["public"],
  Database["public"]["Tables"]["email_batches"]["Row"],
  "email_batches",
  Database["public"]["Tables"]["email_batches"]["Relationships"],
  "*"
>;

export type Course = GetResult<
  Database["public"],
  Database["public"]["Tables"]["classes"]["Row"],
  "classes",
  Database["public"]["Tables"]["classes"]["Relationships"],
  "*"
>;

// Lab Sections Types
export type LabSection = GetResult<
  Database["public"],
  Database["public"]["Tables"]["lab_sections"]["Row"],
  "lab_sections",
  Database["public"]["Tables"]["lab_sections"]["Relationships"],
  "*"
>;

export type LabSectionMeeting = GetResult<
  Database["public"],
  Database["public"]["Tables"]["lab_section_meetings"]["Row"],
  "lab_section_meetings",
  Database["public"]["Tables"]["lab_section_meetings"]["Relationships"],
  "*"
>;

export type LabSectionWithLeader = GetResult<
  Database["public"],
  Database["public"]["Tables"]["lab_sections"]["Row"],
  "lab_sections",
  Database["public"]["Tables"]["lab_sections"]["Relationships"],
  "*, profiles!lab_sections_lab_leader_id_fkey(*)"
>;

export type LabSectionWithMeetings = GetResult<
  Database["public"],
  Database["public"]["Tables"]["lab_sections"]["Row"],
  "lab_sections",
  Database["public"]["Tables"]["lab_sections"]["Relationships"],
  "*, lab_section_meetings(*)"
>;

export type DayOfWeek = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";

export type RegradeStatus = Database["public"]["Enums"]["regrade_status"];
export type RegradeRequest = Database["public"]["Tables"]["submission_regrade_requests"]["Row"];
export type RegradeRequestComment = Database["public"]["Tables"]["submission_regrade_request_comments"]["Row"];

export type AdminGetClassesResponse = Database["public"]["Functions"]["admin_get_classes"]["Returns"];

export type StudentDeadlineExtension = GetResult<
  Database["public"],
  Database["public"]["Tables"]["student_deadline_extensions"]["Row"],
  "student_deadline_extensions",
  Database["public"]["Tables"]["student_deadline_extensions"]["Relationships"],
  "*"
>;
