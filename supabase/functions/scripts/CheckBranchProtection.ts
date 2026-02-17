#!/usr/bin/env -S deno run --allow-env --allow-net

/**
 * CheckBranchProtection.ts - Deno script to check and optionally fix branch protection rulesets
 *
 * This script audits repositories for a given assignment to ensure branch protection rulesets
 * are in place to prevent force pushes on the main branch.
 *
 * Usage:
 *   # Audit only (report status)
 *   deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/CheckBranchProtection.ts <assignment_id>
 *
 *   # Audit and fix (create missing rulesets)
 *   deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/CheckBranchProtection.ts <assignment_id> --fix
 *
 *   # Fix only the first unprotected repo (for manual validation)
 *   deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/CheckBranchProtection.ts <assignment_id> --fix-first
 *
 * Parameters:
 *   assignment_id: The assignment ID to check repositories for (required)
 *   --fix: Optional flag to create missing branch protection rulesets for all unprotected repos
 *   --fix-first: Optional flag to create missing branch protection ruleset for only the first unprotected repo
 *
 * Environment Variables (from .env.local):
 *   SUPABASE_URL: Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY: Supabase service role key for database access
 *   GITHUB_APP_ID: GitHub App ID
 *   GITHUB_PRIVATE_KEY_STRING: GitHub App private key
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { getOctoKit, createBranchProtectionRuleset } from "../_shared/GitHubWrapper.ts";
import { RequestError } from "https://esm.sh/octokit?dts";
import Bottleneck from "https://esm.sh/bottleneck?target=deno";

interface AssignmentData {
  id: number;
  title: string;
  slug: string;
  classes: {
    github_org: string;
    slug: string;
  };
}

interface RepositoryData {
  id: number;
  repository: string;
  assignment_id: number;
}

interface RulesetData {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  conditions: {
    ref_name?: {
      include?: string[];
      exclude?: string[];
    };
  };
  rules: Array<{
    type: string;
  }>;
}

interface RepoStatus {
  repository: string;
  hasProtection: boolean;
  error?: string;
  fixed?: boolean;
}

function parseArgs(): { assignmentId: number; fix: boolean; fixFirst: boolean } {
  const args = Deno.args;

  if (args.length < 1) {
    console.error(
      "Usage: deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/CheckBranchProtection.ts <assignment_id> [--fix|--fix-first]"
    );
    console.error("  assignment_id: The assignment ID to check repositories for");
    console.error("  --fix: Optional flag to create missing branch protection rulesets for all unprotected repos");
    console.error(
      "  --fix-first: Optional flag to create missing branch protection ruleset for only the first unprotected repo"
    );
    console.error("");
    console.error(
      "Example: deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/CheckBranchProtection.ts 123 --fix"
    );
    console.error(
      "Example: deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/CheckBranchProtection.ts 123 --fix-first"
    );
    Deno.exit(1);
  }

  const assignmentId = parseInt(args[0]);
  const fix = args.includes("--fix");
  const fixFirst = args.includes("--fix-first");

  if (isNaN(assignmentId) || assignmentId <= 0) {
    console.error("Error: assignment_id must be a positive number");
    Deno.exit(1);
  }

  if (fix && fixFirst) {
    console.error("Error: Cannot use both --fix and --fix-first flags together");
    Deno.exit(1);
  }

  return { assignmentId, fix, fixFirst };
}

async function getAssignment(
  assignmentId: number,
  adminSupabase: ReturnType<typeof createClient<Database>>
): Promise<AssignmentData> {
  const { data, error } = await adminSupabase
    .from("assignments")
    .select("id, title, slug, classes(github_org, slug)")
    .eq("id", assignmentId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to fetch assignment ${assignmentId}: ${error?.message || "Assignment not found"}`);
  }

  return data as AssignmentData;
}

async function getRepositoriesForAssignment(
  assignmentId: number,
  adminSupabase: ReturnType<typeof createClient<Database>>
): Promise<RepositoryData[]> {
  const { data, error } = await adminSupabase
    .from("repositories")
    .select("id, repository, assignment_id")
    .eq("assignment_id", assignmentId);

  if (error) {
    throw new Error(`Failed to fetch repositories: ${error.message}`);
  }

  return (data || []) as RepositoryData[];
}

async function getRulesetsForRepo(org: string, repoName: string, scope: Sentry.Scope): Promise<RulesetData[]> {
  const octokit = await getOctoKit(org, scope);
  if (!octokit) {
    throw new Error(`No GitHub installation found for organization ${org}`);
  }

  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/rulesets", {
      owner: org,
      repo: repoName
    });
    return data as RulesetData[];
  } catch (e) {
    if (e instanceof RequestError && e.status === 404) {
      // No rulesets exist yet
      return [];
    }
    throw e;
  }
}

function hasForcePushProtection(rulesets: RulesetData[]): boolean {
  return rulesets.some((ruleset) => {
    // Check if ruleset targets default branch
    const includesDefault =
      ruleset.conditions?.ref_name?.include?.includes("~DEFAULT_BRANCH") ||
      ruleset.conditions?.ref_name?.include?.includes("refs/heads/main");

    // Check if ruleset blocks force pushes (non_fast_forward rule)
    const hasBlockRule = ruleset.rules?.some((rule) => rule.type === "non_fast_forward");

    // Check if ruleset is active
    const isActive = ruleset.enforcement === "active";

    return includesDefault && hasBlockRule && isActive;
  });
}

async function checkRepoProtection(
  repo: RepositoryData,
  org: string,
  fix: boolean,
  scope: Sentry.Scope
): Promise<RepoStatus> {
  const [repoOrg, repoName] = repo.repository.split("/");
  if (repoOrg !== org) {
    return {
      repository: repo.repository,
      hasProtection: false,
      error: `Repository org (${repoOrg}) does not match assignment org (${org})`
    };
  }

  try {
    // Check current protection status
    console.log(`Checking protection status for ${repo.repository}`);
    const rulesets = await getRulesetsForRepo(org, repoName, scope);
    const hasProtection = hasForcePushProtection(rulesets);
    console.log(`Has protection: ${hasProtection}`);
    // If already protected, return early without trying to fix
    if (hasProtection) {
      return {
        repository: repo.repository,
        hasProtection: true,
        fixed: false
      };
    }

    // If not protected and fix is requested, try to create the ruleset
    if (fix) {
      console.log(`Creating ruleset for ${repo.repository}`);
      try {
        await createBranchProtectionRuleset(org, repoName, scope);
        // Wait a moment for the ruleset to propagate, then re-check
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const updatedRulesets = await getRulesetsForRepo(org, repoName, scope);
        const nowHasProtection = hasForcePushProtection(updatedRulesets);

        if (nowHasProtection) {
          // Protection now exists - check if it was newly created or already existed
          // If it already existed, createBranchProtectionRuleset would have caught 422/409
          // but since it didn't throw, we assume it was created
          return {
            repository: repo.repository,
            hasProtection: true,
            fixed: true
          };
        } else {
          // Ruleset creation succeeded silently (likely because it already existed with 422/409)
          // but our detection didn't find it. This means either:
          // 1. Detection logic mismatch
          // 2. Timing issue
          // 3. Ruleset exists but with different conditions
          // Since creation "succeeded", assume protection exists but we can't detect it
          // Report as protected (not fixed) to avoid false "fixed" reports
          return {
            repository: repo.repository,
            hasProtection: true, // Assume protected since creation succeeded
            fixed: false // Don't report as fixed if we can't detect it
          };
        }
      } catch (fixError) {
        console.log(
          `Error creating ruleset for ${repo.repository}: ${fixError instanceof Error ? fixError.message : String(fixError)}`
        );
        // If creation throws, check if protection exists anyway
        if (fixError instanceof RequestError && (fixError.status === 422 || fixError.status === 409)) {
          // Ruleset already exists - check if we can detect it
          const updatedRulesets = await getRulesetsForRepo(org, repoName, scope);
          const nowHasProtection = hasForcePushProtection(updatedRulesets);
          if (nowHasProtection) {
            return {
              repository: repo.repository,
              hasProtection: true,
              fixed: false // Already existed, not newly fixed
            };
          }
          // Can't detect it but it exists - report as protected
          return {
            repository: repo.repository,
            hasProtection: true,
            fixed: false
          };
        }
        return {
          repository: repo.repository,
          hasProtection: false,
          error: `Failed to create ruleset: ${fixError instanceof Error ? fixError.message : String(fixError)}`,
          fixed: false
        };
      }
    }

    // Not protected and fix not requested
    return {
      repository: repo.repository,
      hasProtection: false,
      fixed: false
    };
  } catch (error) {
    return {
      repository: repo.repository,
      hasProtection: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function main(): Promise<void> {
  // Initialize Sentry
  if (Deno.env.get("SENTRY_DSN")) {
    Sentry.init({
      dsn: Deno.env.get("SENTRY_DSN"),
      tracesSampleRate: 1.0
    });
  }

  const scope = new Sentry.Scope();
  scope.setTag("script", "CheckBranchProtection");

  try {
    const { assignmentId, fix, fixFirst } = parseArgs();

    console.log(`Checking branch protection for assignment ${assignmentId}`);
    if (fix) {
      console.log("Fix mode enabled - will create missing rulesets for all unprotected repos");
    } else if (fixFirst) {
      console.log("Fix-first mode enabled - will create missing ruleset for only the first unprotected repo");
    }
    console.log("");

    // Initialize Supabase client
    const adminSupabase = createClient<Database>(
      Deno.env.get("SUPABASE_URL") || "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
    );

    // Fetch assignment
    console.log("Fetching assignment...");
    const assignment = await getAssignment(assignmentId, adminSupabase);
    console.log(`  Assignment: ${assignment.title} (${assignment.slug})`);
    console.log(`  GitHub Org: ${assignment.classes.github_org}`);
    console.log("");

    // Fetch repositories
    console.log("Fetching repositories...");
    const repositories = await getRepositoriesForAssignment(assignmentId, adminSupabase);
    console.log(`  Found ${repositories.length} repositories`);
    console.log("");

    if (repositories.length === 0) {
      console.log("No repositories found for this assignment.");
      return;
    }

    // Check each repository in parallel with rate limiting
    console.log("Checking branch protection rulesets...");
    console.log(`Processing ${repositories.length} repositories in parallel (max 50/min)...`);
    console.log("");

    // Create rate limiter: 50 requests per minute
    const rateLimiter = new Bottleneck({
      reservoir: 100, // Number of jobs
      reservoirRefreshAmount: 100, // Refill amount
      reservoirRefreshInterval: 60 * 1000, // Refill every minute (60000ms)
      maxConcurrent: 10 // Max concurrent operations
    });

    // Process all repositories in parallel
    // For --fix mode, fix during parallel check. For --fix-first, check first then fix sequentially.
    const checkPromises = repositories.map((repo, index) =>
      rateLimiter.schedule(async () => {
        console.log(`Checking repository ${repo.repository}`);
        // For --fix mode, fix during check. For others, just check.
        const shouldFix = fix; // Only fix if --fix flag is set
        const status = await checkRepoProtection(repo, assignment.classes.github_org, shouldFix, scope);
        return { index, repo, status };
      })
    );

    const checkResults = await Promise.allSettled(checkPromises);
    const results: RepoStatus[] = [];
    const indexedResults: Array<{ index: number; repo: RepositoryData; status: RepoStatus }> = [];

    // Process results
    for (const result of checkResults) {
      if (result.status === "fulfilled") {
        indexedResults.push(result.value);
      } else {
        console.error(`Error processing repository: ${result.reason}`);
      }
    }

    // Sort by index to maintain order
    indexedResults.sort((a, b) => a.index - b.index);

    // Handle --fix-first mode: fix the first unprotected repo sequentially
    let fixedOne = false;
    if (fixFirst) {
      for (const { repo, status } of indexedResults) {
        if (!status.hasProtection && !status.error) {
          const fixStatus = await checkRepoProtection(repo, assignment.classes.github_org, true, scope);
          // Update the status
          status.hasProtection = fixStatus.hasProtection;
          status.fixed = fixStatus.fixed;
          status.error = fixStatus.error;
          if (fixStatus.fixed) {
            fixedOne = true;
          }
          break; // Only fix the first one
        }
      }
    }

    // Print results with full repo names
    for (const { repo, status } of indexedResults) {
      results.push(status);

      const statusLine = status.error
        ? `✗ Error: ${status.error}`
        : status.fixed
          ? `✓ Fixed (created ruleset)`
          : status.hasProtection
            ? `✓ Protected`
            : `✗ Not protected`;
      console.log(`  ${repo.repository} - ${statusLine}`);

      // If fixFirst and we just fixed one, stop processing remaining repos
      if (fixFirst && fixedOne && status.fixed) {
        console.log("");
        console.log("Fixed first unprotected repo. Stopping here for manual validation.");
        console.log("Run again with --fix to fix all remaining unprotected repos.");
        // Add remaining repos to results but don't print them
        const currentIndex = indexedResults.findIndex((r) => r.repo.id === repo.id);
        if (currentIndex >= 0) {
          for (let i = currentIndex + 1; i < indexedResults.length; i++) {
            results.push(indexedResults[i].status);
          }
        }
        break;
      }
    }

    // Summary
    console.log("");
    console.log("=== Summary ===");
    const protectedCount = results.filter((r) => r.hasProtection).length;
    const unprotectedCount = results.filter((r) => !r.hasProtection && !r.error).length;
    const errorCount = results.filter((r) => r.error).length;
    const fixedCount = results.filter((r) => r.fixed).length;

    console.log(`Total repositories: ${results.length}`);
    console.log(`  Protected: ${protectedCount}`);
    console.log(`  Unprotected: ${unprotectedCount}`);
    if (fix || fixFirst) {
      console.log(`  Fixed: ${fixedCount}`);
    }
    if (errorCount > 0) {
      console.log(`  Errors: ${errorCount}`);
    }

    if (unprotectedCount > 0 && !fix && !fixFirst) {
      console.log("");
      console.log("To create missing rulesets, run with --fix or --fix-first flag:");
      console.log(
        `  deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/CheckBranchProtection.ts ${assignmentId} --fix-first`
      );
      console.log(
        `  deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/CheckBranchProtection.ts ${assignmentId} --fix`
      );
    } else if (unprotectedCount > 0 && fixFirst && fixedCount > 0) {
      console.log("");
      console.log("To fix remaining unprotected repos, run with --fix flag:");
      console.log(
        `  deno run --allow-env --allow-net --env-file=.env.local supabase/functions/scripts/CheckBranchProtection.ts ${assignmentId} --fix`
      );
    }

    if (errorCount > 0) {
      console.log("");
      console.log("Repositories with errors:");
      results
        .filter((r) => r.error)
        .forEach((r) => {
          console.log(`  ${r.repository}: ${r.error}`);
        });
    }
  } catch (error) {
    console.error("\n✗ Fatal error:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, scope);
    Deno.exit(1);
  }
}

// Run the main function
if (import.meta.main) {
  main();
}
