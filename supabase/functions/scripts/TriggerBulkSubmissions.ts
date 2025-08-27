#!/usr/bin/env -S deno run --allow-env --allow-net

/**
 * TriggerBulkSubmissions - Deno script to trigger multiple grading workflows
 *
 * Usage:
 *   # Basic usage with defaults (10 submissions, 10 per minute)
 *   deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts <submission_id>
 *
 *   # Custom parameters
 *   deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts <submission_id> <max_per_minute> <total_submissions>
 *
 *   # Example: 5 submissions, 3 per minute
 *   deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts 123 3 5
 *
 * Parameters:
 *   submission_id: The submission ID to trigger (required)
 *   max_per_minute: Maximum submissions per minute (default: 10)
 *   total_submissions: Total number of submissions to make (default: 10)
 *
 * Environment Variables (from .env.local):
 *   SUPABASE_URL: Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY: Supabase service role key for database access
 *   GITHUB_APP_ID: GitHub App ID
 *   GITHUB_PRIVATE_KEY_STRING: GitHub App private key
 *
 * The script fetches the actual repository and SHA from the database
 * and triggers workflow requests asynchronously with controlled concurrency.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { triggerWorkflow } from "../_shared/GitHubWrapper.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";

interface Args {
  submissionId: number;
  maxPerMinute: number;
  totalSubmissions: number;
}

interface SubmissionData {
  id: number;
  repository: string;
  sha: string;
}

interface WorkflowResult {
  index: number;
  success: boolean;
  error?: string;
  timestamp: Date;
}

// Rate limiter class to control throughput
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per millisecond

  constructor(maxPerMinute: number) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = maxPerMinute / 60000; // Convert per minute to per millisecond
  }

  async acquire(): Promise<void> {
    while (this.tokens < 1) {
      this.refill();
      if (this.tokens < 1) {
        // Wait for next refill cycle
        const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }
    this.tokens--;
  }

  private refill(): void {
    const now = Date.now();
    const timePassed = now - this.lastRefill;
    const tokensToAdd = timePassed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

// Concurrency limiter class to control maximum concurrent requests
class ConcurrencyLimiter {
  private running = 0;
  private readonly maxConcurrent: number;
  private readonly queue: Array<() => Promise<void>> = [];

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) {
      // Wait for a slot to become available
      return new Promise((resolve, reject) => {
        this.queue.push(async () => {
          try {
            const result = await fn();
            resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      });
    }

    this.running++;
    try {
      const result = await fn();
      return result;
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    if (this.queue.length > 0 && this.running < this.maxConcurrent) {
      const next = this.queue.shift();
      if (next) {
        this.running++;
        next().finally(() => {
          this.running--;
          this.processQueue();
        });
      }
    }
  }

  async waitForAll(): Promise<void> {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function parseArgs(): Args {
  const args = Deno.args;

  if (args.length < 1) {
    console.error(
      "Usage: deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts <submission_id> [max_per_minute] [total_submissions]"
    );
    console.error("  submission_id: The submission ID to trigger");
    console.error("  max_per_minute: Maximum submissions per minute (default: 10)");
    console.error("  total_submissions: Total number of submissions to make (default: 10)");
    console.error("");
    console.error(
      "Example: deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/TriggerBulkSubmissions.ts 123 3 5"
    );
    Deno.exit(1);
  }

  const submissionId = parseInt(args[0]);
  const maxPerMinute = args[1] ? parseInt(args[1]) : 10;
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

  return {
    submissionId,
    maxPerMinute,
    totalSubmissions
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

  return data;
}

async function triggerBulkSubmissions(args: Args): Promise<void> {
  console.log(`Starting bulk submission trigger:`);
  console.log(`  Submission ID: ${args.submissionId}`);
  console.log(`  Target throughput: ${args.maxPerMinute} per minute`);
  console.log(`  Total submissions: ${args.totalSubmissions}`);
  console.log(`  Max concurrent requests: 20`);

  // Fetch the actual submission data from the database
  const submissionData = await getSubmissionData(args.submissionId);
  console.log(`  Repository: ${submissionData.repository}`);
  console.log(`  SHA: ${submissionData.sha}`);

  const startTime = Date.now();
  const results: WorkflowResult[] = [];

  // Initialize rate limiter and concurrency limiter
  const rateLimiter = new RateLimiter(args.maxPerMinute);
  const concurrencyLimiter = new ConcurrencyLimiter(20);

  console.log(`\nStarting asynchronous workflow triggers...`);

  // Create all submission tasks
  const tasks = Array.from({ length: args.totalSubmissions }, (_, index) => {
    return async (): Promise<void> => {
      const submissionIndex = index + 1;
      const taskStartTime = Date.now();

      try {
        // Wait for rate limiter to allow this request
        await rateLimiter.acquire();

        console.log(`  [${submissionIndex}/${args.totalSubmissions}] Triggering workflow...`);

        // Use the actual repository and SHA from the database
        await triggerWorkflow(submissionData.repository, submissionData.sha, "grade.yml");

        const duration = Date.now() - taskStartTime;
        console.log(`  [${submissionIndex}/${args.totalSubmissions}] ✓ Success (${duration}ms)`);

        results.push({
          index: submissionIndex,
          success: true,
          timestamp: new Date()
        });
      } catch (error) {
        const duration = Date.now() - taskStartTime;
        console.error(`  [${submissionIndex}/${args.totalSubmissions}] ✗ Failed (${duration}ms):`, error);

        results.push({
          index: submissionIndex,
          success: false,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date()
        });
      }
    };
  });

  // Execute all tasks with concurrency control
  const executionPromises = tasks.map((task) => concurrencyLimiter.run(task));

  // Wait for all tasks to complete
  await Promise.all(executionPromises);
  await concurrencyLimiter.waitForAll();

  const totalDuration = Date.now() - startTime;
  const successfulSubmissions = results.filter((r) => r.success).length;
  const failedSubmissions = results.filter((r) => !r.success).length;
  const actualThroughput = (successfulSubmissions / totalDuration) * 60000; // per minute

  console.log(`\n=== Bulk submission trigger completed ===`);
  console.log(`  Total duration: ${totalDuration}ms`);
  console.log(`  Successful: ${successfulSubmissions}/${args.totalSubmissions}`);
  console.log(`  Failed: ${failedSubmissions}/${args.totalSubmissions}`);
  console.log(`  Actual throughput: ${actualThroughput.toFixed(2)} per minute`);
  console.log(`  Target throughput: ${args.maxPerMinute} per minute`);

  if (failedSubmissions > 0) {
    console.log(`\nFailed submissions:`);
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  [${r.index}]: ${r.error}`);
      });
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
