#!/usr/bin/env -S deno run --allow-env --allow-net

/**
 * TriggerBulkSubmissions - Deno script to trigger multiple grading workflows
 *
 * Usage:
 *   # Basic usage with defaults (10 submissions, 60 per minute)
 *   deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts <submission_id>
 *
 *   # Custom parameters
 *   deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts <submission_id> <max_per_minute> <total_submissions> [concurrency]
 *
 *   # Example: 200 submissions at 120 per minute
 *   deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts 123 120 200
 *
 * Parameters:
 *   submission_id: The submission ID to trigger (required)
 *   max_per_minute: Maximum submissions per minute (default: 60)
 *   total_submissions: Total number of submissions to make (default: 10)
 *   concurrency: Maximum in-flight dispatches (default: derived from max_per_minute)
 *
 * Environment Variables (from .env.local):
 *   SUPABASE_URL: Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY: Supabase service role key for database access
 *   GITHUB_APP_ID: GitHub App ID
 *   GITHUB_PRIVATE_KEY_STRING: GitHub App private key
 *
 * The script fetches the actual repository and SHA from the database, creates the
 * submission tag once, then issues one workflow dispatch per submission.
 *
 * Why this does not call `triggerWorkflow` from GitHubWrapper: that helper creates the
 * tag object and ref on every call (three write requests per submission, two of which are
 * redundant here because every iteration reuses the same repo and SHA), and it runs through
 * the shared Redis-backed @octokit/plugin-throttling limiter. That limiter serializes writes
 * at one per second across every edge replica, so it capped this script at ~20 submissions
 * per minute no matter what was requested, and stole write budget from production while it
 * ran. This script uses its own unthrottled installation client and paces itself, so
 * `max_per_minute` is the real throughput knob.
 *
 * GitHub's secondary rate limit for content-creating requests is about 80 per minute per
 * installation; above that expect 403s and retries.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import { createAppAuth } from "https://esm.sh/@octokit/auth-app?dts";
import { Octokit } from "https://esm.sh/octokit?dts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

interface Args {
  submissionId: number;
  maxPerMinute: number;
  totalSubmissions: number;
  concurrency: number;
}

interface SubmissionData {
  id: number;
  repository: string;
  sha: string;
}

const WORKFLOW_NAME = "grade.yml";
const MAX_ATTEMPTS = 4;
const SECONDARY_LIMIT_WARNING_THRESHOLD = 80;

// Octokit defaults to 2022-11-28, which GitHub deprecated when 2026-03-10 shipped; every
// request then comes back with Deprecation/Sunset headers and @octokit/request logs a
// warning per call. Pinning the current version silences that and opts into its behavior:
// `GET /rate_limit` drops the top-level `rate` property (read `resources.core` instead) and
// workflow dispatches return 200 with the run details rather than an empty 204.
const API_VERSION_HEADER = { "X-GitHub-Api-Version": "2026-03-10" };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Retry-After (seconds) or x-ratelimit-reset (epoch seconds) from a GitHub error response,
 * converted to milliseconds to wait. GitHub sends one or the other on a 403/429.
 */
function retryDelayFromHeaders(error: unknown): number | undefined {
  const headers = (error as { response?: { headers?: Record<string, string> } })?.response?.headers;
  if (!headers) {
    return undefined;
  }
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter * 1000;
  }
  const reset = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - Date.now());
  }
  return undefined;
}

function isRetryable(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === undefined) {
    // Network-level failure (connection reset, DNS, timeout) — worth another try.
    return true;
  }
  return status === 403 || status === 429 || status >= 500;
}

/**
 * Evenly paced admission control. Each caller reserves the next slot synchronously, so
 * concurrent workers can never claim the same one, then sleeps until that slot opens.
 */
class Pacer {
  private nextSlot = Date.now();
  private readonly intervalMs: number;

  constructor(maxPerMinute: number) {
    this.intervalMs = 60000 / maxPerMinute;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(this.nextSlot, now);
    this.nextSlot = slot + this.intervalMs;
    if (slot > now) {
      await sleep(slot - now);
    }
  }
}

function parseArgs(): Args {
  const args = Deno.args;

  if (args.length < 1) {
    console.error(
      "Usage: deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts <submission_id> [max_per_minute] [total_submissions] [concurrency]"
    );
    console.error("  submission_id: The submission ID to trigger");
    console.error("  max_per_minute: Maximum submissions per minute (default: 60)");
    console.error("  total_submissions: Total number of submissions to make (default: 10)");
    console.error("  concurrency: Maximum in-flight dispatches (default: derived from max_per_minute)");
    console.error("");
    console.error(
      "Example: deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts 123 120 200"
    );
    Deno.exit(1);
  }

  const submissionId = parseInt(args[0]);
  const maxPerMinute = args[1] ? parseInt(args[1]) : 60;
  const totalSubmissions = args[2] ? parseInt(args[2]) : 10;

  if (isNaN(submissionId) || submissionId <= 0) {
    console.error("Error: submission_id must be a positive number");
    Deno.exit(1);
  }

  if (isNaN(maxPerMinute) || maxPerMinute <= 0) {
    console.error("Error: max_per_minute must be a positive number");
    Deno.exit(1);
  }

  if (isNaN(totalSubmissions) || totalSubmissions <= 0) {
    console.error("Error: total_submissions must be a positive number");
    Deno.exit(1);
  }

  // Enough in-flight requests to keep the pacer saturated at ~2s per dispatch, plus headroom
  // for the slow tail, capped by the number of submissions we actually have to send.
  const defaultConcurrency = Math.ceil(maxPerMinute / 30) + 2;
  const concurrency = args[3] ? parseInt(args[3]) : defaultConcurrency;

  if (isNaN(concurrency) || concurrency <= 0) {
    console.error("Error: concurrency must be a positive number");
    Deno.exit(1);
  }

  return {
    submissionId,
    maxPerMinute,
    totalSubmissions,
    concurrency: Math.min(concurrency, totalSubmissions)
  };
}

async function getSubmissionData(submissionId: number): Promise<SubmissionData> {
  const supabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  const { data, error } = await supabase
    .from("submissions")
    .select("id, repository, sha")
    .eq("id", submissionId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to fetch submission ${submissionId}: ${error?.message || "Submission not found"}`);
  }

  if (!data.repository || !data.sha) {
    throw new Error(`Submission ${submissionId} has no repository or SHA to trigger`);
  }

  return { id: data.id, repository: data.repository, sha: data.sha };
}

/**
 * Installation-scoped client for one repo, without the shared production throttle. The
 * token is minted up front so the concurrent dispatches below don't all stall on auth.
 */
async function getInstallationOctokit(owner: string, repo: string): Promise<Octokit> {
  const appId = Deno.env.get("GITHUB_APP_ID");
  const privateKey = Deno.env.get("GITHUB_PRIVATE_KEY_STRING");

  if (!appId || !privateKey) {
    throw new Error("Missing GITHUB_APP_ID or GITHUB_PRIVATE_KEY_STRING");
  }

  const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
  appOctokit.request = appOctokit.request.defaults({ headers: API_VERSION_HEADER });
  const { data: installation } = await appOctokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId: installation.id }
  });
  octokit.request = octokit.request.defaults({ headers: API_VERSION_HEADER });

  // Reads `resources.core`, not `rate` — the latter is gone in 2026-03-10.
  const { data: limits } = await octokit.request("GET /rate_limit");
  console.log(`  Installation: ${installation.id}`);
  console.log(`  Core rate limit remaining: ${limits.resources.core.remaining}/${limits.resources.core.limit}`);

  return octokit;
}

/**
 * Create the tag the workflow dispatches against, once for the whole run. Every submission
 * reuses the same repo and SHA, so the tag only has to exist — re-creating it per dispatch
 * (as `triggerWorkflow` does) just burns two write requests against the secondary limit.
 */
async function ensureSubmissionTag(octokit: Octokit, owner: string, repo: string, sha: string): Promise<string> {
  const ref = `pawtograder-submit/${sha}`;

  try {
    await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: `tags/${ref}` });
    console.log(`  Tag ${ref} already exists`);
    return ref;
  } catch (error) {
    if (errorStatus(error) !== 404) {
      throw error;
    }
  }

  await octokit.request("POST /repos/{owner}/{repo}/git/tags", {
    owner,
    repo,
    tag: ref,
    message: "pawtograder submission",
    object: sha,
    type: "commit",
    tagger: {
      name: "pawtograder",
      email: "khoury-pawtograder-app@ccs.neu.edu",
      date: new Date().toISOString()
    }
  });

  try {
    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref: `refs/tags/${ref}`,
      sha
    });
  } catch (error) {
    // Another run may have created it between our GET and POST.
    if (!errorMessage(error).includes("Reference already exists")) {
      throw error;
    }
  }

  console.log(`  Created tag ${ref}`);
  return ref;
}

async function triggerBulkSubmissions(args: Args): Promise<void> {
  console.log(`Starting bulk submission trigger:`);
  console.log(`  Submission ID: ${args.submissionId}`);
  console.log(`  Target throughput: ${args.maxPerMinute} per minute`);
  console.log(`  Total submissions: ${args.totalSubmissions}`);
  console.log(`  Max concurrent requests: ${args.concurrency}`);

  if (args.maxPerMinute > SECONDARY_LIMIT_WARNING_THRESHOLD) {
    console.warn(
      `  WARNING: ${args.maxPerMinute}/min exceeds GitHub's ~${SECONDARY_LIMIT_WARNING_THRESHOLD}/min secondary limit for content-creating requests; expect throttling`
    );
  }

  const submissionData = await getSubmissionData(args.submissionId);
  const [owner, repo] = submissionData.repository.split("/");
  console.log(`  Repository: ${submissionData.repository}`);
  console.log(`  SHA: ${submissionData.sha}`);

  const octokit = await getInstallationOctokit(owner, repo);
  const ref = await ensureSubmissionTag(octokit, owner, repo, submissionData.sha);

  const startTime = Date.now();
  const durations: number[] = [];
  const failures = new Map<string, number>();
  let completed = 0;
  let succeeded = 0;
  let retried = 0;

  const pacer = new Pacer(args.maxPerMinute);
  let nextIndex = 0;

  const dispatch = async (): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Every attempt takes a paced slot, retries included. Pacing only first attempts would
      // let a burst of retryable 5xxs double the request rate — the other workers keep
      // admitting first attempts meanwhile — so `max_per_minute` would stop being an upper
      // bound on GitHub requests at exactly the moment GitHub is asking us to back off.
      await pacer.acquire();
      // After the wait, so the reported latency is the request itself and not the pacing.
      const requestStartTime = Date.now();
      try {
        await octokit.request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", {
          owner,
          repo,
          workflow_id: WORKFLOW_NAME,
          ref
        });
        durations.push(Date.now() - requestStartTime);
        succeeded++;
        return;
      } catch (error) {
        if (attempt === MAX_ATTEMPTS || !isRetryable(error)) {
          const key = `${errorStatus(error) ?? "network"}: ${errorMessage(error)}`;
          failures.set(key, (failures.get(key) ?? 0) + 1);
          return;
        }
        retried++;
        const backoffMs = retryDelayFromHeaders(error) ?? 1000 * 2 ** (attempt - 1);
        await sleep(backoffMs);
      }
    }
  };

  console.log(`\nStarting asynchronous workflow triggers...`);

  const progressTimer = setInterval(() => {
    const elapsedMinutes = (Date.now() - startTime) / 60000;
    const rate = elapsedMinutes > 0 ? completed / elapsedMinutes : 0;
    console.log(`  ${completed}/${args.totalSubmissions} dispatched (${rate.toFixed(1)}/min, ${succeeded} ok)`);
  }, 5000);

  const workers = Array.from({ length: args.concurrency }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= args.totalSubmissions) {
        return;
      }
      await dispatch();
      completed++;
    }
  });

  await Promise.all(workers);
  clearInterval(progressTimer);

  const totalDuration = Date.now() - startTime;
  const failedSubmissions = args.totalSubmissions - succeeded;
  const actualThroughput = (succeeded / totalDuration) * 60000;
  const sorted = durations.slice().sort((a, b) => a - b);
  const percentile = (p: number) =>
    sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;

  console.log(`\n=== Bulk submission trigger completed ===`);
  console.log(`  Total duration: ${totalDuration}ms`);
  console.log(`  Successful: ${succeeded}/${args.totalSubmissions}`);
  console.log(`  Failed: ${failedSubmissions}/${args.totalSubmissions}`);
  console.log(`  Retries: ${retried}`);
  console.log(`  Dispatch latency: p50 ${percentile(0.5)}ms, p95 ${percentile(0.95)}ms`);
  console.log(`  Actual throughput: ${actualThroughput.toFixed(2)} per minute`);
  console.log(`  Target throughput: ${args.maxPerMinute} per minute`);

  if (failures.size > 0) {
    console.log(`\nFailures:`);
    for (const [message, count] of [...failures].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}x ${message}`);
    }
  }
}

async function main(): Promise<void> {
  try {
    const args = parseArgs();
    await triggerBulkSubmissions(args);
  } catch (error) {
    console.error("Fatal error:", error);
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main();
}
