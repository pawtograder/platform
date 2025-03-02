import { createClient, User } from "@supabase/supabase-js";
import { createHash } from "crypto";
import {
    Body,
    Controller,
    Header,
    Post,
    Request,
    Response,
    Route,
    Security,
} from "tsoa";
import { Open as openZip } from "unzipper";
import GitHubController from "../GitHubController.js";
import { SecurityError, UserVisibleError } from "../InternalTypes.js";
import { Database } from "../SupabaseTypes.js";

export type Autograder =
    Database["public"]["Tables"]["autograder"]["Row"];
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
};
export type GradeResponse = {
    is_ok: boolean;
    message: string;
    details_url: string;
};

export type SubmissionResponse = {
    grader_url: string;
};

@Route("/api/autograder")
export class AutograderController extends Controller {
    @Security("supabase", ["student"])
    @Post("/create-github-repos-for-student")
    async createGitHubReposForStudent(@Request() request: Express.Request) {
        const user = (request as any).user.user as User;
        console.log("Creating GitHub repos for student ", user.email);
        const supabase = createClient<Database>(
            process.env.SUPABASE_URL || "",
            process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        );
        // Get the user's Github username
        const { data: userData } = await supabase.from("profiles").select(
            "github_username, repositories(*)",
        ).eq("id", user.id).single();
        if (!userData) {
            throw new SecurityError(`Invalid user: ${user.id}`);
        }
        const githubUsername = userData.github_username;
        if (!githubUsername) {
            throw new UserVisibleError(
                `User ${user.id} has no Github username linked`,
            );
        }
        const existingRepos = userData.repositories;
        const { data: classes } = await supabase.from("user_roles").select(
            "class_id",
        ).eq(
            "user_id",
            user.id,
        ).eq("role", "student");
        //Find all assignments that the student is enrolled in that have been released
        const { data: assignments } = await supabase.from("assignments").select(
            "*, classes(slug)",
        ).in("class_id", classes!.map((c) => c!.class_id))
            .lte("release_date", new Date().toISOString());
        
        const requests = assignments!.filter(assignment => !existingRepos.find(repo => repo.assignment_id === assignment.id)).map(async (assignment) => {
            const repoName = `${
                assignment.classes!.slug
            }-${assignment.slug}-${githubUsername}`;
            const repo = await GitHubController.getInstance().createRepo(
                "autograder-dev",
                repoName,
                assignment.template_repo,
                githubUsername,
            );
            const { error } = await supabase.from("repositories").insert({
                user_id: user.id,
                assignment_id: assignment.id,
                repository: `autograder-dev/${repoName}`,
            }, );
            if (error) {
                console.error(error);
            }
            return repo;
        });
        await Promise.all(requests);
        return {
            is_ok: true,
            message: `Repositories created for ${
                assignments!.length
            } assignments`,
        };
    }

    @Response<void>("401", "Invalid GitHub OIDC token")
    @Post("/submission")
    async createSubmission(
        @Header("Authorization") token: string,
    ): Promise<SubmissionResponse> {
        const decoded = await GitHubController.getInstance().validateOIDCToken(
            token,
        );
        // Retrieve the student's submisison
        const { repository, sha, workflow_ref } = decoded;
        // Find the corresponding student and assignment
        console.log("Creating submission for", repository, sha, workflow_ref);
        // const checkRunID = await GitHubController.getInstance().createCheckRun(repository, sha, workflow_ref);
        const supabase = createClient<Database>(
            process.env.SUPABASE_URL || "",
            process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        );
        const { data } = await supabase.from("repositories").select(
            "*, assignments(submission_files, class_id)",
        ).eq("repository", repository).single();
        if (!data) {
            throw new SecurityError(`Repository not found: ${repository}`);
        }
        // Create a submission record
        const { error, data: subID } = await supabase.from("submissions")
            .insert({
                user_id: data.user_id,
                assignment_id: data.assignment_id,
                repository,
                sha,
                run_number: Number.parseInt(decoded.run_id),
                run_attempt: Number.parseInt(decoded.run_attempt),
                class_id: data.assignments.class_id!,
                // check_run_id: checkRunID,
            }).select("id").single();
        if (error) {
            throw new UserVisibleError(
                `Failed to create submission: ${error.message}`,
            );
        }
        const submission_id = subID?.id;
        try {
            // Retrieve the autograder config
            const { data: config } = await supabase.from("autograder")
                .select("*").eq("id", data.assignment_id).single();
            if (!config) {
                throw new UserVisibleError("Grader config not found");
            }

            // Clone the repository
            const repo = await GitHubController.getInstance().cloneRepository(
                repository,
                sha,
                "tmp",
            );
            const zip = await openZip.buffer(repo);
            const stripTopDir = (str: string) =>
                str.split("/").slice(1).join("/");

            // Check the SHA
            const workflowFile = zip.files.find((file) =>
                stripTopDir(file.path) === ".github/workflows/grade.yml"
            );
            const hash = createHash("sha256");
            const contents = await workflowFile?.buffer();
            if (!contents) {
                throw new UserVisibleError(
                    "Failed to read workflow file in repository",
                );
            }
            hash.update(contents!);
            const hashStr = hash.digest("hex");
            if (hashStr !== config.workflow_sha) {
                throw new SecurityError(
                    `Workflow file SHA does not match expected value: ${hashStr} !== ${config.workflow_sha}`,
                );
            }
            const expectedFiles = data.assignments.submission_files as string[];
            if (expectedFiles.length === 0) {
                throw new UserVisibleError(
                    "Incorrect instructor setup for assignment: no submission files set",
                );
            }
            const submittedFiles = zip.files.filter((file) =>
                expectedFiles.includes(stripTopDir(file.path))
            );
            if (submittedFiles.length !== expectedFiles.length) {
                throw new UserVisibleError(
                    `Incorrect number of files submitted: ${submittedFiles.length} !== ${expectedFiles.length}`,
                );
            }
            const submittedFilesWithContents = await Promise.all(
                submittedFiles.map(async (file) => {
                    const contents = await file.buffer();
                    return { name: stripTopDir(file.path), contents };
                }),
            );
            // Add files to supabase
            const { error: fileError } = await supabase.from("submission_files")
                .insert(
                    submittedFilesWithContents.map((file) => ({
                        submissions_id: submission_id,
                        name: file.name,
                        user_id: data.user_id,
                        contents: file.contents.toString("utf-8"),
                        class_id: data.assignments.class_id!,
                    })),
                );
            if (fileError) {
                throw new Error(
                    `Failed to insert submission files: ${fileError.message}`,
                );
            }
            const grader_url = await GitHubController.getInstance()
                .getGraderURL(config.grader_repo!);
            console.log(grader_url);
            return {
                grader_url,
            };
        } catch (err) {
            console.error(err);
            // TODO update the submission status to failed, save error, etc

            throw err;
        }
    }

    @Response<void>("401", "Invalid GitHub OIDC token")
    @Post("/submission/feedback")
    async submitFeedback(
        @Header("Authorization") token: string,
        @Body() requestBody: GradingScriptResult,
    ): Promise<GradeResponse> {
        const ip = this.getHeader("x-forwarded-for") ||
            this.getHeader("x-real-ip");
        console.log("Remote IP", ip);
        const decoded = await GitHubController.getInstance().validateOIDCToken(
            token,
        );
        // Find the corresponding submission
        const supabase = createClient<Database>(
            process.env.SUPABASE_URL || "",
            process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        );
        const { repository, sha } = decoded;
        const { data: submission } = await supabase.from("submissions")
            .select("*").eq("repository", repository).eq("sha", sha)
            .eq("run_attempt", Number.parseInt(decoded.run_attempt))
            .eq("run_number", Number.parseInt(decoded.run_id)).single();
        if (!submission) {
            throw new SecurityError(
                `Submission not found: ${repository} ${sha} ${decoded.run_id}`,
            );
        }
        const { error, data: resultID } = await supabase.from(
            "grader_results",
        ).insert({
            submission_id: submission.id,
            user_id: submission.user_id,
            class_id: submission.class_id,
            ret_code: requestBody.ret_code,
            grader_sha: requestBody.grader_sha,
            score: requestBody.feedback.score ||
                requestBody.feedback.tests.reduce(
                    (acc, test) => acc + (test.score || 0),
                    0,
                ),
            max_score: requestBody.feedback.max_score ||
                requestBody.feedback.tests.reduce(
                    (acc, test) => acc + (test.max_score || 0),
                    0,
                ),
            lint_output: requestBody.feedback.lint.output,
            lint_output_format: requestBody.feedback.lint.output_format ||
                "text",
            lint_passed: requestBody.feedback.lint.status === "pass",
            execution_time: requestBody.execution_time,
        }).select("id").single();
        if (error) {
            console.error(error);
            throw new UserVisibleError(
                `Failed to insert feedback: ${error.message}`,
            );
        }
        // Insert feedback for each visibility level
        for (
            const visibility of [
                "hidden",
                "visible",
                "after_due_date",
                "after_published",
            ]
        ) {
            //Insert output if it exists
            if (requestBody.feedback.output[visibility as OutputVisibility]) {
                const output =
                    requestBody.feedback.output[visibility as OutputVisibility];
                if (output) {
                    await supabase.from("grader_result_output").insert({
                        class_id: submission.class_id,
                        student_id: submission.user_id,
                        grader_result_id: resultID.id,
                        visibility: visibility as OutputVisibility,
                        format: output.output_format || "text",
                        output: output.output,
                    });
                }
            }
        }
        //Insert test results
        const { error: testResultsError } = await supabase
            .from("grader_result_tests").insert(
                requestBody.feedback.tests.map((test) => ({
                    class_id: submission.class_id,
                    student_id: submission.user_id,
                    grader_result_id: resultID.id,
                    name: test.name,
                    output: test.output,
                    output_format: test.output_format || "text",
                    name_format: test.name_format || "text",
                    score: test.score,
                    max_score: test.max_score,
                    part: test.part,
                    extra_data: test.extra_data,
                })),
            );
        if (testResultsError) {
            throw new UserVisibleError(
                `Failed to insert test results: ${testResultsError.message}`,
            );
        }
        // Update the check run status to completed
        // await GitHubController.getInstance().completeCheckRun(submission, requestBody.feedback);
        return {
            is_ok: true,
            message: `Submission ${submission.id} registered`,
            details_url:
                `${process.env.PAWTOGRADER_WEBAPP_URL}/course/${submission.class_id}/assignments/${submission.assignment_id}/submissions/${submission.id}`,
        };
    }
}
