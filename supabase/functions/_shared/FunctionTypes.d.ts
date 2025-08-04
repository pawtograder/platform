import { Database, Json } from "./SupabaseTypes.d.ts";

export type Autograder = Database["public"]["Tables"]["autograder"]["Row"];
export type AutograderRegressionTest = Database["public"]["Tables"]["autograder_regression_test"]["Row"];
export type AutograderWithAssignments = Autograder & {
  assignments: Database["public"]["Tables"]["assignments"]["Row"];
};
export type OutputFormat = "text" | "markdown" | "ansi";

export type AssignmentGroup = Database["public"]["Tables"]["assignment_groups"]["Row"];
export type Notification = Database["public"]["Tables"]["notifications"]["Row"];
export type OutputVisibility =
  | "hidden" // Never shown to students
  | "visible" // Always shown to students
  | "after_due_date" // Shown to students after the due date
  | "after_published"; // Shown to students after grades are published

export type AutograderFeedback = {
  score?: number;
  max_score?: number;
  output: {
    [key in OutputVisibility]?: {
      output: string;
      output_format?: OutputFormat;
    };
  };
  lint: {
    status: "pass" | "fail";
    output: string;
    output_format?: OutputFormat;
  };
  tests: {
    score?: number;
    max_score?: number;
    name: string;
    name_format?: OutputFormat;
    output: string;
    output_format?: OutputFormat;
    hidden_output?: string;
    hidden_output_format?: OutputFormat;
    part?: string;
    hide_until_released?: boolean;
    extra_data?: Json;
  }[];
  artifacts?: {
    name: string;
    path: string; // Local path in the grader container
    data?: object;
  }[];
  annotations?: (FeedbackComment | FeedbackLineComment | FeedbackArtifactComment)[];
};
export type FeedbackComment = {
  author: {
    name: string;
    avatar_url: string;
    flair?: string;
    flair_color?: string;
  };
  message: string;
  points?: number;
  rubric_check_id?: number;
  released: boolean;
};
export type FeedbackLineComment = FeedbackComment & {
  line: number;
  file_name: string;
};
export type FeedbackArtifactComment = FeedbackComment & {
  artifact_name: string;
};
export type GradingScriptResult = {
  ret_code: number;
  output: string;
  execution_time: number;
  feedback: AutograderFeedback;
  grader_sha: string;
  action_ref: string;
  action_repository: string;
  regression_test_repo?: string;
};
export type GradeResponse = {
  is_ok: boolean;
  message: string;
  details_url: string;
  artifacts?: {
    name: string;
    path: string;
    token: string;
  }[];
  supabase_url: string;
  supabase_anon_key: string;
};

export type SubmissionResponse = {
  grader_url: string;
  grader_sha: string;
};
export type RegressionTestRunResponse = {
  regression_test_url: string;
  regression_test_sha: string;
};

export type AddEnrollmentRequest = {
  email: string;
  name: string;
  role: Database["public"]["Enums"]["app_role"];
  courseId: number;
  canvasId?: number;
  classSectionId?: number;
};

export type LiveMeetingForHelpRequestRequest = {
  courseId: number;
  helpRequestId: number;
};

export type LiveMeetingEndRequest = {
  courseId: number;
  helpRequestId: number;
};

export type AssignmentCreateAllReposRequest = {
  courseId: number;
  assignmentId: number;
};
export type ListReposRequest = {
  courseId: number;
  template_only?: boolean;
};

export type ListFilesRequest = {
  courseId: number;
  orgName: string;
  repoName: string;
};
export type FileListing = {
  name: string;
  path: string;
  size: number;
  sha: string;
};

export type GetFileRequest = {
  courseId: number;
  orgName: string;
  repoName: string;
  path: string;
};
export type GithubRepoConfigureWebhookRequest = {
  assignment_id: number;
  new_repo: string;
  watch_type: "grader_solution" | "template_repo";
};

export type AssignmentGroupCreateRequest = {
  name: string;
  course_id: number;
  assignment_id: number;
  invitees: string[];
};

export type GenericResponse = {
  error?: {
    recoverable: boolean;
    message: string;
    details: string;
  };
};

export type AssignmentGroupJoinRequest = {
  assignment_group_id: number;
};
export type AssignmentGroupListUngroupedRequest = {
  course_id: number;
  assignment_id: number;
};
export type AssignmentGroupListUngroupedResponse = {
  profiles: Database["public"]["Tables"]["profiles"]["Row"][];
};

export type AssignmentGroupInstructorMoveStudentRequest = {
  new_assignment_group_id: number | null;
  old_assignment_group_id: number | null;
  profile_id: string;
  class_id: number;
};
export type AssignmentGroupCopyGroupsFromAssignmentRequest = {
  class_id: number;
  source_assignment_id: number;
  target_assignment_id: number;
};
export type RepositoryListCommitsRequest = {
  course_id: number;
  repo_name: string;
  page: number;
};
export type AutograderTriggerGradingWorkflowRequest = {
  repository: string;
  sha: string;
  class_id: number;
};

export type AutograderRerunGraderRequest = {
  submission_ids: number[];
  class_id: number;
};

export type CheckRunStatus = {
  commit_author?: string;
  commit_date?: string;
  created_at?: string;
  created_by?: string;
  started_at?: string;
  completed_at?: string;
  conclusion?: string;
  submission_id?: number;
  requested_at?: string;
};

export type AssignmentGroupInstructorCreateRequest = {
  name: string;
  course_id: number;
  assignment_id: number;
};

export type RepositoryCheckRun = Omit<Database["public"]["Tables"]["repository_check_runs"]["Row"], "status"> & {
  status: CheckRunStatus;
};

export type AssignmentCreateHandoutRepoRequest = {
  assignment_id: number;
  class_id: number;
};

export type AssignmentCreateHandoutRepoResponse = {
  repo_name: string;
  org_name: string;
};

export type AssignmentCreateSolutionRepoRequest = {
  assignment_id: number;
  class_id: number;
};

export type AssignmentCreateSolutionRepoResponse = {
  repo_name: string;
  org_name: string;
};

export type AutograderCreateReposForStudentRequest = {
  user_id?: string; // Optional: if provided, use this user_id instead of JWT auth
  class_id?: number; // Optional: if provided, only create repos for this specific class
};
