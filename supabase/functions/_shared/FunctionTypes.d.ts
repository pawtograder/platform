import { Database } from "./SupabaseTypes.d.ts";

export type Autograder = Database["public"]["Tables"]["autograder"]["Row"];
export type AutograderRegressionTest =
    Database["public"]["Tables"]["autograder_regression_test"]["Row"];
export type OutputFormat = "text" | "markdown" | "ansi";

export type AssignmentGroup = Database["public"]["Tables"]["assignment_groups"]["Row"];
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
        part?: string;
        extra_data?: { [key: string]: string };
    }[];
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
};

export type LiveMeetingForHelpRequestRequest = {
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
}

export type ListFilesRequest = {
    courseId: number;
    orgName: string;
    repoName: string;
}
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
}
export type GithubRepoConfigureWebhookRequest = {
    assignment_id: number;
    new_repo: string;
    watch_type: "grader_solution" | "template_repo";
}

export type AssignmentGroupCreateRequest = {
    name: string;
    course_id: number;
    assignment_id: number;
    invitees: string[];
}

export type GenericResponse = {
    error?: {
        recoverable: boolean;
        message: string;
        details: string;
    }
}

export type AssignmentGroupJoinRequest = {
    assignment_group_id: number;
}
export type AssignmentGroupListUngroupedRequest = {
    course_id: number;
    assignment_id: number;
}
export type AssignmentGroupListUngroupedResponse = {
    profiles: Database["public"]["Tables"]["profiles"]["Row"][];
}

export type AssignmentGroupInstructorMoveStudentRequest = {
    new_assignment_group_id: number | null;
    old_assignment_group_id: number | null;
    profile_id: string;
    class_id: number;
}
export type AssignmentGroupCopyGroupsFromAssignmentRequest = {
    class_id: number;
    source_assignment_id: number;
    target_assignment_id: number;
}