// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { createHash } from "node:crypto";
import { TZDate } from "npm:@date-fns/tz";
import { addSeconds, format, isAfter } from "npm:date-fns@4";
import micromatch from "npm:micromatch";
import { Open as openZip } from "npm:unzipper";
import { CheckRunStatus } from "../_shared/FunctionTypes.d.ts";
import {
  cloneRepository,
  getRepoTarballURL,
  validateOIDCTokenOrAllowE2E,
  END_TO_END_REPO_PREFIX,
  PrimaryRateLimitError,
  SecondaryRateLimitError
} from "../_shared/GitHubWrapper.ts";
import { SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { PawtograderConfig } from "../_shared/PawtograderYml.d.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { Buffer } from "node:buffer";
import { Json } from "https://esm.sh/@supabase/postgrest-js@1.19.2/dist/cjs/select-query-parser/types.js";
import * as Sentry from "npm:@sentry/deno";

function sha256Hex(buf: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(buf);
  return hash.digest("hex");
}

function computeCombinedFileHash(files: { name: string; contents: Buffer }[]): {
  file_hashes: Record<string, string>;
  combined_hash: string;
} {
  const file_hashes: Record<string, string> = {};
  for (const f of files) {
    file_hashes[f.name] = sha256Hex(f.contents);
  }
  const combinedInput = Object.keys(file_hashes)
    .sort()
    .map((name) => `${name}\0${file_hashes[name]}\n`)
    .join("");
  return {
    file_hashes,
    combined_hash: sha256Hex(Buffer.from(combinedInput, "utf-8"))
  };
}

async function safeCleanupRejectedSubmission(params: {
  adminSupabase: SupabaseClient<Database>;
  submissionId: number;
}) {
  const { adminSupabase, submissionId } = params;
  // Break circular-ish references: submissions.grading_review_id -> submission_reviews
  const { error: updateErr } = await adminSupabase
    .from("submissions")
    .update({ grading_review_id: null, is_active: false })
    .eq("id", submissionId);
  if (updateErr) {
    throw new Error(`Cleanup failed (update submissions): submission_id=${submissionId}: ${updateErr.message}`);
  }

  // Delete any auto-created review row(s) for this submission.
  const { error: reviewsErr } = await adminSupabase
    .from("submission_reviews")
    .delete()
    .eq("submission_id", submissionId);
  if (reviewsErr) {
    throw new Error(`Cleanup failed (delete submission_reviews): submission_id=${submissionId}: ${reviewsErr.message}`);
  }

  // Remove files (these are the only child rows we definitely created in this path).
  const { error: filesErr } = await adminSupabase.from("submission_files").delete().eq("submission_id", submissionId);
  if (filesErr) {
    throw new Error(`Cleanup failed (delete submission_files): submission_id=${submissionId}: ${filesErr.message}`);
  }

  // Finally, remove the submission row itself.
  const { error: deleteErr } = await adminSupabase.from("submissions").delete().eq("id", submissionId);
  if (deleteErr) {
    throw new Error(`Cleanup failed (delete submission): submission_id=${submissionId}: ${deleteErr.message}`);
  }
}

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
  const parts = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return parts.join(" ");
}

// Circuit breaker utility functions
function parseRetryAfterSeconds(error: unknown): number | undefined {
  const err = error as {
    response?: { headers?: Record<string, string> };
    headers?: Record<string, string>;
    message?: string;
  };
  const headers = err?.response?.headers || (err as { headers?: Record<string, string> })?.headers;
  const retryAfter = headers?.["retry-after"] || headers?.["Retry-After"];
  if (retryAfter) {
    const seconds = parseInt(String(retryAfter), 10);
    if (!isNaN(seconds) && seconds >= 0) return seconds;
  }
  // If structured SecondaryRateLimitError with retryAfter, use it
  if (
    (error instanceof SecondaryRateLimitError || error instanceof PrimaryRateLimitError) &&
    typeof (error as { retryAfter?: number }).retryAfter === "number"
  ) {
    return (error as { retryAfter?: number }).retryAfter;
  }
  return undefined;
}

function isSecondaryRateLimit(error: unknown): boolean {
  return error instanceof SecondaryRateLimitError;
}

function isPrimaryRateLimit(error: unknown): boolean {
  return error instanceof PrimaryRateLimitError;
}

function getHeaders(error: unknown): Record<string, string> | undefined {
  const err = error as { response?: { headers?: Record<string, string> } };
  const h = err?.response?.headers;
  if (!h) return undefined;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) lower[k.toLowerCase()] = String(v);
  return lower;
}

function detectRateLimitType(error: unknown): {
  type: "secondary" | "primary" | "extreme" | null;
  retryAfter?: number;
} {
  if (isSecondaryRateLimit(error)) return { type: "secondary", retryAfter: parseRetryAfterSeconds(error) };
  if (isPrimaryRateLimit(error)) return { type: "primary", retryAfter: parseRetryAfterSeconds(error) };
  const err = error as { status?: number; message?: string };
  const status = typeof err?.status === "number" ? err.status : undefined;
  const headers = getHeaders(error);
  const retryAfter = headers ? parseInt(headers["retry-after"] || "", 10) : NaN;
  const remaining = headers ? parseInt(headers["x-ratelimit-remaining"] || "", 10) : NaN;
  const msg = (err?.message || "").toLowerCase();
  const resetHeader = headers?.["x-ratelimit-reset"];
  const untilResetSec = resetHeader
    ? Math.max(0, parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000))
    : undefined;

  if (status === 429) return { type: "secondary", retryAfter: isNaN(retryAfter) ? undefined : retryAfter };
  if (status === 403) {
    if (
      !isNaN(retryAfter) &&
      (isNaN(remaining) || remaining > 0 || msg.includes("secondary rate limit") || msg.includes("abuse"))
    ) {
      return { type: "secondary", retryAfter };
    }
    if (!isNaN(remaining) && remaining === 0) {
      const computed =
        typeof untilResetSec === "number" && !isNaN(untilResetSec)
          ? untilResetSec
          : isNaN(retryAfter)
            ? undefined
            : retryAfter;
      return { type: "primary", retryAfter: computed };
    }
  }
  return { type: null };
}

function computeBackoffSeconds(baseSeconds: number | undefined, retryCount: number): number {
  const base = Math.max(5, baseSeconds ?? 60);
  const exp = Math.min(6, Math.max(0, retryCount));
  const backoff = Math.min(900, base * Math.pow(2, exp));
  const jitter = Math.floor(Math.random() * Math.floor(backoff / 4));
  return backoff + jitter;
}

async function recordGitHubAsyncError(
  adminSupabase: SupabaseClient<Database>,
  org: string,
  method: string,
  error: unknown,
  scope: Sentry.Scope
) {
  try {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorData = {
      method,
      error_message: errorMessage,
      error_type: error instanceof Error ? error.constructor.name : "Unknown"
    };

    const { error: recordError } = await adminSupabase.schema("public").rpc("record_github_async_error", {
      p_org: org,
      p_method: method,
      p_error_data: errorData as unknown as Json
    });
    if (recordError) {
      scope.setContext("error_recording_failed_rpc", { rpc_error: recordError.message });
      Sentry.captureException(recordError, scope);
    }
  } catch (e) {
    scope.setContext("error_recording_failed", {
      original_error: error instanceof Error ? error.message : String(error),
      recording_error: e instanceof Error ? e.message : String(e)
    });
    Sentry.captureException(e, scope);
  }
}

async function checkAndTripErrorCircuitBreaker(
  adminSupabase: SupabaseClient<Database>,
  org: string,
  scope: Sentry.Scope
): Promise<boolean> {
  try {
    const result = await adminSupabase.schema("public").rpc("check_github_error_threshold", {
      p_org: org,
      p_threshold: 5,
      p_window_minutes: 5
    });

    if (result.error) {
      Sentry.captureException(result.error, scope);
      return false;
    }

    const errorCount = result.data as number;
    if (errorCount >= 20) {
      // Trip the circuit breaker for 8 hours
      const tripResult = await adminSupabase.schema("public").rpc("open_github_circuit", {
        p_scope: "org",
        p_key: org,
        p_event: "error_threshold",
        p_retry_after_seconds: 28800, // 8 hours
        p_reason: `Error threshold exceeded: ${errorCount} errors in 5 minutes`
      });

      if (!tripResult.error) {
        // Log special error to Sentry
        scope.setTag("circuit_breaker_reason", "error_threshold");
        scope.setContext("error_threshold_breach", {
          org,
          error_count: errorCount,
          window_minutes: 5,
          circuit_duration_hours: 8
        });

        Sentry.captureMessage(
          `Autograder circuit breaker tripped for org ${org}: ${errorCount} errors in 5 minutes. Circuit open for 8 hours.`,
          {
            level: "error"
          }
        );

        return true;
      }
    }

    return false;
  } catch (e) {
    scope.setContext("circuit_check_error", {
      org,
      error_message: e instanceof Error ? e.message : String(e)
    });
    Sentry.captureException(e, scope);
    return false;
  }
}

// Wrapper function to handle GitHub API calls with circuit breaker logic
async function handleGitHubApiCall<T>(
  operation: () => Promise<T>,
  org: string,
  method: string,
  adminSupabase: SupabaseClient<Database>,
  scope: Sentry.Scope,
  retryCount: number = 0
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    console.trace(error);
    const rt = detectRateLimitType(error);
    scope.setTag("rate_limit_type", rt.type);
    scope.setTag("github_api_method", method);
    Sentry.captureException(error, scope);

    // Handle rate limits with circuit breaker logic
    if (rt.type === "secondary" || rt.type === "primary" || rt.type === "extreme") {
      const retryAfter = rt.retryAfter;
      // Defaults: primary=60s, secondary=180s, extreme=43200s (12h)
      const baseDefault = rt.type === "primary" ? 60 : rt.type === "secondary" ? 180 : 43200;
      const delay = rt.type === "extreme" ? baseDefault : computeBackoffSeconds(retryAfter ?? baseDefault, retryCount);
      const type = rt.type;
      scope.setTag("rate_limit", type);
      scope.setContext("rate_limit_detail", {
        type,
        retry_after: retryAfter,
        delay_seconds: delay,
        retry_count: retryCount
      });

      // Open circuit for this org
      try {
        const { data: tripCountResult, error: tripErr } = await adminSupabase
          .schema("public")
          .rpc("open_github_circuit", {
            p_scope: "org",
            p_key: org,
            p_event: type,
            p_retry_after_seconds: retryAfter || delay,
            p_reason:
              type === "secondary"
                ? "secondary_rate_limit"
                : type === "primary"
                  ? "primary_rate_limit"
                  : "extreme_rate_limit"
          });
        const tripCount = tripErr ? undefined : tripCountResult;
        if (tripCount) {
          Sentry.addBreadcrumb({ message: `Circuit trip #${tripCount} for ${org} (${type})`, level: "warning" });
          scope.setTag("circuit_trip_count", String(tripCount));
          if (tripCount >= 5) {
            Sentry.captureMessage(`Elevated circuit to 24h for ${org} after ${tripCount} trips`, {
              level: "error"
            });
          }
        }
      } catch (e) {
        console.error("error", e);
        Sentry.captureException(e, scope);
      }

      // Check if we should trip the circuit breaker due to error threshold (8 hours)
      const circuitTripped = await checkAndTripErrorCircuitBreaker(adminSupabase, org, scope);
      if (circuitTripped) {
        throw new UserVisibleError(
          `GitHub operations temporarily unavailable due to repeated errors. Please try again in 8 hours.`
        );
      }

      // Throw rate limit error with user-friendly message
      const retryTime = new Date(Date.now() + delay * 1000).toLocaleString();
      throw new UserVisibleError(
        `GitHub API rate limit reached. Please try again after ${retryTime}. Rate limit type: ${type}`
      );
    }

    // For non-rate-limit errors, record the error and check circuit breaker
    await recordGitHubAsyncError(adminSupabase, org, method, error, scope);

    // Immediately open circuit breaker for 30 seconds on any error
    try {
      await adminSupabase.schema("public").rpc("open_github_circuit", {
        p_scope: "org",
        p_key: org,
        p_event: "immediate_error",
        p_retry_after_seconds: 30,
        p_reason: `Immediate circuit breaker: ${method} error - ${error instanceof Error ? error.message : String(error)}`
      });

      scope.setTag("immediate_circuit_breaker", "30s");
      scope.setContext("immediate_circuit_detail", {
        org,
        method: method,
        duration_seconds: 30,
        error_message: error instanceof Error ? error.message : String(error)
      });
    } catch (e) {
      console.error("Failed to open immediate circuit breaker:", e);
      Sentry.captureException(e, scope);
    }

    // Check if we should trip the circuit breaker due to error threshold (8 hours)
    const circuitTripped = await checkAndTripErrorCircuitBreaker(adminSupabase, org, scope);
    if (circuitTripped) {
      throw new UserVisibleError(
        `GitHub operations temporarily unavailable due to repeated errors. Please try again in 8 hours.`
      );
    }

    // Re-throw the original error
    throw error;
  }
}

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

async function handleRequest(req: Request, scope: Sentry.Scope) {
  scope?.setTag("function", "autograder-create-submission");
  const token = req.headers.get("Authorization");
  if (!token) {
    throw new UserVisibleError("No token provided", 400);
  }
  // Check if this is part of an
  const decoded = await validateOIDCTokenOrAllowE2E(token);
  const { repository, sha, workflow_ref, run_id, run_attempt } = decoded;
  const isE2ERun = repository.startsWith(END_TO_END_REPO_PREFIX); //Don't write back to GitHub for E2E runs, just pull
  const isPawtograderTriggered = decoded.actor === "pawtograder[bot]" || decoded.actor === "pawtograder-next[bot]";
  scope?.setTag("actor", decoded.actor);
  scope?.setTag("repository", repository);
  scope?.setTag("sha", sha);
  scope?.setTag("workflow_ref", workflow_ref);
  scope?.setTag("run_id", run_id);
  scope?.setTag("run_attempt", run_attempt);
  scope?.setTag("is_e2e_run", isE2ERun.toString());

  // Circuit breaker: check if org-level circuit is open for GitHub API calls
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  const org = repository.split("/")[0];
  scope?.setTag("org", org);

  try {
    const circ = await adminSupabase.schema("public").rpc("get_github_circuit", { p_scope: "org", p_key: org });
    if (!circ.error && Array.isArray(circ.data) && circ.data.length > 0) {
      const row = circ.data[0] as { state?: string; open_until?: string; reason?: string };
      if (row?.state === "open" && (!row.open_until || new Date(row.open_until) > new Date())) {
        scope.setTag("circuit_state", "open");
        scope.setContext("circuit_breaker_active", {
          org,
          reason: row.reason || "Circuit breaker active",
          open_until: row.open_until
        });

        // Circuit breaker is open - fail fast with user-visible error
        const openUntil = row.open_until ? new Date(row.open_until) : new Date(Date.now() + 3600000); // 1 hour default
        throw new UserVisibleError(
          `GitHub operations are temporarily unavailable for organization ${org} due to rate limiting or errors. Please try again after ${openUntil.toLocaleString()}. Reason: ${row.reason || "Circuit breaker active"}`
        );
      }
    }
  } catch (e) {
    // If it's already a UserVisibleError from circuit breaker, re-throw it
    if (e instanceof UserVisibleError) {
      throw e;
    }
    // Circuit check failure should not break processing; log and continue
    scope.setContext("circuit_check_warning", {
      org,
      error_message: e instanceof Error ? e.message : String(e)
    });
    Sentry.captureException(e, scope);
  }
  // Find the corresponding student and assignment
  console.log("Creating submission for", repository, sha, workflow_ref);
  // const checkRunID = await GitHubController.getInstance().createCheckRun(repository, sha, workflow_ref);
  const { data: repoData, error: repoError } = await adminSupabase
    .from("repositories")
    .select("*, assignments(class_id, due_date, allow_not_graded_submissions, permit_empty_submissions, autograder(*))")
    .eq("repository", repository)
    .maybeSingle();
  if (repoError) {
    Sentry.captureException(repoError, scope);
    throw new UserVisibleError(`Failed to query repositories: ${repoError.message}`);
  }

  if (repoData) {
    scope?.setTag("assignment_id", repoData.assignment_id.toString());
    scope?.setTag("class_id", repoData.assignments.class_id?.toString() || "unknown");
    scope?.setTag("profile_id", repoData.profile_id || "none");
    scope?.setTag("assignment_group_id", repoData.assignment_group_id?.toString() || "none");
  }

  // If repository isn't a student repo, check if it's a handout (template) repo for any assignment(s)
  if (!repoData) {
    const { data: handoutAssignments, error: handoutLookupError } = await adminSupabase
      .from("assignments")
      .select("id, title, slug, classes(name, term)")
      .eq("template_repo", repository);
    if (handoutLookupError) {
      Sentry.captureException(handoutLookupError, scope);
      throw new UserVisibleError(`Failed to check handout repository: ${handoutLookupError.message}`);
    }
    if (handoutAssignments && handoutAssignments.length > 0) {
      // Return special handout notice response; autograder action should treat this as terminal
      return {
        grader_url: "",
        grader_sha: "",
        handout_notice: {
          message:
            "Detected this is a handout repository. The grader will not run on handout repos. It will run on the corresponding student repositories for the assignment(s) below.",
          assignments: handoutAssignments.map((a) => ({
            id: a.id,
            title: a.title,
            slug: a.slug,
            class_name: a.classes?.name,
            semester: a.classes?.term
          }))
        }
      };
    }
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
      name: name.length > 500 ? name.slice(0, 500) : name,
      data,
      is_private
    });
    if (workflowRunErrorError) {
      // Ignore duplicate workflow run errors (constraint: workflow_run_error_repo_run_attempt_name_key)
      // This can happen when GitHub retries the workflow run
      if (workflowRunErrorError.code === "23505") {
        console.log(`Workflow run error already exists, ignoring duplicate: ${name}`);
      } else if (workflowRunErrorError.code === "23503" && workflowRunErrorError.details?.includes("submission_id")) {
        // FK violation on submission_id: submission was already deleted (e.g. empty submission rejected).
        // Log but don't throw - caller should propagate the original user-visible error.
        console.log(`Cannot record workflow run error: submission no longer exists (${workflowRunErrorError.message})`);
        Sentry.captureException(workflowRunErrorError, scope);
      } else {
        console.error(workflowRunErrorError);
        Sentry.captureException(workflowRunErrorError, scope);
        throw new Error(`Internal error: Failed to insert workflow run error: ${workflowRunErrorError.message}`);
      }
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
        const { data: initialCheckRun, error: checkRunError } = await adminSupabase
          .from("repository_check_runs")
          .select("*, classes(time_zone), commit_message")
          .eq("repository_id", repoData.id)
          .eq("sha", sha)
          .order("created_at", { ascending: false }) // Order by most recent first
          .limit(1)
          .maybeSingle();

        if (checkRunError) {
          Sentry.captureException(checkRunError, scope);
          throw new UserVisibleError(`Failed to find check run for ${repoData.id}@${sha}: ${checkRunError.message}`);
        }

        if (!initialCheckRun) {
          scope?.setTag("check_run_db_found", "false");
          throw new UserVisibleError(
            `No push record found for ${repository}@${sha}. The webhook may not have processed yet. Please try again.`
          );
        }

        // Fetch the role of the user who triggered the workflow (decoded.actor = GitHub username)
        let userRoles: Database["public"]["Tables"]["user_roles"]["Row"] | undefined;
        const classId = initialCheckRun.class_id ?? repoData.assignments.class_id;
        if (classId && !isPawtograderTriggered) {
          const { data: user } = await adminSupabase
            .from("users")
            .select("user_id")
            .eq("github_username", decoded.actor)
            .maybeSingle();
          if (user) {
            const { data: userRolesData } = await adminSupabase
              .from("user_roles")
              .select("*")
              .eq("user_id", user.user_id)
              .eq("class_id", classId)
              .maybeSingle();
            userRoles = userRolesData ?? undefined;
          }
        }

        return { ...initialCheckRun, user_roles: userRoles };
      };

      const checkRun = await retryWithExponentialBackoff(fetchCheckRun, 5, 1000);
      const timeZone = checkRun.classes.time_zone || "America/New_York";
      const isRegressionRerun = Boolean(checkRun.is_regression_rerun && checkRun.target_submission_id);
      const rerunTargetSubmissionId = checkRun.target_submission_id ?? null;

      // Check if this is a NOT-GRADED submission
      const isNotGradedSubmission =
        (checkRun.commit_message && checkRun.commit_message.toUpperCase().includes("#NOT-GRADED")) || false;

      scope?.setTag("time_zone", timeZone);
      scope?.setTag("is_not_graded", isNotGradedSubmission.toString());
      scope?.setTag("user_role", checkRun.user_roles?.role || "unknown");
      scope?.setTag("is_regression_rerun", isRegressionRerun.toString());
      if (rerunTargetSubmissionId) {
        scope?.setTag("rerun_target_submission_id", rerunTargetSubmissionId.toString());
      }

      // Validate that the submission can be created
      if (
        !isRegressionRerun &&
        (!checkRun.user_roles ||
          (checkRun.user_roles.role !== "instructor" &&
            checkRun.user_roles.role !== "grader" &&
            !isPawtograderTriggered))
      ) {
        // Check if it's too late to submit using the lab-aware due date calculation
        console.log(`Timezone: ${timeZone}`);
        console.log(`Assignment ID: ${repoData.assignment_id}`);
        console.log(`Profile ID: ${repoData.profile_id}`);
        console.log(`Assignment Group ID: ${repoData.assignment_group_id}`);

        let profileId = repoData.profile_id;
        if (!profileId) {
          // Use the first profile ID for a user in the assignment group
          const { data: assignmentGroupmembers, error: assignmentGroupmembersError } = await adminSupabase
            .from("assignment_groups_members")
            .select("profile_id")
            .eq("assignment_group_id", repoData.assignment_group_id!)
            .limit(1)
            .maybeSingle();
          if (assignmentGroupmembersError) {
            throw new UserVisibleError(
              `Failed to find assignment group members: ${assignmentGroupmembersError.message}`
            );
          }
          if (assignmentGroupmembers) {
            profileId = assignmentGroupmembers.profile_id;
          }
        }
        // Use the database function to calculate the final due date (includes lab scheduling + extensions)
        const { data: finalDueDateResult, error: dueDateError } = await adminSupabase.rpc("calculate_final_due_date", {
          assignment_id_param: repoData.assignment_id,
          student_profile_id_param: profileId || "0xd34db34f",
          assignment_group_id_param: repoData.assignment_group_id || undefined
        });

        if (dueDateError) {
          throw new UserVisibleError(`Failed to calculate due date: ${dueDateError.message}`);
        }

        const finalDueDate = new TZDate(finalDueDateResult);
        //Convert to course time zone for display purposes
        const finalDueDateInCourseTimeZone = new TZDate(finalDueDateResult, timeZone);
        console.log(`Final due date in course time zone: ${finalDueDateInCourseTimeZone.toLocaleString()}`);
        // Use push timestamp (when webhook received the push) for late detection, not current time
        const pushTime = checkRun?.created_at ? new TZDate(checkRun.created_at, timeZone) : TZDate.tz(timeZone);

        if (isAfter(pushTime, finalDueDate)) {
          // Check if this is a NOT-GRADED submission and if the assignment allows it
          if (isNotGradedSubmission && repoData.assignments.allow_not_graded_submissions) {
            // Allow NOT-GRADED submissions after deadline
          } else if (isNotGradedSubmission && !repoData.assignments.allow_not_graded_submissions) {
            throw new UserVisibleError(
              "This assignment does not allow NOT-GRADED submissions. Please contact your instructor if you need an extension.",
              400
            );
          } else {
            //Fail the check run

            //For usability, we should check to see if the user finalized their submission early, and if so, show THAT message
            let query = adminSupabase
              .from("assignment_due_date_exceptions")
              .select("*")
              .eq("assignment_id", repoData.assignment_id);
            if (repoData.assignment_group_id) {
              query = query.eq("assignment_group_id", repoData.assignment_group_id);
            } else if (repoData.profile_id) {
              query = query.eq("student_id", repoData.profile_id!);
            } else {
              throw new UserVisibleError("No assignment group or profile ID found for submission.");
            }
            const { data: negativeDueDateExceptions, error: negativeDueDateExceptionsError } = await query.limit(1000);
            if (negativeDueDateExceptionsError) {
              Sentry.captureException(negativeDueDateExceptionsError, scope);
              throw new UserVisibleError(
                `Internal error: Failed to find negative due date exceptions: ${negativeDueDateExceptionsError.message}`
              );
            }
            let errorMessage = `You cannot submit after the due date. Your due date: ${finalDueDateInCourseTimeZone.toLocaleString()}, push time: ${pushTime.toLocaleString()}`;
            if (negativeDueDateExceptions && negativeDueDateExceptions.length > 0) {
              const hasNegativeException = negativeDueDateExceptions.some(
                (exception) => exception.hours < 0 || exception.minutes < 0
              );
              if (hasNegativeException) {
                errorMessage =
                  "You have already finalized your submission for this assignment. You cannot submit additional code after finalization.";
              }
            }
            throw new UserVisibleError(errorMessage, 400);
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
            .select("*, grader_results!grader_results_submission_id_fkey(*)")
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

            throw new UserVisibleError(
              `Submission limit reached (max ${repoData.assignments.autograder.max_submissions_count} submissions per ${formatSeconds(repoData.assignments.autograder.max_submissions_period_secs)}). Please wait until ${format(nextAllowedSubmission, "MM/dd/yyyy HH:mm")} to submit again.`,
              400
            );
          }
        }
      }

      if (!isRegressionRerun) {
        // First check if there's an existing submission with this unique key
        const { data: existingSubmission } = await adminSupabase
          .from("submissions")
          .select("id, created_at")
          .eq("repository", repository)
          .eq("sha", sha)
          .eq("run_number", Number.parseInt(decoded.run_id))
          .eq("run_attempt", Number.parseInt(decoded.run_attempt))
          .maybeSingle();

        if (existingSubmission) {
          // Check if the existing submission was created less than 3 minutes ago
          const createdAt = new Date(existingSubmission.created_at);
          const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);

          if (createdAt < threeMinutesAgo) {
            scope?.setTag("db_error", "duplicate_submission_too_old");
            throw new UserVisibleError(
              `A submission with the same run number and attempt already exists and was created more than 3 minutes ago. Cannot recreate this submission. Re-trigger the action to make a new submission.`,
              409
            );
          }

          // Clean up existing data for this submission
          console.log(`Reusing existing submission ${existingSubmission.id}, cleaning up old data`);
          scope?.addBreadcrumb({
            category: "duplicate_submission",
            level: "info",
            message: `Reusing existing submission ${existingSubmission.id}, cleaning up old data`,
            data: { submission_id: existingSubmission.id }
          });

          // Delete related data
          const { error: deleteSubmissionFilesError } = await adminSupabase
            .from("submission_files")
            .delete()
            .eq("submission_id", existingSubmission.id);
          if (deleteSubmissionFilesError) {
            console.error(deleteSubmissionFilesError);
            Sentry.captureException(deleteSubmissionFilesError, scope);
            throw new UserVisibleError(`Failed to delete submission files: ${deleteSubmissionFilesError.message}`);
          }

          const { error: deleteSubmissionArtifactsError } = await adminSupabase
            .from("submission_artifacts")
            .delete()
            .eq("submission_id", existingSubmission.id);
          if (deleteSubmissionArtifactsError) {
            console.error(deleteSubmissionArtifactsError);
            Sentry.captureException(deleteSubmissionArtifactsError, scope);
            throw new UserVisibleError(
              `Failed to delete submission artifacts: ${deleteSubmissionArtifactsError.message}`
            );
          }

          const { error: deleteGraderResultsError } = await adminSupabase
            .from("grader_results")
            .delete()
            .eq("submission_id", existingSubmission.id);
          if (deleteGraderResultsError) {
            console.error(deleteGraderResultsError);
            Sentry.captureException(deleteGraderResultsError, scope);
            throw new UserVisibleError(`Failed to delete grader results: ${deleteGraderResultsError.message}`);
          }

          const { error: deleteWorkflowRunErrorsError } = await adminSupabase
            .from("workflow_run_error")
            .delete()
            .eq("submission_id", existingSubmission.id);
          if (deleteWorkflowRunErrorsError) {
            console.error(deleteWorkflowRunErrorsError);
            Sentry.captureException(deleteWorkflowRunErrorsError, scope);
            throw new UserVisibleError(`Failed to delete workflow run errors: ${deleteWorkflowRunErrorsError.message}`);
          }
        }

        // Create or reuse submission
        if (existingSubmission) {
          // Reuse the existing submission ID
          submission_id = existingSubmission.id;
        } else {
          // Insert a new submission
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
            Sentry.captureException(error, scope);
            console.error(error);
            throw new UserVisibleError(`Failed to create submission for repository ${repository}: ${error.message}`);
          }
          submission_id = subID?.id;
        }
      }

      if (submission_id) {
        scope?.setTag("submission_id", submission_id.toString());
      }

      console.log(`Created submission ${submission_id} for repository ${repository}`);
      if (checkRun && !isE2ERun && !isRegressionRerun) {
        await adminSupabase
          .from("repository_check_runs")
          .update({
            status: {
              ...(checkRun.status as CheckRunStatus),
              started_at: new Date().toISOString()
            }
          })
          .eq("id", checkRun.id);
      }

      try {
        // Clone the repository
        const repoToClone = getRepoToCloneConsideringE2E(repository);
        const repo = await handleGitHubApiCall(
          () => cloneRepository(repoToClone, isE2ERun ? "HEAD" : sha),
          org,
          "cloneRepository",
          adminSupabase,
          scope
        );
        const zip = await openZip.buffer(repo);
        const stripTopDir = (str: string) => str.split("/").slice(1).join("/");

        // Check the SHA
        const workflowFile = zip.files.find(
          (file: { path: string }) => stripTopDir(file.path) === ".github/workflows/grade.yml"
        );
        const contents = await workflowFile?.buffer();
        if (!contents) {
          throw new UserVisibleError(
            "Failed to read workflow file in repository. Instructor: please be sure that the .github/workflows/grade.yml file is present and readable.",
            400
          );
        }
        const contentsStr = contents.toString("utf-8");
        // Calculate hash with original contents
        const hash = createHash("sha256");
        hash.update(contentsStr);
        const hashStr = hash.digest("hex");

        // Calculate hash with all whitespace removed
        const contentsNoWhitespace = contentsStr.replace(/\s+/g, "");
        const hashNoWhitespace = createHash("sha256");
        hashNoWhitespace.update(contentsNoWhitespace);
        const hashStrNoWhitespace = hashNoWhitespace.digest("hex");

        // Retrieve the autograder config
        const { data: config } = await adminSupabase.from("autograder").select("*").eq("id", assignment_id).single();
        if (!config) {
          throw new UserVisibleError("Grader config not found");
        }

        // Allow graders and instructors to submit even if the workflow SHA doesn't match, but show a warning.
        const isGraderOrInstructor =
          checkRun.user_roles?.role === "instructor" || checkRun.user_roles?.role === "grader";
        scope.setTag("check_run_profile_id", checkRun.profile_id);
        scope.setTag("check_run_assignment_group_id", checkRun.assignment_group_id);
        scope.setTag("check_run_user_role", checkRun.user_roles?.role);
        if (
          hashStrNoWhitespace !== config.workflow_sha &&
          hashStr !== config.workflow_sha &&
          !isE2ERun &&
          !isNotGradedSubmission
        ) {
          scope.setTag("hash_in_db", config.workflow_sha);
          scope.setTag("hash_in_student_repo", hashStr);
          const errorMessage = `.github/workflows/grade.yml SHA does not match expected value. This file must be the same in student repos as in the grader repo for security reasons. SHA on student repo: ${hashStr} !== SHA in database: ${config.workflow_sha}.`;
          Sentry.captureMessage("workflow sha mismatch", scope);
          if (isGraderOrInstructor) {
            await recordWorkflowRunError({
              name: `.github/workflows/grade.yml SHA is different from that in handout!!! You are a grader or instructor, so this submission is permitted. But, if a student has this same workflow file, they will get a big nasty error. Please be sure to update the handout to match this repo's workflow, which will avoid this error.`,
              data: {
                type: "security_error"
              },
              is_private: true
            });
          } else {
            throw new SecurityError(errorMessage);
          }
        }
        const pawtograderConfig = config.config as unknown as PawtograderConfig;
        if (!isRegressionRerun) {
          if (!pawtograderConfig) {
            throw new UserVisibleError(
              `Incorrect instructor setup for assignment: no pawtograder config found for grader repo ${config.grader_repo} at SHA ${config.grader_commit_sha}.`,
              400
            );
          }
          if (!pawtograderConfig.submissionFiles) {
            throw new UserVisibleError(
              `Incorrect instructor setup for assignment: no submission files set. Pawtograder.yml MUST include a submissionFiles section. Check grader repo: ${config.grader_repo} at SHA ${config.grader_commit_sha}. Include at least one file or glob pattern.`,
              400
            );
          }
          const expectedFiles = [
            ...(pawtograderConfig.submissionFiles.files || []),
            ...(pawtograderConfig.submissionFiles.testFiles || [])
          ];

          if (expectedFiles.length === 0) {
            throw new UserVisibleError(
              `Incorrect instructor setup for assignment: no submission files set. Pawtograder.yml MUST include a submissionFiles section. Check grader repo: ${config.grader_repo} at SHA ${config.grader_commit_sha}. Include at least one file or glob pattern.`,
              400
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
            //Add a placeholder grader result so that this is not marked as a catastrophic failure
            const { error: graderResultError } = await adminSupabase.from("grader_results").insert({
              submission_id: submission_id,
              errors: {
                error: `Missing required files: ${nonGlobFiles.filter((file) => !submittedFiles.some((submittedFile: { path: string }) => stripTopDir(submittedFile.path) === file)).join(", ")}`
              },
              score: 0,
              ret_code: 101,
              lint_output: "",
              lint_output_format: "text",
              lint_passed: false,
              class_id: repoData.assignments.class_id!,
              profile_id: repoData.profile_id,
              assignment_group_id: repoData.assignment_group_id
            });
            if (graderResultError) {
              Sentry.captureException(graderResultError, scope);
            }
            throw new UserVisibleError(
              `Missing required files: ${nonGlobFiles.filter((file) => !submittedFiles.some((submittedFile: { path: string }) => stripTopDir(submittedFile.path) === file)).join(", ")}`,
              400
            );
          }

          const submittedFilesWithContents = await Promise.all(
            submittedFiles.map(async (file: { path: string; buffer: () => Promise<Buffer> }) => {
              const contents = await file.buffer();
              return { name: stripTopDir(file.path), contents };
            })
          );
          const { combined_hash: submissionCombinedHash } = computeCombinedFileHash(submittedFilesWithContents);
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

          // Empty submission detection:
          // If the submitted expected files match ANY recorded handout version for the assignment,
          // mark the submission as empty.
          const { data: match, error: matchError } = await adminSupabase
            .from("assignment_handout_file_hashes")
            .select("id")
            .eq("assignment_id", repoData.assignment_id)
            .eq("combined_hash", submissionCombinedHash)
            .limit(1)
            .maybeSingle();
          if (matchError) {
            Sentry.captureException(matchError, scope);
          }
          const isEmpty = !!match;
          if (submission_id !== undefined) {
            const { error: updateError } = await adminSupabase
              .from("submissions")
              .update({ is_empty_submission: isEmpty })
              .eq("id", submission_id);
            if (updateError) {
              Sentry.captureException(updateError, scope);
            }
          }

          // If the assignment prohibits empty submissions, reject after determining emptiness.
          // (Allow graders/instructors to bypass to avoid breaking staff workflows.)
          const isGraderOrInstructor =
            checkRun.user_roles?.role === "instructor" || checkRun.user_roles?.role === "grader";
          if (isEmpty && repoData.assignments.permit_empty_submissions === false && !isGraderOrInstructor) {
            if (submission_id === undefined) {
              throw new Error("submission_id is undefined during empty submission rejection");
            }
            try {
              await safeCleanupRejectedSubmission({ adminSupabase, submissionId: submission_id });
            } catch (cleanupErr) {
              Sentry.captureException(cleanupErr, scope);
            }
            throw new UserVisibleError(
              "Empty submissions are not permitted for this assignment. Please commit your changes before submitting.",
              400
            );
          }
          if (isE2ERun && submission_id !== undefined) {
            return {
              grader_url: "not-a-real-url",
              grader_sha: "not-a-real-sha",
              submission_id
            };
          }
        }
        if (!config.grader_repo) {
          throw new UserVisibleError(
            "This assignment is not configured to use an autograder. Please let your instructor know that there is no grader repo configured for this assignment.",
            400
          );
        }
        const requestedGraderSha = isRegressionRerun ? (checkRun.requested_grader_sha ?? undefined) : undefined;
        const { download_link: grader_url, sha: grader_sha } = await handleGitHubApiCall(
          () => getRepoTarballURL(config.grader_repo!, requestedGraderSha),
          org,
          "getRepoTarballURL",
          adminSupabase,
          scope
        );
        //Debug-only hack... TODO cleanup
        const patchedURL = grader_url.replace("http://kong:8000", "https://khoury-classroom-dev.ngrok.pizza");
        return {
          grader_url: patchedURL,
          grader_sha
        };
      } catch (err) {
        console.error(err);
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
