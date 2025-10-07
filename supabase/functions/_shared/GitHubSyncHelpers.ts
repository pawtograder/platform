/**
 * GitHubSyncHelpers.ts
 *
 * Reusable functions for syncing template repository changes to student repositories.
 * Can be used by async workers, scripts, or manual operations.
 */

import { Redis as UpstashRedis } from "https://deno.land/x/upstash_redis@v1.22.0/mod.ts";
import { Redis } from "./Redis.ts";
import Bottleneck from "https://esm.sh/bottleneck?target=deno";
import * as Sentry from "npm:@sentry/deno";
import { getCreateContentLimiter } from "../github-async-worker/index.ts";
import * as github from "./GitHubWrapper.ts";

export interface FileChange {
  path: string;
  sha: string;
  content: string;
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
      id: `sync_repo_to_handout:${key}:${Deno.env.get("GITHUB_APP_ID") || ""}`,
      reservoir: 50,
      maxConcurrent: 50,
      reservoirRefreshAmount: 50,
      reservoirRefreshInterval: 60_000,
      datastore: "ioredis",
      clearDatastore: false,
      clientOptions: {
        host,
        password,
        username: "default",
        tls: {},
        port: 6379
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
    // Initial sync - get all files
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
          content: blob.content
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
          content: ""
        });
        continue;
      }

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
 */
export async function createBranchAndCommit(
  repoFullName: string,
  branchName: string,
  baseBranch: string,
  files: FileChange[],
  commitMessage: string,
  scope?: Sentry.Scope
): Promise<void> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  const { data: baseRef } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner,
    repo,
    ref: `heads/${baseBranch}`
  });

  const baseSha = baseRef.object.sha;
  const createContentLimiter = getCreateContentLimiter(owner);

  // Delete existing branch if it exists
  try {
    await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${branchName}`
    });
  } catch {
    // Branch doesn't exist, which is fine
  }

  // Create new branch
  await createContentLimiter.schedule(
    async () =>
      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner,
        repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha
      })
  );

  const { data: baseCommit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner,
    repo,
    commit_sha: baseSha
  });

  // Create blobs for all changed files
  const treeItems = await Promise.all(
    files.map(async (file) => {
      if (file.content === "") {
        // Deleted file
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: null as unknown as string
        };
      }

      const content = atob(file.content);
      const { data: blob } = await createContentLimiter.schedule(
        async () =>
          await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
            owner,
            repo,
            content,
            encoding: "utf-8"
          })
      );

      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha
      };
    })
  );

  const { data: newTree } = await createContentLimiter.schedule(
    async () =>
      await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo,
        base_tree: baseCommit.tree.sha,
        tree: treeItems
      })
  );

  const { data: newCommit } = await createContentLimiter.schedule(
    async () =>
      await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: commitMessage,
        tree: newTree.sha,
        parents: [baseSha]
      })
  );

  await createContentLimiter.schedule(
    async () =>
      await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
        owner,
        repo,
        ref: `heads/${branchName}`,
        sha: newCommit.sha
      })
  );
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
  scope?: Sentry.Scope
): Promise<number> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");
  const createContentLimiter = getCreateContentLimiter(owner);

  const { data: pr } = await createContentLimiter.schedule(
    async () =>
      await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        title,
        body,
        head: branchName,
        base: baseBranch
      })
  );

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
 */
export async function syncRepositoryToHandout(params: {
  repositoryFullName: string;
  templateRepo: string;
  fromSha: string | null;
  toSha: string;
  autoMerge?: boolean;
  waitBeforeMerge?: number; // milliseconds to wait before attempting merge
  scope?: Sentry.Scope;
}): Promise<SyncResult> {
  const org = params.repositoryFullName.split("/")[0];
  const limiter = getSyncLimiter(org);

  // Wrap the sync operation in the rate limiter
  return limiter.schedule(async () => {
    const {
      repositoryFullName,
      templateRepo,
      fromSha,
      toSha,
      autoMerge = true,
      waitBeforeMerge = 2000,
      scope
    } = params;

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

      // Create branch and commit
      const branchName = `sync-to-${toSha.substring(0, 7)}`;
      const commitMessage = `Sync handout updates to ${toSha.substring(0, 7)}

This commit was automatically generated by an instructor to sync
changes from the template repository.

Changed files:
${changedFiles.map((f) => `- ${f.path}`).join("\n")}`;

      await createBranchAndCommit(repositoryFullName, branchName, "main", changedFiles, commitMessage, scope);

      // Create PR
      const prTitle = `[Instructor Update] Sync handout to ${toSha.substring(0, 7)}`;
      const prBody = `## Handout Update

This pull request syncs the latest changes from the assignment template repository.

**Triggered by:** Instructor
**Template commit:** ${toSha}
**Previous sync:** ${fromSha || "Initial sync"}

### Changed Files
${changedFiles.map((f) => `- \`${f.path}\``).join("\n")}

---
*This PR was automatically generated. It will be auto-merged if there are no conflicts. If there are conflicts, please review the changes and merge when ready, or ask your course staff for help.*`;

      let prNumber: number;
      try {
        prNumber = await createPullRequest(repositoryFullName, branchName, "main", prTitle, prBody, scope);
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
}
