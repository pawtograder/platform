// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createHash } from "node:crypto";
import { TZDate } from "npm:@date-fns/tz";
import { addSeconds, format, isAfter } from "npm:date-fns@4";
import micromatch from "npm:micromatch";
import { Open as openZip } from "npm:unzipper";
import type { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import {
  cloneRepository,
  getRepoTarballURL,
  GitHubOIDCToken,
  updateCheckRun,
  validateOIDCToken
} from "../_shared/GitHubWrapper.ts";
import { SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import type { PawtograderConfig } from "../_shared/PawtograderYml.d.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { Buffer } from "node:buffer";
import { decode } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";
import * as Sentry from "npm:@sentry/deno";

// Retry helper with exponential backoff
async function retryWithExponentialBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 5,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      // If this is the last attempt, throw the error
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Calculate delay with exponential backoff (baseDelay * 2^attempt)
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`);

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // This should never be reached, but TypeScript requires it
  throw lastError!;
}
function formatSeconds(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}

const END_TO_END_REPO_PREFIX = "pawtograder-playground/test-e2e-student-repo";
const END_TO_END_SECRET = Deno.env.get("END_TO_END_SECRET") || "not-a-secret";

function getRepoToCloneConsideringE2E(repository: string) {
  if (repository.startsWith(END_TO_END_REPO_PREFIX)) {
    const separatorPosition = repository.indexOf("--");
    if (separatorPosition === -1) {
      throw new SecurityError("E2E repo provided, but no separator found");
    }
    return repository.slice(0, separatorPosition);
  }
  return repository;
}
async function validateOIDCTokenOrAllowE2E(token: string) {
  const decoded = decode(token);
  const payload = decoded[1] as GitHubOIDCToken;
  if (payload.repository.startsWith(END_TO_END_REPO_PREFIX)) {
    const header = decoded[0] as {
      alg: string;
      typ: string;
      kid: string;
    };
    if (header.kid !== END_TO_END_SECRET) {
      throw new SecurityError("E2E repo provided, but secret is incorrect");
    }
    return payload;
  }
  return await validateOIDCToken(token);
}

async function handleRequest(req: Request, scope: Sentry.Scope) {
  scope?.setTag("function", "autograder-create-submission");
  const token = req.headers.get("Authorization");
  if (!token) {
    throw new UserVisibleError("No token provided");
  }
  // Check if this is part of an
  const decoded = await validateOIDCTokenOrAllowE2E(token);
  const { repository, sha, workflow_ref, run_id, run_attempt } = decoded;
  const isE2ERun = repository.startsWith(END_TO_END_REPO_PREFIX); //Don't write back to GitHub for E2E runs, just pull
  scope?.setTag("repository", repository);
  scope?.setTag("sha", sha);
  scope?.setTag("workflow_ref", workflow_ref);
  scope?.setTag("run_id", run_id);
  scope?.setTag("run_attempt", run_attempt);
  scope?.setTag("is_e2e_run", isE2ERun.toString());
  // Find the corresponding student and assignment
  console.log("Creating submission for", repository, sha, workflow_ref);
  // const checkRunID = await GitHubController.getInstance().createCheckRun(repository, sha, workflow_ref);
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );
  const { data: repoData, error: repoError } = await adminSupabase
    .from("repositories")
    .select("*, assignments(class_id, due_date, allow_not_graded_submissions, autograder(*))")
    .eq("repository", repository)
    .single();
  if (repoError) {
    scope?.setTag("db_error", "repository_lookup_failed");
    scope?.setTag("db_error_message", repoError.message);
    throw new UserVisibleError(`Failed to find repository: ${repoError.message}`);
  }

  if (repoData) {
    scope?.setTag("assignment_id", repoData.assignment_id.toString());
    scope?.setTag("class_id", repoData.assignments.class_id?.toString() || "unknown");
    scope?.setTag("profile_id", repoData.profile_id || "none");
    scope?.setTag("assignment_group_id", repoData.assignment_group_id?.toString() || "none");
  }

  // Begin code where we might report an error to the user.
  let submission_id: number | undefined;
  async function recordWorkflowRunError({ name, data, is_private }: { name: string; data: Json; is_private: boolean }) {
    if (!repoData) {
      throw new SecurityError(
        `Repository not found for run_number: ${run_id}, run_attempt: ${run_attempt}, repository: ${repository}, sha: ${sha}`
      );
    }
    if (!name) {
      throw new Error("No name provided to recordWorkflowRunError");
    }
    const { error: workflowRunErrorError } = await adminSupabase.from("workflow_run_error").insert({
      run_number: Number.parseInt(run_id),
      run_attempt: Number.parseInt(run_attempt),
      class_id: repoData.assignments.class_id!,
      submission_id: submission_id ?? null,
      repository_id: repoData.id,
      name,
      data,
      is_private
    });
    if (workflowRunErrorError) {
      console.error(workflowRunErrorError);
      Sentry.addBreadcrumb({
        level: "error",
        message: JSON.stringify(workflowRunErrorError)
      });
      throw new Error(`Internal error: Failed to insert workflow run error: ${workflowRunErrorError.message}`);
    }
  }
  try {
    if (repoData) {
      //It's a student repo
      const assignment_id = repoData.assignment_id;
      if (!workflow_ref.includes(`.github/workflows/grade.yml`)) {
        throw new Error(`Invalid workflow, got ${workflow_ref}`);
      }
      // Fetch check run with retry logic for race conditions
      const fetchCheckRun = async () => {
        const { data: checkRun, error: checkRunError } = await adminSupabase
          .from("repository_check_runs")
          .select("*, user_roles(*), classes(time_zone), commit_message")
          .eq("repository_id", repoData.id)
          .eq("sha", sha)
          .maybeSingle(); //TODO: Select the MOST RECENT check run, so that when we call Regrade, we know who triggered it

        if (checkRunError) {
          throw new UserVisibleError(`Failed to find check run for ${repoData.id}@${sha}: ${checkRunError.message}`);
        }

        if (!checkRun) {
          throw new Error(`Check run not found for ${repoData.id}@${sha} - may be racing with external operation`);
        }

        return checkRun;
      };

      const checkRun = await retryWithExponentialBackoff(fetchCheckRun, 5, 1000);
      const timeZone = checkRun.classes.time_zone || "America/New_York";

      // Check if this is a NOT-GRADED submission
      const isNotGradedSubmission =
        (checkRun.commit_message && checkRun.commit_message.includes("#NOT-GRADED")) || false;

      scope?.setTag("time_zone", timeZone);
      scope?.setTag("is_not_graded", isNotGradedSubmission.toString());
      scope?.setTag("user_role", checkRun.user_roles?.role || "unknown");

      // Validate that the submission can be created
      if (
        !checkRun.user_roles ||
        (checkRun.user_roles.role !== "instructor" && checkRun.user_roles.role !== "grader")
      ) {
        // Check if it's too late to submit using the lab-aware due date calculation
        console.log(`Timezone: ${timeZone}`);
        console.log(`Assignment ID: ${repoData.assignment_id}`);
        console.log(`Profile ID: ${repoData.profile_id}`);
        console.log(`Assignment Group ID: ${repoData.assignment_group_id}`);

        // Use the database function to calculate the final due date (includes lab scheduling + extensions)
        const { data: finalDueDateResult, error: dueDateError } = await adminSupabase.rpc("calculate_final_due_date", {
          assignment_id_param: repoData.assignment_id,
          student_profile_id_param: repoData.profile_id || "",
          assignment_group_id_param: repoData.assignment_group_id || undefined
        });

        if (dueDateError) {
          throw new UserVisibleError(`Failed to calculate due date: ${dueDateError.message}`);
        }

        const finalDueDate = new TZDate(finalDueDateResult);
        const currentDate = TZDate.tz(timeZone);

        if (isAfter(currentDate, finalDueDate)) {
          // Check if this is a NOT-GRADED submission and if the assignment allows it
          if (isNotGradedSubmission && repoData.assignments.allow_not_graded_submissions) {
            // Allow NOT-GRADED submissions after deadline

            // Update check run to indicate this is a NOT-GRADED submission
            if (!isE2ERun) {
              await updateCheckRun({
                owner: repository.split("/")[0],
                repo: repository.split("/")[1],
                check_run_id: checkRun.check_run_id,
                status: "in_progress",
                output: {
                  title: "NOT-GRADED submission",
                  summary: "This submission will not be graded but you can see feedback.",
                  text: `You submitted with #NOT-GRADED in your commit message. This submission will not be graded and cannot become your active submission, but you can still see autograder feedback.`
                }
              });
            }
          } else if (isNotGradedSubmission && !repoData.assignments.allow_not_graded_submissions) {
            // Student tried to use NOT-GRADED but assignment doesn't allow it
            if (!isE2ERun) {
              await updateCheckRun({
                owner: repository.split("/")[0],
                repo: repository.split("/")[1],
                check_run_id: checkRun.check_run_id,
                status: "completed",
                conclusion: "failure",
                output: {
                  title: "NOT-GRADED not allowed",
                  summary: "This assignment does not allow NOT-GRADED submissions.",
                  text: `You included #NOT-GRADED in your commit message, but this assignment does not allow NOT-GRADED submissions. Please contact your instructor if you need an extension.`
                }
              });
            }
            throw new UserVisibleError(
              "This assignment does not allow NOT-GRADED submissions. Please contact your instructor if you need an extension."
            );
          } else {
            //Fail the check run
            if (!isE2ERun) {
              await updateCheckRun({
                owner: repository.split("/")[0],
                repo: repository.split("/")[1],
                check_run_id: checkRun.check_run_id,
                status: "completed",
                conclusion: "failure",
                output: {
                  title: "Submission failed",
                  summary: "You cannot submit after the due date.",
                  text: `The due date for this assignment was ${finalDueDate.toLocaleString()} (${timeZone}). Your code is still archived on GitHub, and instructors and TAs can still manually submit it if needed.`
                }
              });
            }
            throw new UserVisibleError(
              `You cannot submit after the due date. Your due date: ${finalDueDate.toLocaleString()}, current time: ${currentDate.toLocaleString()}`
            );
          }
        }
        // Check the max submissions per-time
        if (
          repoData.assignments.autograder?.max_submissions_period_secs &&
          repoData.assignments.autograder?.max_submissions_count
        ) {
          const ownershipFilter = repoData.assignment_group_id
            ? `assignment_group_id.eq.${repoData.assignment_group_id}`
            : `profile_id.eq.${repoData.profile_id}`;
          const { data: submissions, error: submissionsError } = await adminSupabase
            .from("submissions")
            .select("*, grader_results(*)")
            .or(ownershipFilter)
            .eq("assignment_id", repoData.assignment_id)
            .gte(
              "created_at",
              addSeconds(new Date(), 0 - repoData.assignments.autograder.max_submissions_period_secs).toISOString()
            )
            .order("created_at", { ascending: false });
          if (submissionsError || !submissions) {
            throw new UserVisibleError(
              `Internal error: Failed to find submissions for rate limiting: ${submissionsError.message}`
            );
          }
          const submissionsInPeriod = submissions.filter(
            (s) => !s.grader_results || (s.grader_results && s.grader_results.score > 0)
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
            if (!isE2ERun) {
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
            }
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
          repository_check_run_id: checkRun?.id,
          is_not_graded: isNotGradedSubmission
        })
        .select("id")
        .single();
      if (error) {
        scope?.setTag("db_error", "submission_creation_failed");
        scope?.setTag("db_error_message", error.message);
        console.error(error);
        throw new UserVisibleError(`Failed to create submission for repository ${repository}: ${error.message}`);
      }
      submission_id = subID?.id;

      if (submission_id) {
        scope?.setTag("submission_id", submission_id.toString());
      }

      console.log(`Created submission ${submission_id} for repository ${repository}`);
      if (checkRun && !isE2ERun) {
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

      try {
        // Clone the repository
        const repoToClone = getRepoToCloneConsideringE2E(repository);
        const repo = await cloneRepository(repoToClone, isE2ERun ? "HEAD" : sha);
        const zip = await openZip.buffer(repo);
        const stripTopDir = (str: string) => str.split("/").slice(1).join("/");

        // Check the SHA
        const workflowFile = zip.files.find(
          (file: { path: string }) => stripTopDir(file.path) === ".github/workflows/grade.yml"
        );
        const hash = createHash("sha256");
        const contents = await workflowFile?.buffer();
        if (!contents) {
          throw new UserVisibleError(
            "Failed to read workflow file in repository. Instructor: please be sure that the .github/workflows/grade.yml file is present and readable."
          );
        }
        const contentsStr = contents.toString("utf-8");
        // Retrieve the autograder config
        const { data: config } = await adminSupabase.from("autograder").select("*").eq("id", assignment_id).single();
        if (!config) {
          throw new UserVisibleError("Grader config not found");
        }
        hash.update(contentsStr);
        const hashStr = hash.digest("hex");
        if (hashStr !== config.workflow_sha && !isE2ERun) {
          throw new SecurityError(
            `.github/workflows/grade.yml SHA does not match expected value. This file must be the same in student repos as in the grader repo for security reasons. SHA on student repo: ${hashStr} !== SHA in database: ${config.workflow_sha}`
          );
        }
        const pawtograderConfig = config.config as unknown as PawtograderConfig;
        if (!pawtograderConfig) {
          throw new UserVisibleError(
            `Incorrect instructor setup for assignment: no pawtograder config found for grader repo ${config.grader_repo} at SHA ${config.grader_commit_sha}.`
          );
        }
        if (!pawtograderConfig.submissionFiles) {
          throw new UserVisibleError(
            `Incorrect instructor setup for assignment: no submission files set. Pawtograder.yml MUST include a submissionFiles section. Check grader repo: ${config.grader_repo} at SHA ${config.grader_commit_sha}. Include at least one file or glob pattern.`
          );
        }
        const expectedFiles = [
          ...(pawtograderConfig.submissionFiles.files || []),
          ...(pawtograderConfig.submissionFiles.testFiles || [])
        ];

        if (expectedFiles.length === 0) {
          throw new UserVisibleError(
            `Incorrect instructor setup for assignment: no submission files set. Pawtograder.yml MUST include a submissionFiles section. Check grader repo: ${config.grader_repo} at SHA ${config.grader_commit_sha}. Include at least one file or glob pattern.`
          );
        }
        const submittedFiles = zip.files.filter(
          (file: { path: string; type: string }) =>
            file.type === "File" && // Do not submit directories
            expectedFiles.some((pattern) => micromatch.isMatch(stripTopDir(file.path), pattern))
        );
        // Make sure that all files that are NOT glob patterns are present
        const nonGlobFiles = expectedFiles.filter((pattern) => !pattern.includes("*"));
        const allNonGlobFilesPresent = nonGlobFiles.every((file) =>
          submittedFiles.some((submittedFile: { path: string }) => stripTopDir(submittedFile.path) === file)
        );
        if (!allNonGlobFilesPresent) {
          throw new UserVisibleError(
            `Missing required files: ${nonGlobFiles.filter((file) => !submittedFiles.some((submittedFile: { path: string }) => stripTopDir(submittedFile.path) === file)).join(", ")}`
          );
        }

        const submittedFilesWithContents = await Promise.all(
          submittedFiles.map(async (file: { path: string; buffer: () => Promise<Buffer> }) => {
            const contents = await file.buffer();
            return { name: stripTopDir(file.path), contents };
          })
        );
        // Add files to supabase
        const { error: fileError } = await adminSupabase.from("submission_files").insert(
          submittedFilesWithContents.map((file: { name: string; contents: Buffer }) => ({
            submission_id: submission_id,
            name: file.name,
            profile_id: repoData.profile_id,
            assignment_group_id: repoData.assignment_group_id,
            contents: file.contents.toString("utf-8"),
            class_id: repoData.assignments.class_id!
          }))
        );
        if (fileError) {
          throw new UserVisibleError(`Internal error: Failed to insert submission files: ${fileError.message}`);
        }
        if (isE2ERun) {
          return {
            grader_url: "not-a-real-url",
            grader_sha: "not-a-real-sha",
            submission_id: submission_id
          };
        }
        if (!config.grader_repo) {
          throw new UserVisibleError(
            "This assignment is not configured to use an autograder. Please let your instructor know that there is no grader repo configured for this assignment."
          );
        }
        const { download_link: grader_url, sha: grader_sha } = await getRepoTarballURL(config.grader_repo!);
        //Debug-only hack... TODO cleanup
        const patchedURL = grader_url.replace("http://kong:8000", "https://khoury-classroom-dev.ngrok.pizza");
        return {
          grader_url: patchedURL,
          grader_sha
        };
      } catch (err) {
        //Do we still need this?
        console.error(err);
        await adminSupabase.from("grader_results").insert({
          submission_id: submission_id,
          errors:
            err instanceof UserVisibleError
              ? { user_visible_message: err.details }
              : { error: JSON.parse(JSON.stringify(err)) },
          grader_sha: "unknown",
          score: 0,
          ret_code: -1,
          execution_time: 0,
          class_id: repoData.assignments.class_id!,
          lint_passed: true,
          lint_output: "",
          lint_output_format: "text",
          max_score: 0,
          grader_action_sha: "unknown",
          profile_id: repoData.profile_id,
          assignment_group_id: repoData.assignment_group_id
        });

        throw err;
      }
    } else {
      throw new SecurityError(`Repository not found: ${repository}`);
    }
  } catch (err) {
    if (err instanceof UserVisibleError) {
      await recordWorkflowRunError({
        name: err.details,
        data: { type: "user_visible_error" },
        is_private: false
      });
    } else {
      if (err instanceof SecurityError) {
        await recordWorkflowRunError({
          name: err.details,
          data: { type: "security_error" },
          is_private: true
        });
      } else {
        if (err instanceof Error) {
          await recordWorkflowRunError({
            name: err.message,
            data: { error: JSON.parse(JSON.stringify(err)) },
            is_private: true
          });
        } else {
          await recordWorkflowRunError({
            name: "Internal error",
            data: { error: JSON.parse(JSON.stringify(err)) },
            is_private: true
          });
        }
        throw err;
      }
    }
    throw err;
  }
}
Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest, {
    recordUserVisibleErrors: false,
    recordSecurityErrors: false
  });
});
