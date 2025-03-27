import { Database } from "./SupabaseTypes.d.ts";

export type Autograder = Database["public"]["Tables"]["autograder"]["Row"];
export type AutograderRegressionTest =
    Database["public"]["Tables"]["autograder_regression_test"]["Row"];
export type OutputFormat = "text" | "markdown" | "ansi";
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