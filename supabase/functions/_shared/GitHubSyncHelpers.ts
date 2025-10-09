/**
 * GitHubSyncHelpers.ts
 *
 * Reusable functions for syncing template repository changes to student repositories.
 * Can be used by async workers, scripts, or manual operations.
 */

import { Redis as UpstashRedis } from "https://deno.land/x/upstash_redis@v1.22.0/mod.ts";
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import Bottleneck from "https://esm.sh/bottleneck?target=deno";
import * as Sentry from "npm:@sentry/deno";
import { applyPatch } from "https://esm.sh/diff@5.1.0";
import { getCreateContentLimiter } from "../github-async-worker/index.ts";
import * as github from "./GitHubWrapper.ts";
import { Redis } from "./Redis.ts";
import { Database } from "./SupabaseTypes.d.ts";

export interface FileChange {
  path: string;
  sha?: string;
  content?: string; // Only for binary files or initial sync
  patch?: string; // Unified diff for text files
  isBinary?: boolean;
  status?: string; // "added", "modified", "removed", "renamed"
  previous_filename?: string; // For renamed files
}

export interface SyncResult {
  success: boolean;
  pr_number?: number;
  pr_url?: string;
  merged?: boolean;
  merge_sha?: string;
  error?: string;
  no_changes?: boolean;
}

// Redis client for caching
let redisClient: UpstashRedis | null = null;

function getRedisClient(): UpstashRedis | null {
  if (redisClient) {
    return redisClient;
  }

  const redisUrl = Deno.env.get("UPSTASH_REDIS_REST_URL");
  const redisToken = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

  if (redisUrl && redisToken) {
    redisClient = new UpstashRedis({ url: redisUrl, token: redisToken });
    return redisClient;
  }

  return null;
}

const syncLimiters = new Map<string, Bottleneck>();
// Bottleneck limiter for sync operations - limit to 20 concurrent to avoid thrashing between multiple requests
function getSyncLimiter(org: string): Bottleneck {
  const key = org || "unknown";
  const existing = syncLimiters.get(key);
  if (existing) return existing;
  let limiter: Bottleneck;
  const upstashUrl = Deno.env.get("UPSTASH_REDIS_REST_URL");
  const upstashToken = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");
  if (upstashUrl && upstashToken) {
    const host = upstashUrl.replace("https://", "");
    const password = upstashToken;
    limiter = new Bottleneck({
      id: `sync_repo_to_handout_new:${key}:${Deno.env.get("GITHUB_APP_ID") || ""}`,
      reservoir: 30,
      maxConcurrent: 30,
      reservoirRefreshAmount: 30,
      reservoirRefreshInterval: 60_000,
      datastore: "ioredis",
      clearDatastore: false,
      clientOptions: {
        host,
        password,
        username: "default"
      },
      Redis
    });
    limiter.on("error", (err: Error) => console.error(err));
  } else {
    Sentry.captureMessage("No Upstash URL or token found, using local limiter");
    limiter = new Bottleneck({
      id: `sync_repo_to_handout:${key}:${Deno.env.get("GITHUB_APP_ID") || ""}`,
      reservoir: 10,
      reservoirRefreshAmount: 10,
      reservoirRefreshInterval: 60_000
    });
  }
  syncLimiters.set(key, limiter);
  return limiter;
}

/**
 * Get the first (initial) commit in a repository
 */
export async function getFirstCommit(repoFullName: string, branch: string, scope?: Sentry.Scope): Promise<string> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  // Start from the branch HEAD and traverse back to find the first commit
  let oldestSha: string | undefined;
  const { data: headRef } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner,
    repo,
    ref: `heads/${branch}`
  });

  let currentSha = headRef.object.sha;

  // Keep following parent commits until we find one with no parents
  while (currentSha) {
    const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      owner,
      repo,
      commit_sha: currentSha
    });

    if (!commit.parents || commit.parents.length === 0) {
      // Found the first commit (no parents)
      oldestSha = commit.sha;
      break;
    }

    // Follow the first parent (in case of merge commits)
    currentSha = commit.parents[0].sha;
  }

  if (!oldestSha) {
    throw new Error(`Could not find first commit in repository ${repoFullName}`);
  }

  scope?.addBreadcrumb({
    message: `Found first commit in ${repoFullName}: ${oldestSha}`,
    category: "git",
    level: "info"
  });

  return oldestSha;
}

/**
 * Detect if a file is binary based on its extension/path
 */
function isBinaryPath(path: string): boolean {
  const binaryExtensions = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".rar",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".class",
    ".jar",
    ".war",
    ".ear",
    ".pyc",
    ".pyo",
    ".o",
    ".a",
    ".lib",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".otf",
    ".mp3",
    ".mp4",
    ".avi",
    ".mov",
    ".wmv",
    ".flv",
    ".webm",
    ".ogg",
    ".wav",
    ".flac"
  ];

  const lowerPath = path.toLowerCase();
  return binaryExtensions.some((ext) => lowerPath.endsWith(ext));
}

/**
 * Get all changed files between two commits in a template repository
 * Results are cached in Redis with a 12-hour TTL
 */
export async function getChangedFiles(
  templateRepo: string,
  fromSha: string | null,
  toSha: string,
  scope?: Sentry.Scope
): Promise<FileChange[]> {
  // Try to get from cache first
  const cacheKey = `github:changed-files:${templateRepo}/${fromSha || "initial"}/${toSha}`;
  const redis = getRedisClient();

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached && typeof cached === "string") {
        scope?.addBreadcrumb({
          message: `Cache hit for changed files: ${cacheKey}`,
          category: "cache",
          level: "info"
        });
        return JSON.parse(cached) as FileChange[];
      }
    } catch (error) {
      console.error("Redis cache read error:", error);
      // Continue to fetch from GitHub if cache fails
    }
  }

  scope?.addBreadcrumb({
    message: `Cache miss for changed files: ${cacheKey}`,
    category: "cache",
    level: "info"
  });

  const octokit = await github.getOctoKit(templateRepo, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${templateRepo}`);
  }

  const [owner, repo] = templateRepo.split("/");

  const fileChanges: FileChange[] = [];

  if (!fromSha) {
    // Initial sync - get all files with full content (no patches available)
    const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: toSha,
      recursive: "true"
    });

    for (const item of tree.tree) {
      if (item.type === "blob" && item.path && item.sha) {
        const { data: blob } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: item.sha
        });
        fileChanges.push({
          path: item.path,
          sha: item.sha,
          content: blob.content,
          isBinary: isBinaryPath(item.path),
          status: "added"
        });
      }
    }
  } else {
    // Compare commits
    const { data: comparison } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner,
      repo,
      basehead: `${fromSha}...${toSha}`
    });

    for (const file of comparison.files || []) {
      if (file.status === "removed") {
        fileChanges.push({
          path: file.filename,
          sha: "",
          content: "",
          status: "removed"
        });
        continue;
      }

      // Handle renamed files: delete the old path, then add the new path
      if (file.status === "renamed" && file.previous_filename) {
        fileChanges.push({
          path: file.previous_filename,
          sha: "",
          content: "",
          status: "removed"
        });
        // Continue to add the new filename entry below
      }

      const isBinary = !file.patch || isBinaryPath(file.filename);

      if (isBinary) {
        // For binary files or large files, fetch the complete content using Git blobs API
        // This avoids the 1MB truncation limit of the contents endpoint and preserves binary data
        if (!file.sha) {
          throw new Error(`No SHA available for file ${file.filename}`);
        }

        const { data: blob } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
          owner,
          repo,
          file_sha: file.sha
        });

        // Verify the blob is base64-encoded as expected
        if (blob.encoding !== "base64") {
          throw new Error(`Unexpected encoding for file ${file.filename}: ${blob.encoding}`);
        }

        fileChanges.push({
          path: file.filename,
          sha: file.sha,
          content: blob.content,
          isBinary: true,
          status: file.status
        });
      } else {
        // For text files, use the patch from GitHub
        fileChanges.push({
          path: file.filename,
          patch: file.patch,
          isBinary: false,
          status: file.status,
          previous_filename: file.previous_filename
        });
      }
    }
  }

  // Cache the result with 12-hour TTL (43200 seconds)
  if (redis) {
    try {
      await redis.setex(cacheKey, 43200, JSON.stringify(fileChanges));
      scope?.addBreadcrumb({
        message: `Cached changed files: ${cacheKey}`,
        category: "cache",
        level: "info"
      });
    } catch (error) {
      console.error("Redis cache write error:", error);
      // Continue even if caching fails
    }
  }

  return fileChanges;
}

/**
 * Create a branch and commit changes to a target repository
 * For text files with patches, applies the patch to the content at baseSha
 * For binary files or files with full content, uses the provided content
 */
export async function createBranchAndCommit(
  repoFullName: string,
  branchName: string,
  baseSha: string,
  files: FileChange[],
  commitMessage: string,
  scope?: Sentry.Scope
): Promise<void> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");
  scope?.setTag("owner", owner);
  scope?.setTag("repo", repo);
  scope?.setTag("base_sha", baseSha);
  scope?.setTag("branch_name", branchName);
  scope?.setTag("commit_message", commitMessage);

  console.log("createBranchAndCommit", repoFullName, branchName, baseSha, files.length, "files");

  // Create new branch
  try {
    await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${branchName}`
    });
  } catch {
    // Branch doesn't exist, which is fine
  }
  const { data: newRef } = await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha
  });
  scope?.setTag("new_ref", newRef.ref);

  const { data: baseCommit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner,
    repo,
    commit_sha: baseSha
  });
  scope?.setTag("base_commit_sha", baseCommit.sha);

  // Create blobs for all changed files
  const treeItems = await Promise.all(
    files.map(async (file) => {
      // Handle removed files
      if (file.status === "removed" || file.content === "") {
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: null as unknown as string
        };
      }

      // Handle files with patches (text files that need to be merged)
      if (file.patch && !file.isBinary) {
        scope?.addBreadcrumb({
          message: `Applying patch to ${file.path}`,
          category: "patch",
          level: "info"
        });

        // Fetch the current content from the student repo at baseSha
        let baseContent = "";
        try {
          const { data: fileData } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner,
            repo,
            path: file.path,
            ref: baseSha
          });

          if ("content" in fileData && fileData.content) {
            // Decode base64 content
            baseContent = atob(fileData.content);
          }
        } catch {
          // File doesn't exist in student repo (new file), use empty content
          scope?.addBreadcrumb({
            message: `File ${file.path} doesn't exist at baseSha, treating as new file`,
            category: "patch",
            level: "info"
          });
        }

        // Apply the patch
        let patchedContent: string;
        try {
          const result = applyPatch(baseContent, file.patch);
          if (result === false) {
            throw new Error("Patch application failed");
          }
          patchedContent = result;
        } catch (patchError) {
          scope?.addBreadcrumb({
            message: `Failed to apply patch to ${file.path}: ${patchError}`,
            category: "patch",
            level: "error"
          });
          console.error(`Failed to apply patch to ${file.path}:`, patchError);
          throw patchError;
        }

        // Create blob with patched content
        const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
          owner,
          repo,
          content: btoa(patchedContent), // Encode to base64
          encoding: "base64"
        });

        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.sha
        };
      }

      // Handle files with full content (binary files or initial sync)
      if (file.content) {
        const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
          owner,
          repo,
          content: file.content,
          encoding: "base64"
        });
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.sha
        };
      }

      throw new Error(`File ${file.path} has neither patch nor content`);
    })
  );

  const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems
  });
  const { data: newCommit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [baseSha]
  });
  scope?.setTag("new_commit_sha", newCommit.sha);
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: newCommit.sha
  });
}

/**
 * Create a pull request
 */
export async function createPullRequest(
  repoFullName: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string,
  adminSupabase: SupabaseClient<Database>,
  scope?: Sentry.Scope
): Promise<number> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  scope?.setTag("owner", owner);
  scope?.setTag("repo", repo);
  scope?.setTag("branch_name", branchName);
  scope?.setTag("base_branch", baseBranch);
  scope?.setTag("title", title);
  scope?.setTag("body", body);
  scope?.setTag("github_operation", "create_pull_request");
  const createContentLimiter = getCreateContentLimiter(owner);
  const { data: pr } = await createContentLimiter.schedule(async () => {
    //Also check the circuit breaker before we hit this, and fail if we have already bit the big one
    const circuitKey = `${owner}:sync_repo_to_handout`;
    const methodCirc = await adminSupabase.schema("public").rpc("get_github_circuit", {
      p_scope: "org_method",
      p_key: circuitKey
    });
    if (!methodCirc.error && Array.isArray(methodCirc.data) && methodCirc.data.length > 0) {
      // const row = methodCirc.data[0] as { state?: string; open_until?: string };
      // if (row?.state === "open" && (!row.open_until || new Date(row.open_until) > new Date())) {
      //   throw new UserVisibleError(
      //     `GitHub operations temporarily unavailable due to repeated errors. Please try again in 8 hours.`
      //   );
      // }
    }
    return await octokit.request("POST /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      title,
      body,
      head: branchName,
      base: baseBranch
    });
  });

  return pr.number;
}

/**
 * Attempt to auto-merge a pull request
 */
export async function attemptAutoMerge(
  repoFullName: string,
  prNumber: number,
  scope?: Sentry.Scope
): Promise<{ merged: boolean; mergeSha?: string }> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber
  });

  if (!pr.mergeable) {
    return { merged: false };
  }

  const { data: mergeResult } = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
    owner,
    repo,
    pull_number: prNumber,
    merge_method: "merge"
  });

  return { merged: true, mergeSha: mergeResult.sha };
}

/**
 * Complete sync operation: compare files, create branch, commit, PR, and optionally auto-merge
 *
 * This is the main entry point for syncing a repository to a template
 * Rate-limited using Bottleneck to prevent overwhelming GitHub API
 *
 * @param syncedRepoSha - The SHA of the student repo at the last successful sync (Student_orig).
 *                        This is used as the base for the PR branch to enable proper 3-way merging.
 */
export async function syncRepositoryToHandout(params: {
  repositoryFullName: string;
  templateRepo: string;
  fromSha: string | null;
  toSha: string;
  syncedRepoSha: string;
  adminSupabase: SupabaseClient<Database>;
  autoMerge?: boolean;
  waitBeforeMerge?: number; // milliseconds to wait before attempting merge
  scope?: Sentry.Scope;
}): Promise<SyncResult> {
  const org = params.repositoryFullName.split("/")[0];
  const limiter = getSyncLimiter(org);
  const { adminSupabase } = params;
  const createContentLimiter = getCreateContentLimiter(org);
  console.log("Waiting for sync limiter to be available", org);
  return await limiter.schedule(async () => {
    console.log("Waiting for sync limiter to be available", org);
    return await createContentLimiter.schedule(async () => {
      // Wrap the sync operation in the rate limiter
      console.log("syncRepositoryToHandout", params);
      const {
        repositoryFullName,
        templateRepo,
        fromSha,
        toSha,
        syncedRepoSha,
        autoMerge = true,
        waitBeforeMerge = 2000,
        scope
      } = params;
      scope?.setTag("repository", repositoryFullName);
      scope?.setTag("template_repo", templateRepo);
      scope?.setTag("from_sha", fromSha);
      scope?.setTag("to_sha", toSha);
      scope?.setTag("synced_repo_sha", syncedRepoSha);
      scope?.setTag("auto_merge", autoMerge.toString());
      scope?.setTag("wait_before_merge", waitBeforeMerge.toString());
      scope?.setTag("sync_operation", "sync_repository_to_handout");

      scope?.addBreadcrumb({
        message: `Starting rate-limited sync for ${repositoryFullName}`,
        category: "sync",
        level: "info"
      });

      try {
        // Get changed files (with caching)
        const changedFiles = await getChangedFiles(templateRepo, fromSha, toSha, scope);

        if (changedFiles.length === 0) {
          return {
            success: true,
            no_changes: true
          };
        }

        // Create branch and commit based on syncedRepoSha (Student_orig)
        // This enables proper 3-way merging when the PR targets current main
        const branchName = `sync-to-${toSha.substring(0, 7)}`;
        const commitMessage = `Sync handout updates to ${toSha.substring(0, 7)}

This commit was automatically generated by an instructor to sync
changes from the template repository.

Changed files:
${changedFiles.map((f) => `- ${f.path}`).join("\n")}`;

        await createBranchAndCommit(repositoryFullName, branchName, syncedRepoSha, changedFiles, commitMessage, scope);

        // Create PR
        const prTitle = `[Instructor Update] Sync handout to ${toSha.substring(0, 7)}`;

        // Categorize files for better PR description
        const textFiles = changedFiles.filter((f) => !f.isBinary && f.status !== "removed");
        const binaryFiles = changedFiles.filter((f) => f.isBinary && f.status !== "removed");
        const removedFiles = changedFiles.filter((f) => f.status === "removed");

        const prBody = `## Handout Update

This pull request syncs the latest changes from the assignment template repository.

**Triggered by:** Instructor
**Template commit:** ${toSha}
**Previous sync:** ${fromSha || "Initial sync"}
**Base commit:** ${syncedRepoSha.substring(0, 7)}

### How This Works

This PR uses a **3-way merge strategy** to preserve your work:
- **Base**: The state of your repo at the last sync (${syncedRepoSha.substring(0, 7)})
- **Changes**: Updates from the handout template
- **Your Work**: Any commits you've made since the last sync

GitHub will automatically merge these together. If you modified the same parts of files that the instructor updated, you'll see merge conflicts that need to be resolved.

### Changed Files

${textFiles.length > 0 ? `**Text files** (will be merged with your changes):\n${textFiles.map((f) => `- \`${f.path}\``).join("\n")}\n\n` : ""}${binaryFiles.length > 0 ? `**Binary files** (will overwrite your version):\n${binaryFiles.map((f) => `- \`${f.path}\``).join("\n")}\n\n` : ""}${removedFiles.length > 0 ? `**Removed files**:\n${removedFiles.map((f) => `- \`${f.path}\``).join("\n")}\n\n` : ""}
---
*This PR was automatically generated. It will be auto-merged if there are no conflicts. If there are merge conflicts, they will be shown in the GitHub UI - you can resolve them directly on GitHub or locally. If you need help, ask your course staff.*`;

        let prNumber: number;
        try {
          prNumber = await createPullRequest(
            repositoryFullName,
            branchName,
            "main",
            prTitle,
            prBody,
            adminSupabase,
            scope
          );
        } catch (error) {
          // Handle case where there are no commits between branches (repo already up to date)
          const errorMessage = error instanceof Error ? error.message : String(error);
          if (errorMessage.includes("No commits between")) {
            scope?.addBreadcrumb({
              message: `No commits between branches - repository already up to date`,
              category: "sync",
              level: "info"
            });

            // Clean up the branch we created
            const octokit = await github.getOctoKit(repositoryFullName, scope);
            if (octokit) {
              const [owner, repo] = repositoryFullName.split("/");
              try {
                await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
                  owner,
                  repo,
                  ref: `heads/${branchName}`
                });
              } catch {
                // Ignore cleanup errors
              }
            }

            return {
              success: true,
              no_changes: true
            };
          }
          // Re-throw if it's a different error
          throw error;
        }

        const prUrl = `https://github.com/${repositoryFullName}/pull/${prNumber}`;

        // Attempt auto-merge if requested
        let merged = false;
        let mergeSha: string | undefined;

        if (autoMerge) {
          // Wait for GitHub to update mergeable state
          await new Promise((resolve) => setTimeout(resolve, waitBeforeMerge));
          const mergeResult = await attemptAutoMerge(repositoryFullName, prNumber, scope);
          merged = mergeResult.merged;
          mergeSha = mergeResult.mergeSha;
        }

        return {
          success: true,
          pr_number: prNumber,
          pr_url: prUrl,
          merged,
          merge_sha: mergeSha
        };
      } catch (error) {
        console.trace(error);
        Sentry.captureException(error, scope);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });
  });
}
