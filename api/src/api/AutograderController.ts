import { createClient, User } from "@supabase/supabase-js";
import { createHash } from "crypto";
import {
    Body,
    Controller,
    Get,
    Header,
    Path,
    Post,
    Query,
    Request,
    Response,
    Route,
    Security,
} from "tsoa";
import { Open as openZip } from "unzipper";
import GitHubController from "../GitHubController.js";
import { SecurityError, UserVisibleError } from "../InternalTypes.js";
import { Database } from "../SupabaseTypes.js";

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
        const { data: userData } = await supabase.from("user_roles").select(
            "users(github_username)"
        ).eq("user_id", user.id).single();
        if (!userData) {
            throw new SecurityError(`Invalid user: ${user.id}`);
        }
        const githubUsername = userData.users.github_username;
        if (!githubUsername) {
            throw new UserVisibleError(
                `User ${user.id} has no Github username linked`,
            );
        }
        const { data: classes } = await supabase.from("user_roles").select(
            "class_id, profiles!private_profile_id(id, name, sortable_name, repositories(*))",
        ).eq(
            "user_id",
            user.id,
        ).eq("role", "student");
        const existingRepos = classes!.flatMap((c) => c!.profiles!.repositories);
        //Find all assignments that the student is enrolled in that have been released
        const { data: assignments } = await supabase.from("assignments").select(
            "*, classes(slug)",
        ).in("class_id", classes!.map((c) => c!.class_id))
            .lte("release_date", new Date().toISOString());

        const requests = assignments!.filter((assignment) =>
            !existingRepos.find((repo) => repo.assignment_id === assignment.id)
        ).map(async (assignment) => {
            const userProfileID = classes!.find((c) => c!.class_id === assignment.class_id)?.profiles!.id;
            if (!userProfileID) {
                throw new UserVisibleError(`User profile ID not found for class ${assignment.class_id}`);
            }
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
                profile_id: userProfileID,
                class_id: assignment.class_id!,
                assignment_id: assignment.id,
                repository: `autograder-dev/${repoName}`,
            });
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

    @Get("/regression-tests")
    async retrieveAutograderRegressionTests(
        @Header("Authorization") token: string,
    ): Promise<{ configs: { id: number }[] }> {
        const decoded = await GitHubController.getInstance().validateOIDCToken(
            token,
        );
        const supabase = createClient<Database>(
            process.env.SUPABASE_URL || "",
            process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        );
        const { data, error } = await supabase.from(
            "autograder_regression_test_by_grader",
        )
            .select("*").eq("grader_repo", decoded.repository);
        if (error) {
            throw new UserVisibleError(
                `Error retrieving regression tests: ${error.message}`,
            );
        }
        return { configs: data.map((d) => ({ id: d.id! })) };
    }
    @Response<void>("401", "Invalid GitHub OIDC token")
    @Post("/submission")
    async createSubmission(
        @Header("Authorization") token: string,
    ): Promise<SubmissionResponse> {
        const decoded = await GitHubController.getInstance().validateOIDCToken(
            token,
        );
        console.log(decoded);
        // Retrieve the student's submisison
        const { repository, sha, workflow_ref } = decoded;
        // Find the corresponding student and assignment
        console.log("Creating submission for", repository, sha, workflow_ref);
        // const checkRunID = await GitHubController.getInstance().createCheckRun(repository, sha, workflow_ref);
        const supabase = createClient<Database>(
            process.env.SUPABASE_URL || "",
            process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        );
        const { data: repoData } = await supabase.from("repositories").select(
            "*, assignments(submission_files, class_id)",
        ).eq("repository", repository).single();

        if (repoData) {
            //It's a student repo
            const assignment_id = repoData.assignment_id;
            if (
                !workflow_ref.endsWith(
                    `.github/workflows/grade.yml@refs/heads/main`,
                )
            ) {
                throw new Error(`Invalid workflow, got ${workflow_ref}`);
            }
            // Create a submission record
            const { error, data: subID } = await supabase.from("submissions")
                .insert({
                    profile_id: repoData?.profile_id,
                    assignment_id: repoData.assignment_id,
                    repository,
                    sha,
                    run_number: Number.parseInt(decoded.run_id),
                    run_attempt: Number.parseInt(decoded.run_attempt),
                    class_id: repoData.assignments.class_id!,
                    // check_run_id: checkRunID,
                }).select("id").single();
            if (error) {
                throw new UserVisibleError(
                    `Failed to create submission: ${error.message}`,
                );
            }
            const submission_id = subID?.id;
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
            // Retrieve the autograder config
            const { data: config } = await supabase.from("autograder")
                .select("*").eq("id", assignment_id).single();
            if (!config) {
                throw new UserVisibleError("Grader config not found");
            }
            hash.update(contents!);
            const hashStr = hash.digest("hex");
            if (hashStr !== config.workflow_sha) {
                throw new SecurityError(
                    `Workflow file SHA does not match expected value: ${hashStr} !== ${config.workflow_sha}`,
                );
            }
            const expectedFiles = repoData.assignments
                .submission_files as string[];
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
                        profile_id: repoData.profile_id,
                        contents: file.contents.toString("utf-8"),
                        class_id: repoData.assignments.class_id!,
                    })),
                );
            if (fileError) {
                throw new Error(
                    `Failed to insert submission files: ${fileError.message}`,
                );
            }
            try {
                const { download_link: grader_url, sha: grader_sha } =
                    await GitHubController.getInstance()
                        .getRepoTarballURL(config.grader_repo!);
                return {
                    grader_url,
                    grader_sha,
                };
            } catch (err) {
                console.error(err);
                // TODO update the submission status to failed, save error, etc

                throw err;
            }
        } else {
            throw new SecurityError(`Repository not found: ${repository}`);
        }
    }

    @Response<void>("401", "Invalid GitHub OIDC token")
    @Post("/regression-test-run/:regression_test_id")
    async createRegressionTestRun(
        @Header("Authorization") token: string,
        @Path() regression_test_id: number,
    ): Promise<RegressionTestRunResponse> {
        const decoded = await GitHubController.getInstance().validateOIDCToken(
            token,
        );
        const { repository, sha, workflow_ref } = decoded;
        console.log(
            "Creating regression test run for",
            repository,
            sha,
            workflow_ref,
            regression_test_id,
        );

        const supabase = createClient<Database>(
            process.env.SUPABASE_URL || "",
            process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        );
        const { data: graderData } = await supabase.from("autograder").select(
            "*, assignments(id, submission_files, class_id)",
        ).eq("grader_repo", repository).limit(1).single();
        if (graderData) {
            //It's a grader repo
            if (
                !workflow_ref.endsWith(
                    `.github/workflows/regression-test.yml@refs/heads/main`,
                )
            ) {
                throw new Error(`Invalid workflow, got ${workflow_ref}`);
            }
            try {
                //Validate that the regression test repo is registered for this grader
                const { data: regressionTestRepoData } = await supabase.from(
                    "autograder_regression_test_by_grader",
                ).select(
                    "*",
                ).eq("id", regression_test_id)
                    .eq("grader_repo", graderData.grader_repo!)
                    .limit(1).single();
                if (!regressionTestRepoData) {
                    throw new SecurityError(
                        `Regression test repo not found for grader ${graderData.grader_repo} and test id ${regression_test_id}`,
                    );
                }
                if (!regressionTestRepoData.sha) {
                    throw new UserVisibleError(
                        `Regression test repo has no SHA: ${regressionTestRepoData.repository}`,
                    );
                }
                const { download_link: regression_test_url } =
                    await GitHubController.getInstance()
                        .getRepoTarballURL(
                            regressionTestRepoData.repository!,
                            regressionTestRepoData.sha,
                        );
                return {
                    regression_test_url,
                    regression_test_sha: regressionTestRepoData.sha,
                };
            } catch (err) {
                console.error(err);
                // TODO update the submission status to failed, save error, etc

                throw err;
            }
        } else {
            throw new SecurityError(`Repository not found: ${repository}`);
        }
    }

    @Response<void>("401", "Invalid GitHub OIDC token")
    @Post("/submission/feedback")
    async submitFeedback(
        @Header("Authorization") token: string,
        @Body() requestBody: GradingScriptResult,
        @Query() autograder_regression_test_id?: number,
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
        let class_id, assignment_id: number;
        let submission_id: number | null = null;
        let user_id: string | null = null;
        if (autograder_regression_test_id) {
            //It's a regression test run
            const { data: regressionTestRun } = await supabase.from(
                "autograder_regression_test",
            ).select("*,autograder(assignments(id, class_id))").eq(
                "id",
                autograder_regression_test_id,
            )
                .eq("autograder.grader_repo", repository)
                .single();
            if (!regressionTestRun) {
                throw new SecurityError(
                    `Regression test run not found: ${autograder_regression_test_id}, grader repo: ${repository}`,
                );
            }
            if (!regressionTestRun.autograder.assignments.class_id) {
                throw new UserVisibleError(
                    `Regression test class ID not found: ${autograder_regression_test_id}, grader repo: ${repository}`,
                );
            }
            class_id = regressionTestRun.autograder.assignments.class_id;
            assignment_id = regressionTestRun.autograder.assignments.id;
        } else {
            const { data: submission } = await supabase.from("submissions")
                .select("*").eq("repository", repository).eq("sha", sha)
                .eq("run_attempt", Number.parseInt(decoded.run_attempt))
                .eq("run_number", Number.parseInt(decoded.run_id)).single();
            if (!submission) {
                throw new SecurityError(
                    `Submission not found: ${repository} ${sha} ${decoded.run_id}`,
                );
            }
            class_id = submission.class_id;
            submission_id = submission.id;
            user_id = submission.profile_id;
            assignment_id = submission.assignment_id;
        }

        //Resolve the action SHA
        const action_sha = await GitHubController.getInstance().resolveRef(
            requestBody.action_repository,
            requestBody.action_ref,
        );
        console.log("Action SHA", action_sha);
        const { error, data: resultID } = await supabase.from(
            "grader_results",
        ).insert({
            submission_id: submission_id,
            profile_id: user_id,
            class_id: class_id,
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
            grader_action_sha: action_sha,
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
                        class_id: class_id,
                        student_id: user_id,
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
                    class_id: class_id,
                    student_id: user_id,
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
        if (submission_id) {
            return {
                is_ok: true,
                message: `Submission ${submission_id} registered`,
                details_url:
                    `${process.env.PAWTOGRADER_WEBAPP_URL}/course/${class_id}/assignments/${assignment_id}/submissions/${submission_id}`,
            };
        } else {
            return {
                is_ok: true,
                message: `Regression test run ${resultID} registered`,
                details_url:
                    `${process.env.PAWTOGRADER_WEBAPP_URL}/course/${class_id}/manage/assignments/${assignment_id}/autograder/regression-test-run/${resultID}`,
            };
        }
    }
}
