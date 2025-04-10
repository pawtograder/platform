import { Database } from "./SupabaseTypes";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];

export type AggregatedSubmissions = Database["public"]["Views"]["submissions_agg"]["Row"];
export type ActiveSubmissionsWithGradesForAssignment = 
Database["public"]["Views"]["submissions_with_grades_for_assignment"]["Row"] & {
    id: number;
};
export type AuditEvent = Database["public"]["Tables"]["audit"]["Row"];
export type Course = Database["public"]["Tables"]["classes"]["Row"];
export type AssignmentGroup = Database["public"]["Tables"]["assignment_groups"]["Row"];
export type AssignmentGroupMember = Database["public"]["Tables"]["assignment_groups_members"]["Row"];
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
export type SubmissionReviewWithRubric = GetResult<
    Database["public"],
    Database["public"]["Tables"]["submission_reviews"]["Row"],
    "submission_reviews",
    Database["public"]["Tables"]["submission_reviews"]["Relationships"],
    "*, rubrics(*, rubric_criteria(*, rubric_checks(*)))"
>;
export type SubmissionWithFilesGraderResultsOutputTestsAndRubric= GetResult<
    Database["public"],
    Database["public"]["Tables"]["submissions"]["Row"],
    "submissions",
    Database["public"]["Tables"]["submissions"]["Relationships"],
    "*, assignment_groups(*, assignment_groups_members(*, profiles!profile_id(*))), assignments(*, rubrics(*,rubric_criteria(*,rubric_checks(*)))), grader_results(*, grader_result_tests(*), grader_result_output(*)), submission_files(*)"
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
    "*, assignments(*), grader_results(*, grader_result_tests(*), grader_result_output(*))"
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
    children: ThreadWithChildren[]
}

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
