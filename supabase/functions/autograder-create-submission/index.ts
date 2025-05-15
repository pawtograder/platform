// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHash } from "node:crypto";
import { TZDate } from "npm:@date-fns/tz";
import { addHours, addSeconds, format } from "npm:date-fns@4";
import micromatch from "npm:micromatch";
import { Open as openZip } from "npm:unzipper";
import { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import { cloneRepository, getRepoTarballURL, updateCheckRun, validateOIDCToken } from "../_shared/GitHubWrapper.ts";
import { SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { PawtograderConfig } from "../_shared/PawtograderYml.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

function formatSeconds(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}

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
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data: repoData, error: repoError } = await adminSupabase
    .from("repositories")
    .select("*, assignments(class_id, due_date, autograder(*))")
    .eq("repository", repository)
    .single();
  if (repoError) {
    throw new UserVisibleError(`Failed to find repository: ${repoError.message}`);
  }

  if (repoData) {
    //It's a student repo
    const assignment_id = repoData.assignment_id;
    if (!workflow_ref.includes(`.github/workflows/grade.yml`)) {
      throw new Error(`Invalid workflow, got ${workflow_ref}`);
    }
    const { data: checkRun, error: checkRunError } = await adminSupabase
      .from("repository_check_runs")
      .select("*, user_roles(*), classes(time_zone)")
      .eq("repository_id", repoData.id)
      .eq("sha", sha)
      .maybeSingle(); //TODO: Select the MOST RECENT check run, so that when we call Regrade, we know who triggered it
    if (checkRunError || !checkRun) {
      throw new UserVisibleError(`Failed to find check run for ${repoData.id}@${sha}: ${checkRunError?.message}`);
    }
    const timeZone = checkRun.classes.time_zone || "America/New_York";
    // Validate that the submission can be created
    if (!checkRun.user_roles || (checkRun.user_roles.role !== "instructor" && checkRun.user_roles.role !== "grader")) {
      // Check if it's too late to submit. Get extensions
      const ownershipFilter = repoData.assignment_group_id
        ? `assignment_group_id.eq.${repoData.assignment_group_id}`
        : `student_id.eq.${repoData.profile_id}`;
      const { data: extensions, error: extensionsError } = await adminSupabase
        .from("assignment_due_date_exceptions")
        .select("*")
        .or(ownershipFilter)
        .eq("assignment_id", repoData.assignment_id);
      if (extensionsError) {
        throw new UserVisibleError(`Failed to find extensions: ${extensionsError.message}`);
      }
      console.log(`Timezone: ${timeZone}`);
      const totalExtensions = extensions?.map((e) => e.hours).reduce((a, b) => a + b, 0);
      console.log(`Total extensions: ${totalExtensions}`);
      console.log(`Due date: ${repoData.assignments.due_date}`);

      //omg why is this needed?
      const tzDate = TZDate.tz(timeZone);
      const offset = tzDate.getTimezoneOffset();
      const offsetHours = Math.abs(Math.floor(offset / 60));
      const offsetMinutes = Math.abs(offset % 60);
      const offsetStr = `${offset < 0 ? "+" : "-"}${offsetHours.toString().padStart(2, "0")}:${offsetMinutes.toString().padStart(2, "0")}`;
      const originalDueDate = new TZDate(repoData.assignments.due_date + offsetStr, timeZone);

      console.log(`Original due date: ${originalDueDate}`);
      const newDueDate = addHours(originalDueDate, totalExtensions);
      console.log(`New due date: ${newDueDate}`);
      const currentDate = TZDate.tz(timeZone);
      console.log(`Current date: ${currentDate}`);
      if (currentDate > newDueDate) {
        //Fail the check run
        await updateCheckRun({
          owner: repository.split("/")[0],
          repo: repository.split("/")[1],
          check_run_id: checkRun.check_run_id,
          status: "completed",
          conclusion: "failure",
          output: {
            title: "Submission failed",
            summary: "You cannot submit after the due date.",
            text: `The due date for this assignment was ${newDueDate.toLocaleString()} (${timeZone}). Your code is still arhived on GitHub, and instructors and TAs can still manually submit it if needed.`
          }
        });
        throw new UserVisibleError("You cannot submit after the due date.");
      }
      // Check the max submissions per-time
      if (
        repoData.assignments.autograder?.max_submissions_period_secs &&
        repoData.assignments.autograder?.max_submissions_count
      ) {
        const { data: submissions, error: submissionsError } = await adminSupabase
          .from("submissions")
          .select("*, grader_results(*)")
          .or(ownershipFilter)
          .eq("assignment_group_id", repoData.assignment_group_id!)
          .eq("assignment_id", repoData.assignment_id)
          .gte(
            "created_at",
            addSeconds(new Date(), 0 - repoData.assignments.autograder.max_submissions_period_secs).toISOString()
          )
          .order("created_at", { ascending: false });
        if (submissionsError || !submissions) {
          throw new UserVisibleError(`Failed to find submissions: ${submissionsError.message}`);
        }
        const submissionsInPeriod = submissions.filter(
          (s) => !s.grader_results || (s.grader_results && s.grader_results.score > 0)
        );
        console.log(
          `Rate limiter: ${submissionsInPeriod.length} / ${repoData.assignments.autograder.max_submissions_count} in ${repoData.assignments.autograder.max_submissions_period_secs} seconds`
        );
        if (submissionsInPeriod.length >= repoData.assignments.autograder.max_submissions_count) {
          //Calculate when the next submission is allowed
          const numSubmissionsOverLimit =
            1 + submissionsInPeriod.length - repoData.assignments.autograder.max_submissions_count;
          const oldestSubmission = submissionsInPeriod[submissionsInPeriod.length - numSubmissionsOverLimit];
          const nextAllowedSubmission = addSeconds(
            new TZDate(oldestSubmission.created_at, timeZone),
            repoData.assignments.autograder.max_submissions_period_secs
          );

          //Update the check run status
          await updateCheckRun({
            owner: repository.split("/")[0],
            repo: repository.split("/")[1],
            check_run_id: checkRun.check_run_id,
            status: "completed",
            conclusion: "failure",
            output: {
              title: "Submission limit reached",
              summary: `Please wait until ${format(nextAllowedSubmission, "MM/dd/yyyy HH:mm")} to submit again.`,
              text: `Reached max limit (${repoData.assignments.autograder.max_submissions_count} submissions per ${formatSeconds(repoData.assignments.autograder.max_submissions_period_secs)})`
            },
            actions: [
              {
                label: "Submit",
                description: "Try to submit again",
                identifier: "submit"
              }
            ]
          });
          throw new UserVisibleError(
            `Submission limit reached (max ${repoData.assignments.autograder.max_submissions_count} submissions per ${formatSeconds(repoData.assignments.autograder.max_submissions_period_secs)}). Please wait until ${format(nextAllowedSubmission, "MM/dd/yyyy HH:mm")} to submit again.`
          );
        }
      }
    }

    const { error, data: subID } = await adminSupabase
      .from("submissions")
      .insert({
        profile_id: repoData?.profile_id,
        assignment_group_id: repoData?.assignment_group_id,
        assignment_id: repoData.assignment_id,
        repository,
        repository_id: repoData.id,
        sha,
        run_number: Number.parseInt(decoded.run_id),
        run_attempt: Number.parseInt(decoded.run_attempt),
        class_id: repoData.assignments.class_id!,
        repository_check_run_id: checkRun?.id
      })
      .select("id")
      .single();
    if (error) {
      console.error(error);
      throw new UserVisibleError(`Failed to create submission for repository ${repository}: ${error.message}`);
    }
    const submission_id = subID?.id;

    if (checkRun) {
      await adminSupabase
        .from("repository_check_runs")
        .update({
          status: {
            ...(checkRun.status as CheckRunStatus),
            started_at: new Date().toISOString()
          }
        })
        .eq("id", checkRun.id);
      await updateCheckRun({
        owner: repository.split("/")[0],
        repo: repository.split("/")[1],
        check_run_id: checkRun.check_run_id,
        status: "in_progress",
        details_url: `https://${Deno.env.get("APP_URL")}/course/${repoData.assignments.class_id}/assignments/${repoData.assignment_id}/submissions/${submission_id}`,
        output: {
          title: "Grading in progress",
          summary: "Autograder is running",
          text: "Details may be available in the 'Submit and Grade Assignment' action."
        }
      });
    }

    // Clone the repository
    const repo = await cloneRepository(repository, sha);
    const zip = await openZip.buffer(repo);
    const stripTopDir = (str: string) => str.split("/").slice(1).join("/");

    // Check the SHA
    const workflowFile = zip.files.find((file: any) => stripTopDir(file.path) === ".github/workflows/grade.yml");
    const hash = createHash("sha256");
    const contents = await workflowFile?.buffer();
    if (!contents) {
      throw new UserVisibleError("Failed to read workflow file in repository");
    }
    const contentsStr = contents.toString("utf-8");
    // Retrieve the autograder config
    const { data: config } = await adminSupabase.from("autograder").select("*").eq("id", assignment_id).single();
    if (!config) {
      throw new UserVisibleError("Grader config not found");
    }
    hash.update(contentsStr);
    const hashStr = hash.digest("hex");
    if (hashStr !== config.workflow_sha) {
      throw new SecurityError(`Workflow file SHA does not match expected value: ${hashStr} !== ${config.workflow_sha}`);
    }
    const pawtograderConfig = config.config as unknown as PawtograderConfig;
    const expectedFiles = [...pawtograderConfig.submissionFiles.files, ...pawtograderConfig.submissionFiles.testFiles];

    if (expectedFiles.length === 0) {
      throw new UserVisibleError("Incorrect instructor setup for assignment: no submission files set");
    }
    const submittedFiles = zip.files.filter(
      (file: any) =>
        file.type === "File" && // Do not submit directories
        expectedFiles.some((pattern) => micromatch.isMatch(stripTopDir(file.path), pattern))
    );
    // Make sure that all files that are NOT glob patterns are present
    const nonGlobFiles = expectedFiles.filter((pattern) => !pattern.includes("*"));
    const allNonGlobFilesPresent = nonGlobFiles.every((file) =>
      submittedFiles.some((submittedFile: any) => stripTopDir(submittedFile.path) === file)
    );
    if (!allNonGlobFilesPresent) {
      throw new UserVisibleError(`Missing required files: ${nonGlobFiles.join(", ")}`);
    }

    const submittedFilesWithContents = await Promise.all(
      submittedFiles.map(async (file: any) => {
        const contents = await file.buffer();
        return { name: stripTopDir(file.path), contents };
      })
    );
    // Add files to supabase
    const { error: fileError } = await adminSupabase.from("submission_files").insert(
      submittedFilesWithContents.map((file: any) => ({
        submission_id: submission_id,
        name: file.name,
        profile_id: repoData.profile_id,
        assignment_group_id: repoData.assignment_group_id,
        contents: file.contents.toString("utf-8"),
        class_id: repoData.assignments.class_id!
      }))
    );
    if (fileError) {
      throw new Error(`Failed to insert submission files: ${fileError.message}`);
    }
    try {
      if (!config.grader_repo) {
        throw new UserVisibleError(
          "This assignment is not configured to use an autograder. Please let your instructor know that there is no grader repo configured for this assignment."
        );
      }
      const { download_link: grader_url, sha: grader_sha } = await getRepoTarballURL(config.grader_repo!);

      console.log("Grader URL:", grader_url);

      const patchedURL = grader_url.replace("http://kong:8000", "https://khoury-classroom-dev.ngrok.pizza");
      console.log("Patched URL:", patchedURL);
      return {
        grader_url: patchedURL,
        grader_sha
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
});
