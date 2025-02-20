import { Database } from "./SupabaseTypes";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";
export type Assignment = Database["public"]["Tables"]["assignments"]["Row"];

export type Course = Database["public"]["Tables"]["classes"]["Row"];

export type Repo = Database["public"]["Tables"]["repositories"]["Row"];

export type AssignmentWithRepositoryAndSubmissions = GetResult<
    Database["public"],
    Database["public"]["Tables"]["assignments"]["Row"],
    "assignments",
    Database["public"]["Tables"]["assignments"]["Relationships"],
    "*, submissions(*), repositories(*)"
>;
export type SubmissionFileWithComments = GetResult<
    Database["public"],
    Database["public"]["Tables"]["submission_files"]["Row"],
    "submission_files",
    Database["public"]["Tables"]["submission_files"]["Relationships"],
    "*, submission_file_comments(*, public_profiles(*))"
>;
export type SubmissionWithFilesAndComments = GetResult<
    Database["public"],
    Database["public"]["Tables"]["submissions"]["Row"],
    "submissions",
    Database["public"]["Tables"]["submissions"]["Relationships"],
    "*, assignments(*), submission_files(*, submission_file_comments(*, public_profiles(*)))"
>;
export type SubmissionWithGraderResults = GetResult<
    Database["public"],
    Database["public"]["Tables"]["submissions"]["Row"],
    "submissions",
    Database["public"]["Tables"]["submissions"]["Relationships"],
    "*, assignments(*), grader_results(*), grader_result_tests(*), grader_result_output(*)"
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

export type ThreadWithChildren = DiscussionThreadWithAuthorAndTopic & {
    children: ThreadWithChildren[]
}

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