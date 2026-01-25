#!/usr/bin/env -S deno run --allow-env --allow-net
/* eslint-disable no-console */

/**
 * PushChangesToRepoFromHandout.ts
 *
 * This script syncs changes from a template/autograder repository to a student repository
 * by creating a pull request with the updated files using shared sync helpers.
 *
 * Usage: deno run --allow-env --allow-net PushChangesToRepoFromHandout.ts <repository_id_or_full_name>
 */

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { getOctoKit } from "../_shared/GitHubWrapper.ts";
import { syncRepositoryToHandout, getFirstCommit } from "../_shared/GitHubSyncHelpers.ts";

interface RepositoryData {
  id: number;
  repository: string;
  synced_handout_sha: string | null;
  synced_repo_sha: string | null;
  assignment_id: number;
  class_id: number;
  assignments: {
    latest_template_sha: string | null;
    template_repo: string | null;
    title: string;
  };
}

async function getRepositoryFromDB(
  repoIdOrFullName: string,
  adminSupabase: ReturnType<typeof createClient<Database>>
): Promise<RepositoryData> {
  // Check if the argument is a numeric ID or a full repository name
  const isNumeric = /^\d+$/.test(repoIdOrFullName);

  let data;
  let error;

  if (isNumeric) {
    const result = await adminSupabase
      .from("repositories")
      .select(
        "id, repository, synced_handout_sha, synced_repo_sha, assignment_id, class_id, assignments(latest_template_sha, template_repo, title)"
      )
      .eq("id", parseInt(repoIdOrFullName))
      .single();
    data = result.data;
    error = result.error;
  } else {
    const result = await adminSupabase
      .from("repositories")
      .select(
        "id, repository, synced_handout_sha, synced_repo_sha, assignment_id, class_id, assignments(latest_template_sha, template_repo, title)"
      )
      .eq("repository", repoIdOrFullName)
      .single();
    data = result.data;
    error = result.error;
  }

  if (error || !data) {
    throw new Error(`Repository not found: ${repoIdOrFullName}. Error: ${error?.message}`);
  }

  return data as RepositoryData;
}

async function updateSyncedShas(
  adminSupabase: ReturnType<typeof createClient<Database>>,
  repoId: number,
  handoutSha: string,
  repoSha?: string
): Promise<void> {
  const updates: { synced_handout_sha: string; synced_repo_sha?: string } = {
    synced_handout_sha: handoutSha
  };

  if (repoSha) {
    updates.synced_repo_sha = repoSha;
  }

  const { error } = await adminSupabase.from("repositories").update(updates).eq("id", repoId);

  if (error) {
    throw new Error(`Failed to update synced SHAs: ${error.message}`);
  }
}

async function checkForExistingPRs(
  repoFullName: string,
  scope: Sentry.Scope
): Promise<Array<{ number: number; state: string; merged: boolean; head_ref: string }>> {
  const octokit = await getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  // Get all PRs (both open and closed) that match our sync branch pattern
  const { data: prs } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    state: "all",
    per_page: 100
  });

  // Filter for PRs created by this script (branch starts with "sync-to-")
  const syncPRs = prs.filter((pr) => pr.head.ref.startsWith("sync-to-"));

  return syncPRs.map((pr) => ({
    number: pr.number,
    state: pr.state,
    merged: pr.merged_at !== null,
    head_ref: pr.head.ref
  }));
}

async function main() {
  // Initialize Sentry
  if (Deno.env.get("SENTRY_DSN")) {
    Sentry.init({
      dsn: Deno.env.get("SENTRY_DSN"),
      tracesSampleRate: 1.0
    });
  }

  const scope = new Sentry.Scope();
  scope.setTag("script", "PushChangesToRepoFromHandout");

  // Get the repository ID or full name from command line arguments
  const repoIdOrFullName = Deno.args[0];
  if (!repoIdOrFullName) {
    console.error(
      "Usage: ❯ deno run --allow-env --env-file=.env.local --allow-net --allow-import supabase/functions/scripts/PushChangesToRepoFromHandout.ts <repository_id_or_full_name>"
    );
    Deno.exit(1);
  }

  console.log(`Processing repository: ${repoIdOrFullName}`);

  // Initialize Supabase client
  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
  );

  try {
    // 1. Fetch repository from database
    console.log("Fetching repository from database...");
    const repo = await getRepositoryFromDB(repoIdOrFullName, adminSupabase);
    console.log(`Found repository: ${repo.repository} (ID: ${repo.id})`);
    console.log(`Assignment: ${repo.assignments.title}`);
    console.log(`Template repo: ${repo.assignments.template_repo}`);
    console.log(`Last synced commit: ${repo.synced_handout_sha || "(none)"}`);
    console.log(`Latest template commit: ${repo.assignments.latest_template_sha || "(none)"}`);

    // 2. Check for existing PRs that may have been merged
    console.log("\nChecking for existing sync PRs...");
    const existingPRs = await checkForExistingPRs(repo.repository, scope);

    if (existingPRs.length > 0) {
      console.log(`Found ${existingPRs.length} existing sync PR(s)`);

      // Check if any merged PRs need to update our database
      for (const pr of existingPRs) {
        if (pr.merged) {
          // Extract the SHA from the branch name (sync-to-abc1234 -> abc1234)
          const shaFromBranch = pr.head_ref.replace("sync-to-", "");

          // Check if this SHA is newer than our currently synced SHA
          // If synced_handout_sha is null or different, update it
          if (repo.synced_handout_sha !== shaFromBranch) {
            console.log(`Found merged PR #${pr.number} with SHA ${shaFromBranch}`);
            console.log(`Updating database to reflect this merge...`);

            // Get the merge commit SHA from the PR
            const octokit = await getOctoKit(repo.repository, scope);
            if (octokit) {
              const [owner, repoName] = repo.repository.split("/");
              const { data: prData } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
                owner,
                repo: repoName,
                pull_number: pr.number
              });

              // Update both handout SHA and repo SHA (the merge commit)
              await updateSyncedShas(adminSupabase, repo.id, shaFromBranch, prData.merge_commit_sha || undefined);
              // Update our local copy too
              repo.synced_handout_sha = shaFromBranch;
              console.log(`✓ Database updated (handout SHA: ${shaFromBranch}, merge SHA: ${prData.merge_commit_sha})`);
            } else {
              // Fallback if we can't get the PR details
              await updateSyncedShas(adminSupabase, repo.id, shaFromBranch);
              repo.synced_handout_sha = shaFromBranch;
              console.log(`✓ Database updated`);
            }
          } else {
            console.log(`PR #${pr.number} (${shaFromBranch}) already recorded in database`);
          }
        } else if (pr.state === "open") {
          console.log(`Found open PR #${pr.number} (${pr.head_ref}) - leaving it open`);
        }
      }
    } else {
      console.log("No existing sync PRs found");
    }

    // 3. Check if there are changes to sync
    if (!repo.assignments.template_repo) {
      console.error("Error: No template repository configured for this assignment");
      Deno.exit(1);
    }

    if (!repo.assignments.latest_template_sha) {
      console.error("Error: No latest template SHA found. Has the template repository been pushed?");
      Deno.exit(1);
    }

    if (repo.synced_handout_sha === repo.assignments.latest_template_sha) {
      console.log("Repository is already up to date. No changes to sync.");
      Deno.exit(0);
    }

    // 4. Sync repository using shared helper (mirrors async worker behavior)
    console.log("\nSyncing repository to handout...");
    console.log(`  From SHA: ${repo.synced_handout_sha || "(initial)"}`);
    console.log(`  To SHA:   ${repo.assignments.latest_template_sha}`);

    // Get syncedRepoSha - either from DB or fetch first commit if not set
    let syncedRepoSha = repo.synced_repo_sha;
    if (!syncedRepoSha) {
      console.log("  No synced_repo_sha found, fetching first commit in main branch...");
      syncedRepoSha = await getFirstCommit(repo.repository, "main", scope);
      console.log(`  Using first commit: ${syncedRepoSha}`);
    }

    const result = await syncRepositoryToHandout({
      repositoryFullName: repo.repository,
      templateRepo: repo.assignments.template_repo,
      fromSha: repo.synced_handout_sha,
      toSha: repo.assignments.latest_template_sha,
      syncedRepoSha,
      autoMerge: true,
      waitBeforeMerge: 2000,
      adminSupabase,
      scope
    });

    if (!result.success) {
      throw new Error(result.error || "Sync failed");
    }

    // 5. Update database based on result (mirrors async worker behavior)
    if (result.no_changes) {
      console.log("\n✓ No changes needed - repository already up to date");
      const { error } = await adminSupabase
        .from("repositories")
        .update({
          synced_handout_sha: repo.assignments.latest_template_sha,
          desired_handout_sha: repo.assignments.latest_template_sha,
          sync_data: {
            last_sync_attempt: new Date().toISOString(),
            status: "no_changes_needed"
          }
        })
        .eq("id", repo.id);

      if (error) {
        throw new Error(`Failed to update repository ${repo.id} (no changes): ${error.message}`);
      }
      console.log("✓ Database updated");
    } else {
      console.log(`\n✓ Pull request created: #${result.pr_number}`);
      console.log(`  View at: ${result.pr_url}`);

      if (result.merged) {
        console.log("✓ Pull request auto-merged successfully");
        const { error } = await adminSupabase
          .from("repositories")
          .update({
            synced_handout_sha: repo.assignments.latest_template_sha,
            synced_repo_sha: result.merge_sha,
            desired_handout_sha: repo.assignments.latest_template_sha,
            sync_data: {
              pr_number: result.pr_number,
              pr_url: result.pr_url,
              pr_state: "merged",
              branch_name: `sync-to-${repo.assignments.latest_template_sha.substring(0, 7)}`,
              last_sync_attempt: new Date().toISOString(),
              merge_sha: result.merge_sha
            }
          })
          .eq("id", repo.id);

        if (error) {
          throw new Error(`Failed to update repository ${repo.id} (merged PR): ${error.message}`);
        }
        console.log(
          `✓ Database updated (handout SHA: ${repo.assignments.latest_template_sha}, merge SHA: ${result.merge_sha})`
        );
      } else {
        console.log("⚠ Pull request created but requires manual merge due to conflicts or checks");
        const { error } = await adminSupabase
          .from("repositories")
          .update({
            desired_handout_sha: repo.assignments.latest_template_sha,
            sync_data: {
              pr_number: result.pr_number,
              pr_url: result.pr_url,
              pr_state: "open",
              branch_name: `sync-to-${repo.assignments.latest_template_sha.substring(0, 7)}`,
              last_sync_attempt: new Date().toISOString()
            }
          })
          .eq("id", repo.id);

        if (error) {
          throw new Error(`Failed to update repository ${repo.id} (open PR): ${error.message}`);
        }
        console.log("✓ Database updated with PR info");
      }
    }

    console.log("\n✓ Done!");
  } catch (error) {
    console.error("\n✗ Error:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, scope);
    Deno.exit(1);
  }
}

// Run the main function
if (import.meta.main) {
  main();
}
