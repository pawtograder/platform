import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import { assertUserIsInstructor, NotFoundError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import * as FunctionTypes from "../_shared/FunctionTypes.d.ts";
import * as Sentry from "npm:@sentry/deno";
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
  const { courseId, orgName, repoName, path } = (await req.json()) as FunctionTypes.GetFileRequest;
  scope?.setTag("function", "repository-get-file");
  scope?.setTag("courseId", courseId.toString());
  scope?.setTag("orgName", orgName);
  scope?.setTag("repoName", repoName);
  scope?.setTag("path", path);
  const { supabase } = await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
  const courseOrgName = await supabase.from("classes").select("github_org").eq("id", courseId).single();
  if (courseOrgName.data?.github_org != orgName && orgName != "pawtograder") {
    throw new Error(
      `Requested a file from ${orgName}/${repoName} but the course is associated with ${courseOrgName.data?.github_org}`
    );
  }

  // Check rate limit before making the GitHub API call
  checkRateLimit(orgName, repoName, path);

  try {
    return await github.getFileFromRepo(orgName + "/" + repoName, path);
  } catch (error) {
    if (error && typeof error === "object" && "status" in error && (error as { status: number }).status === 404) {
      // Add a delay to help clients get over racing with repo creation
      await new Promise((resolve) => setTimeout(resolve, 15000));

      // Retry the request once after the delay
      try {
        return await github.getFileFromRepo(orgName + "/" + repoName, path);
      } catch (retryError) {
        if (
          retryError &&
          typeof retryError === "object" &&
          "status" in retryError &&
          (retryError as { status: number }).status === 404
        ) {
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
