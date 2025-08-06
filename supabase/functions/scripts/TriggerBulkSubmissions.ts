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
 * and distributes the workflow triggers evenly over the specified time period.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function triggerBulkSubmissions(args: Args): Promise<void> {
  console.log(`Starting bulk submission trigger:`);
  console.log(`  Submission ID: ${args.submissionId}`);
  console.log(`  Max per minute: ${args.maxPerMinute}`);
  console.log(`  Total submissions: ${args.totalSubmissions}`);

  // Fetch the actual submission data from the database
  const submissionData = await getSubmissionData(args.submissionId);
  console.log(`  Repository: ${submissionData.repository}`);
  console.log(`  SHA: ${submissionData.sha}`);

  // Calculate the interval between submissions to distribute them evenly over a minute
  const intervalMs = Math.floor(60000 / args.maxPerMinute); // 60000ms = 1 minute
  const actualSubmissions = Math.min(args.totalSubmissions, args.maxPerMinute);

  console.log(`  Interval between submissions: ${intervalMs}ms`);
  console.log(`  Actual submissions to trigger: ${actualSubmissions}`);

  for (let i = 0; i < actualSubmissions; i++) {
    try {
      console.log(`Triggering submission ${i + 1}/${actualSubmissions}...`);

      // Use the actual repository and SHA from the database
      await triggerWorkflow(submissionData.repository, submissionData.sha, "grade.yml");

      console.log(`  Successfully triggered submission ${i + 1}`);

      // Wait for the specified interval before the next submission
      if (i < actualSubmissions - 1) {
        console.log(`  Waiting ${intervalMs}ms before next submission...`);
        await sleep(intervalMs);
      }
    } catch (error) {
      console.error(`  Error triggering submission ${i + 1}:`, error);
    }
  }

  console.log("Bulk submission trigger completed.");
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
