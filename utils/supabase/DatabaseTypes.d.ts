import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
import { Database, Json } from "./SupabaseTypes";
export type { Json };
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];

export type AssignmentWithRubricsAndReferences = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignments"]["Row"],
  "assignments",
  Database["public"]["Tables"]["assignments"]["Relationships"],
  "*, assignment_self_review_settings(*), review_assignments!review_assignments_assignment_id_fkey(*), rubrics!rubrics_assignment_id_fkey(*, rubric_parts(*, rubric_criteria(*, rubric_checks(*, rubric_criteria(is_additive, rubric_id), rubric_check_references!referencing_rubric_check_id(*)))))"
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
export type SubmissionWithAllRelatedData = SubmissionWithFilesGraderResultsOutputTestsAndRubric & {
  submission_file_comments: SubmissionFileComment[];
  submission_comments: SubmissionComments[];
  submission_reviews: SubmissionReviewWithRubric[];
  submission_artifact_comments: SubmissionArtifactComment[];
};
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

export type HelpRequest = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_requests"]["Row"],
  "help_requests",
  Database["public"]["Tables"]["help_requests"]["Relationships"],
  "*"
>;

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
export type HelpRequestMessage = GetResult<
  Database["public"],
  Database["public"]["Tables"]["help_request_messages"]["Row"],
  "help_request_messages",
  Database["public"]["Tables"]["help_request_messages"]["Relationships"],
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
export type HydratedRubricCheck = Omit<Database["public"]["Tables"]["rubric_checks"]["Row"], "data"> & {
  data?: Json;
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
> & {
  id?: number;
  description?: string;
  file?: string;
  artifact?: string;
  max_annotations?: number;
  annotation_target?: "file" | "artifact";
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

export type SelfReviewSettings = GetResult<
  Database["public"],
  Database["public"]["Tables"]["assignment_self_review_settings"]["Row"],
  "self_review_settings",
  Database["public"]["Tables"]["assignment_self_review_settings"]["Relationships"],
  "*"
>;
