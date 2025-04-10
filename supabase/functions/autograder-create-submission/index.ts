// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

import { wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { UserVisibleError, SecurityError } from "../_shared/HandlerUtils.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateOIDCToken, cloneRepository, getRepoTarballURL } from "../_shared/GitHubWrapper.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { Open as openZip } from "npm:unzipper";
import { createHash } from "node:crypto";
async function handleRequest(req: Request) {
    const token = req.headers.get("Authorization");
    if (!token) {
        throw new UserVisibleError("No token provided");
    }
    const decoded = await validateOIDCToken(token);
    // Retrieve the student's submisison
    const { repository, sha, workflow_ref } = decoded;
    // Find the corresponding student and assignment
    console.log("Creating submission for", repository, sha, workflow_ref);
    // const checkRunID = await GitHubController.getInstance().createCheckRun(repository, sha, workflow_ref);
    const adminSupabase = createClient<Database>(
        Deno.env.get("SUPABASE_URL") || "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    );
    const { data: repoData } = await adminSupabase.from("repositories").select(
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
        const { error, data: subID } = await adminSupabase.from("submissions")
            .insert({
                profile_id: repoData?.profile_id,
                assignment_group_id: repoData?.assignment_group_id,
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
        const repo = await cloneRepository(
            repository,
            sha
        );
        const zip = await openZip.buffer(repo);
        const stripTopDir = (str: string) =>
            str.split("/").slice(1).join("/");

        // Check the SHA
        const workflowFile = zip.files.find((file: any) =>
            stripTopDir(file.path) === ".github/workflows/grade.yml"
        );
        const hash = createHash("sha256");
        const contents = await workflowFile?.buffer();
        if (!contents) {
            throw new UserVisibleError(
                "Failed to read workflow file in repository",
            );
        }
        const contentsStr = contents.toString("utf-8");
        console.log("Contents of workflow file", contentsStr.length);
        console.log(contentsStr);
        // Retrieve the autograder config
        const { data: config } = await adminSupabase.from("autograder")
            .select("*").eq("id", assignment_id).single();
        if (!config) {
            throw new UserVisibleError("Grader config not found");
        }
        hash.update(contentsStr);
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
        const submittedFiles = zip.files.filter((file: any) =>
            expectedFiles.includes(stripTopDir(file.path))
        );
        if (submittedFiles.length !== expectedFiles.length) {
            throw new UserVisibleError(
                `Incorrect number of files submitted: ${submittedFiles.length} !== ${expectedFiles.length}`,
            );
        }
        const submittedFilesWithContents = await Promise.all(
            submittedFiles.map(async (file: any) => {
                const contents = await file.buffer();
                return { name: stripTopDir(file.path), contents };
            }),
        );
        // Add files to supabase
        const { error: fileError } = await adminSupabase.from("submission_files")
            .insert(
                submittedFilesWithContents.map((file: any) => ({
                    submission_id: submission_id,
                    name: file.name,
                    profile_id: repoData.profile_id,
                    assignment_group_id: repoData.assignment_group_id,
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
            if(!config.grader_repo){
                throw new UserVisibleError("This assignment is not configured to use an autograder. Please let your instructor know that there is no grader repo configured for this assignment.");
            }
            const { download_link: grader_url, sha: grader_sha } =
                await
                    getRepoTarballURL(config.grader_repo!);

            console.log("Grader URL:", grader_url);

            const patchedURL= grader_url.replace("http://kong:8000","https://khoury-classroom-dev.ngrok.pizza")
            console.log("Patched URL:", patchedURL);
            return {
                grader_url: patchedURL,
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
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
})