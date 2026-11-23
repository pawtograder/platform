import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  assertForgejoCourseOrg,
  assertGitHubCourseRepo,
  parseGitProvider,
  repoFilesFor
} from "../_shared/repoFileAccess.ts";
import { assertUserIsInstructor, NotFoundError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as FunctionTypes from "../_shared/FunctionTypes.d.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
// Rate limiting storage: Map<fileKey, timestamp[]>
const rateLimitStore = new Map<string, number[]>();
const RATE_LIMIT_MAX_REQUESTS = 3;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

function cleanupOldEntries(timestamps: number[], currentTime: number): number[] {
  return timestamps.filter((timestamp) => currentTime - timestamp < RATE_LIMIT_WINDOW_MS);
}

function checkRateLimit(orgName: string, repoName: string, path: string): void {
  const fileKey = `${orgName}/${repoName}:${path}`;
  const currentTime = Date.now();

  // Get existing timestamps for this file
  let timestamps = rateLimitStore.get(fileKey) || [];

  // Clean up old entries
  timestamps = cleanupOldEntries(timestamps, currentTime);

  // Check if rate limit is exceeded
  if (timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    throw new Error(
      `Rate limit exceeded: File ${path} in ${orgName}/${repoName} has been requested ${RATE_LIMIT_MAX_REQUESTS} times within the last minute. Please wait before trying again.`
    );
  }

  // Add current timestamp
  timestamps.push(currentTime);
  rateLimitStore.set(fileKey, timestamps);

  // Cleanup old entries from the store periodically
  if (Math.random() < 0.1) {
    // 10% chance to clean up on each request
    for (const [key, ts] of rateLimitStore.entries()) {
      const cleanedTs = cleanupOldEntries(ts, currentTime);
      if (cleanedTs.length === 0) {
        rateLimitStore.delete(key);
      } else {
        rateLimitStore.set(key, cleanedTs);
      }
    }
  }
}

async function handleRequest(req: Request, scope: Sentry.Scope) {
  const { courseId, orgName, repoName, path, skipRetryOnNotFound, gitProvider } =
    (await req.json()) as FunctionTypes.GetFileRequest;
  const provider = parseGitProvider(gitProvider);
  scope?.setTag("function", "repository-get-file");
  scope?.setTag("courseId", courseId.toString());
  scope?.setTag("orgName", orgName);
  scope?.setTag("repoName", repoName);
  scope?.setTag("path", path);
  scope?.setTag("git_provider", provider);
  const { supabase } = await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
  if (provider === "forgejo") {
    await assertForgejoCourseOrg(supabase, courseId, orgName);
  } else {
    await assertGitHubCourseRepo(supabase, courseId, orgName, repoName, { write: false });
  }
  const files = repoFilesFor(provider);

  // Check rate limit before making the GitHub API call
  checkRateLimit(orgName, repoName, path);

  try {
    return await files.getFile(orgName + "/" + repoName, path);
  } catch (error) {
    scope?.setTag("get_file_error", JSON.stringify(error));
    // No GitHub App installation for this org (a course whose org hasn't installed
    // the app, or a synthetic org in e2e). This is an expected, instructor-actionable
    // condition — surface it as a clean 404 instead of a generic 500 that pages us
    // via Sentry.
    if (error instanceof Error && error.message.includes("No octokit found")) {
      scope?.setTag("get_file_no_installation", "true");
      throw new NotFoundError(
        `No GitHub App installation found for organization ${orgName}. Install the Pawtograder GitHub App on ${orgName} to read ${path}.`
      );
    }
    if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 404) {
      scope?.setTag("get_file_error_status", (error as { status: number }).status.toString());
      // The editor's read path opens files that may legitimately not exist yet (create-on-save),
      // so it sets skipRetryOnNotFound to avoid the 15s+retry that otherwise stalls the UI for
      // 15-30s. Other callers (racing fresh repo creation) keep the delayed retry.
      if (skipRetryOnNotFound) {
        throw new NotFoundError(`File ${path} not found in ${orgName}/${repoName}`);
      }
      // Add a delay to help clients get over racing with repo creation
      await new Promise((resolve) => setTimeout(resolve, 15000));

      // Retry the request once after the delay
      try {
        return await files.getFile(orgName + "/" + repoName, path);
      } catch (retryError) {
        if (
          retryError &&
          typeof retryError === "object" &&
          "status" in retryError &&
          (retryError as { status: number }).status === 404
        ) {
          scope?.setTag("get_file_retry_error", JSON.stringify(retryError));
          throw new NotFoundError(`File ${path} not found in ${orgName}/${repoName}`);
        }
        throw retryError;
      }
    }
    throw error;
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
