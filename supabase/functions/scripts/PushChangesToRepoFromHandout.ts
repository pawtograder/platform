#!/usr/bin/env -S deno run --allow-env --allow-net
/* eslint-disable no-console */

/**
 * PushChangesToRepoFromHandout.ts
 *
 * This script syncs changes from a template/autograder repository to a student repository
 * by creating a pull request with the updated files.
 *
 * Usage: deno run --allow-env --allow-net PushChangesToRepoFromHandout.ts <repository_id_or_full_name>
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as Sentry from "@sentry/deno";
import { Buffer } from "node:buffer";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { getOctoKit } from "../_shared/GitHubWrapper.ts";

interface RepositoryData {
  id: number;
  repository: string;
  synced_handout_sha: string | null;
  assignment_id: number;
  class_id: number;
  assignments: {
    latest_template_sha: string | null;
    template_repo: string | null;
    title: string;
  };
}

interface FileChange {
  path: string;
  sha: string;
  content: string;
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
        "id, repository, synced_handout_sha, assignment_id, class_id, assignments(latest_template_sha, template_repo, title)"
      )
      .eq("id", parseInt(repoIdOrFullName))
      .single();
    data = result.data;
    error = result.error;
  } else {
    const result = await adminSupabase
      .from("repositories")
      .select(
        "id, repository, synced_handout_sha, assignment_id, class_id, assignments(latest_template_sha, template_repo, title)"
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

async function getChangedFiles(
  templateRepo: string,
  fromSha: string | null,
  toSha: string,
  scope: Sentry.Scope
): Promise<FileChange[]> {
  const octokit = await getOctoKit(templateRepo, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${templateRepo}`);
  }

  const [owner, repo] = templateRepo.split("/");

  // If there's no previous sync, we need to get all files at the toSha
  if (!fromSha) {
    console.log(`No previous sync found, fetching all files at ${toSha}`);
    const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: toSha,
      recursive: "true"
    });

    const fileChanges: FileChange[] = [];
    for (const item of tree.tree) {
      if (item.type === "blob" && item.path && item.sha) {
        // Get the file content
        const { data: blob } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: item.sha
        });
        fileChanges.push({
          path: item.path,
          sha: item.sha,
          content: blob.content
        });
      }
    }
    return fileChanges;
  }

  // Compare the two commits to get the diff
  const { data: comparison } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner,
    repo,
    basehead: `${fromSha}...${toSha}`
  });

  const fileChanges: FileChange[] = [];

  for (const file of comparison.files || []) {
    // Handle deleted files - we'll mark them with null content to remove them
    if (file.status === "removed") {
      console.log(`File deleted: ${file.filename}`);
      fileChanges.push({
        path: file.filename,
        sha: "", // Will be set to null when creating tree
        content: "" // Empty content indicates deletion
      });
      continue;
    }

    // Get the file content from the new commit
    const { data: fileContent } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path: file.filename,
      ref: toSha
    });

    if ("content" in fileContent && fileContent.sha) {
      fileChanges.push({
        path: file.filename,
        sha: fileContent.sha,
        content: fileContent.content
      });
    } else {
      console.log(`File ${file.filename} not found in the new commit`);
    }
  }

  return fileChanges;
}

async function createBranchAndCommit(
  repoFullName: string,
  branchName: string,
  baseBranch: string,
  files: FileChange[],
  commitMessage: string,
  scope: Sentry.Scope
): Promise<void> {
  const octokit = await getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  // Get the base branch reference
  const { data: baseRef } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner,
    repo,
    ref: `heads/${baseBranch}`
  });

  const baseSha = baseRef.object.sha;

  // Check if the branch already exists
  try {
    await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
      owner,
      repo,
      ref: `heads/${branchName}`
    });
    console.log(`Branch ${branchName} already exists, deleting it first...`);
    // Delete the existing branch
    await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${branchName}`
    });
  } catch {
    // Branch doesn't exist, which is fine
    console.log(`Branch ${branchName} does not exist, creating new branch`);
  }

  // Create the new branch
  await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha
  });

  // Get the base tree
  const { data: baseCommit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner,
    repo,
    commit_sha: baseSha
  });

  // Create blobs for all changed files in the target repository
  // We need to create new blobs because the SHAs from the template repo won't work here
  const treeItems = await Promise.all(
    files.map(async (file) => {
      // Handle deleted files - set sha to null to remove them from the tree
      if (file.content === "") {
        console.log(`Marking file for deletion: ${file.path}`);
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: null as unknown as string // null tells Git to delete the file
        };
      }

      // Decode the base64 content
      const content = Buffer.from(file.content, "base64").toString("utf-8");

      // Create a blob in the target repository
      const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner,
        repo,
        content,
        encoding: "utf-8"
      });

      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha
      };
    })
  );

  // Create a new tree
  const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems
  });

  // Create a new commit
  const { data: newCommit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [baseSha]
  });

  // Update the branch reference to point to the new commit
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: newCommit.sha
  });
}

async function createPullRequest(
  repoFullName: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string,
  scope: Sentry.Scope
): Promise<number> {
  const octokit = await getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    title,
    body,
    head: branchName,
    base: baseBranch
  });

  return pr.number;
}

async function mergePullRequest(
  repoFullName: string,
  prNumber: number,
  scope: Sentry.Scope
): Promise<{ merged: boolean; mergeSha?: string }> {
  const octokit = await getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  // Check if the PR is mergeable
  const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber
  });

  if (!pr.mergeable) {
    console.log(`PR #${prNumber} has merge conflicts and cannot be auto-merged`);
    return { merged: false };
  }

  // Merge the PR
  const { data: mergeResult } = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
    owner,
    repo,
    pull_number: prNumber,
    merge_method: "merge"
  });

  console.log(`Successfully merged PR #${prNumber}`);
  return { merged: true, mergeSha: mergeResult.sha };
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
      "Usage: deno run --allow-env --allow-net PushChangesToRepoFromHandout.ts <repository_id_or_full_name>"
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

    // 4. Get changed files
    console.log("\nFetching changed files...");
    const changedFiles = await getChangedFiles(
      repo.assignments.template_repo,
      repo.synced_handout_sha,
      repo.assignments.latest_template_sha,
      scope
    );
    console.log(`Found ${changedFiles.length} changed file(s)`);

    if (changedFiles.length === 0) {
      console.log("No files changed, nothing to sync.");
      Deno.exit(0);
    }

    // List changed files
    console.log("\nChanged files:");
    for (const file of changedFiles) {
      console.log(`  - ${file.path}`);
    }

    // 5. Create branch and commit changes
    const branchName = `sync-to-${repo.assignments.latest_template_sha.substring(0, 7)}`;
    const commitMessage = `Sync handout updates to ${repo.assignments.latest_template_sha.substring(0, 7)}

This commit was automatically generated by an instructor to sync
changes from the template repository.

Changed files:
${changedFiles.map((f) => `- ${f.path}`).join("\n")}`;

    console.log(`\nCreating branch: ${branchName}`);
    await createBranchAndCommit(repo.repository, branchName, "main", changedFiles, commitMessage, scope);
    console.log("Branch created and files committed");

    // 6. Create pull request
    const prTitle = `[Instructor Update] Sync handout to ${repo.assignments.latest_template_sha.substring(0, 7)}`;
    const prBody = `## Handout Update

This pull request syncs the latest changes from the assignment template repository.

**Triggered by:** Instructor
**Template commit:** ${repo.assignments.latest_template_sha}
**Previous sync:** ${repo.synced_handout_sha || "Initial sync"}

### Changed Files
${changedFiles.map((f) => `- \`${f.path}\``).join("\n")}

---
*This PR was automatically generated. It will be auto-merged if there are no conflicts. If there are conflicts, please review the changes and merge when ready, or ask your course staff for help.*`;

    console.log("\nCreating pull request...");
    const prNumber = await createPullRequest(repo.repository, branchName, "main", prTitle, prBody, scope);
    console.log(`Pull request created: #${prNumber}`);
    console.log(`View at: https://github.com/${repo.repository}/pull/${prNumber}`);

    // 7. Attempt to auto-merge
    console.log("\nChecking if PR can be auto-merged...");
    // Wait a bit for GitHub to update the mergeable state
    // TODO - do a retry loop here
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const mergeResult = await mergePullRequest(repo.repository, prNumber, scope);

    if (mergeResult.merged) {
      console.log("✓ Pull request auto-merged successfully");
      // Update both synced_handout_sha and synced_repo_sha in the database
      await updateSyncedShas(adminSupabase, repo.id, repo.assignments.latest_template_sha, mergeResult.mergeSha);
      console.log(
        `✓ Database updated (handout SHA: ${repo.assignments.latest_template_sha}, merge SHA: ${mergeResult.mergeSha})`
      );
    } else {
      console.log("⚠ Pull request created but requires manual merge due to conflicts or checks");
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
