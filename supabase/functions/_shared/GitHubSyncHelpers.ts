/**
 * GitHubSyncHelpers.ts
 *
 * Reusable functions for syncing template repository changes to student repositories.
 * Can be used by async workers, scripts, or manual operations.
 */

import { Redis as UpstashRedis } from "https://deno.land/x/upstash_redis@v1.22.0/mod.ts";
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import Bottleneck from "https://esm.sh/bottleneck?target=deno";
import * as Sentry from "npm:@sentry/deno";
import { applyPatch } from "https://esm.sh/diff@5.1.0";
import { encodeBase64 } from "https://deno.land/std@0.221.0/encoding/base64.ts";
import * as github from "./GitHubWrapper.ts";
import { getCreateContentLimiter } from "./GitHubWrapper.ts";
import { Redis } from "./Redis.ts";
import { Database } from "./SupabaseTypes.d.ts";

export interface FileChange {
  path: string;
  /**
   * For binary or initial-sync files, this is the GitHub blob SHA at the *template* `toSha`.
   * `createBranchAndCommit` uses it to fetch content lazily so we don't hold every blob in memory at once.
   * For text files with a patch, `sha` is the blob SHA in the comparison response (informational).
   */
  sha?: string;
  patch?: string; // Unified diff for text files
  isBinary?: boolean;
  status?: string; // "added", "modified", "removed", "renamed"
  previous_filename?: string; // For renamed files
  /** Approximate size in bytes from the GitHub API; used by the size guard. */
  size?: number;
}

/**
 * Maximum total bytes of file content we'll buffer while syncing a single repo.
 * Belt-and-suspenders cap on cumulative bytes processed within one sync (each file
 * goes in/out of memory sequentially, so peak memory ≈ one file at a time, but this
 * prevents pathological "many medium files" handouts from blowing the budget).
 *
 * Sized to fit comfortably alongside one ~MAX_SYNC_FILE_BYTES file resident at peak
 * inside the Supabase Edge Function ~150 MB v8 heap.
 */
const MAX_SYNC_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB cumulative

/**
 * Hard per-file cap. Files larger than this fail fast with a clear error rather than
 * trying (and OOMing) the worker. The blob-copy path (`copyBlobBetweenRepos`) downloads
 * raw bytes (not base64) and uses a streaming Blob body for the upload to avoid the
 * 2× materialization that the Octokit JSON path forces, so peak memory ≈ raw + base64
 * ≈ 2.33×. At 75 MB raw that's ~175 MB transient, which is right at the edge — V8
 * generally GCs the raw buffer before the upload completes, but anything bigger is
 * not safe to attempt in this runtime.
 *
 * If you need to ship something bigger, run `FixStuckSyncs.ts` locally (no memory cap)
 * or move the data out-of-band (S3, course CDN, Git LFS).
 */
const MAX_SYNC_FILE_BYTES = 75 * 1024 * 1024; // 75 MB per single file

/**
 * Threshold above which a single file is considered "heavy" — heavy syncs serialize
 * themselves through `withHeavySyncLock` so we don't hold multiple large blobs in
 * memory simultaneously inside a single Edge Function isolate. Below this, syncs run
 * with the existing per-org Bottleneck concurrency (typical small-handout case).
 */
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

/**
 * Per-isolate semaphore that serializes "heavy" syncs (those with at least one file
 * over LARGE_FILE_THRESHOLD). Light syncs run as before. This is module-level state,
 * scoped to the current Edge Function isolate; cross-isolate coordination is provided
 * by the existing per-org Bottleneck (Redis-backed) which limits total in-flight syncs.
 */
let heavySyncQueue: Promise<unknown> = Promise.resolve();
function withHeavySyncLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain on top of the previous heavy sync. Use `.then(fn, fn)` so a rejected
  // previous run doesn't permanently poison the chain — either branch invokes `fn`.
  const next = heavySyncQueue.then(
    () => fn(),
    () => fn()
  );
  // Swallow rejection on the queue tail so future awaiters don't see this run's error.
  heavySyncQueue = next.catch(() => undefined);
  return next;
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
      reservoir: 20,
      maxConcurrent: 20,
      reservoirRefreshAmount: 20,
      reservoirRefreshInterval: 60_000,
      datastore: "ioredis",
      timeout: 600000, // 10 minutes
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
 * Fetch the recursive blob tree for a template at a specific SHA and return a map
 * of path → size in bytes. Used to populate per-file sizes on FileChange entries so
 * the sync can make size-aware concurrency decisions BEFORE downloading any content.
 *
 * Cached in Redis (12h TTL) keyed by (templateRepo, sha). The tree response is small
 * (metadata only) so the cache value is on the order of tens of KB even for large
 * repos and is safe to cache.
 */
export async function getTreeBlobSizes(
  templateRepo: string,
  sha: string,
  scope?: Sentry.Scope
): Promise<Map<string, number>> {
  const cacheKey = `github:tree-sizes:${templateRepo}/${sha}`;
  const redis = getRedisClient();

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached && typeof cached === "string") {
        const arr = JSON.parse(cached) as [string, number][];
        return new Map(arr);
      }
    } catch (error) {
      console.error("Redis cache read error (tree-sizes):", error);
    }
  }

  const octokit = await github.getOctoKit(templateRepo, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${templateRepo}`);
  }
  const [owner, repo] = templateRepo.split("/");

  const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner,
    repo,
    tree_sha: sha,
    recursive: "true"
  });

  const sizes = new Map<string, number>();
  for (const item of tree.tree) {
    if (item.type === "blob" && item.path && typeof item.size === "number") {
      sizes.set(item.path, item.size);
    }
  }

  if (redis) {
    try {
      await redis.setex(cacheKey, 43200, JSON.stringify(Array.from(sizes.entries())));
    } catch (error) {
      console.error("Redis cache write error (tree-sizes):", error);
    }
  }

  return sizes;
}

/**
 * Get all changed files between two commits in a template repository.
 * Returns metadata + patches only; binary file content is fetched lazily during
 * `createBranchAndCommit`. `size` is populated for every entry (looked up from
 * the recursive tree) so callers can make size-aware decisions without touching
 * any blob content.
 *
 * Results are cached in Redis with a 12-hour TTL.
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
    // Initial sync — record metadata for every blob in the template tree.
    // Content is intentionally NOT fetched here: doing so on a large handout
    // (e.g. a CSV dataset or many PDFs) easily exceeds Edge Function memory.
    // `createBranchAndCommit` fetches each blob lazily and discards it after use.
    const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: toSha,
      recursive: "true"
    });

    for (const item of tree.tree) {
      if (item.type === "blob" && item.path && item.sha) {
        fileChanges.push({
          path: item.path,
          sha: item.sha,
          isBinary: isBinaryPath(item.path),
          status: "added",
          size: typeof item.size === "number" ? item.size : undefined
        });
      }
    }
  } else {
    // Compare commits — return metadata + patches only. Binary content is fetched
    // lazily during `createBranchAndCommit` to keep peak memory low.
    const { data: comparison } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner,
      repo,
      basehead: `${fromSha}...${toSha}`
    });

    // The `compare` endpoint doesn't return per-file sizes, but we want sizes
    // populated on every FileChange so callers can make size-aware concurrency
    // decisions without downloading any blobs. Pull sizes from the recursive tree
    // at toSha (single API call, Redis-cached).
    let sizesAtToSha: Map<string, number> | undefined;
    try {
      sizesAtToSha = await getTreeBlobSizes(templateRepo, toSha, scope);
    } catch (error) {
      // Non-fatal: if the tree fetch fails we just don't have sizes; the size guard
      // inside createBranchAndCommit still applies during the lazy blob fetch.
      scope?.addBreadcrumb({
        message: `Failed to fetch tree sizes for ${templateRepo}@${toSha}: ${error}`,
        category: "sync",
        level: "warning"
      });
    }

    for (const file of comparison.files || []) {
      if (file.status === "removed") {
        fileChanges.push({
          path: file.filename,
          status: "removed"
        });
        continue;
      }

      // Handle renamed files: delete the old path, then add the new path
      if (file.status === "renamed" && file.previous_filename) {
        fileChanges.push({
          path: file.previous_filename,
          status: "removed"
        });
        // Continue to add the new filename entry below
      }

      const isBinary = !file.patch || isBinaryPath(file.filename);
      const sizeAtToSha = sizesAtToSha?.get(file.filename);

      if (isBinary) {
        if (!file.sha) {
          throw new Error(`No SHA available for file ${file.filename}`);
        }
        fileChanges.push({
          path: file.filename,
          sha: file.sha,
          isBinary: true,
          status: file.status,
          size: sizeAtToSha
        });
      } else {
        fileChanges.push({
          path: file.filename,
          sha: file.sha || undefined,
          patch: file.patch,
          isBinary: false,
          status: file.status,
          previous_filename: file.previous_filename,
          size: sizeAtToSha
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
 * Copy a single binary blob from a template repo into a student repo while keeping
 * peak memory as low as the runtime allows.
 *
 * The naive Octokit path (GET → templateBlob.content already base64 ~1.33×; POST →
 * Octokit JSON.stringify materializes another full base64 string) peaks at ~2× the
 * base64 size, which OOMs the Edge Function for files in the tens of MB.
 *
 * This implementation:
 *  1. Downloads RAW bytes (Accept: application/vnd.github.v3.raw) — saves the 33%
 *     base64 inflation on the wire and in memory.
 *  2. Base64-encodes the raw bytes once via @std/encoding/base64 (single allocation).
 *  3. Drops the raw buffer reference before the upload to give V8 a chance to GC it
 *     while the upload streams.
 *  4. Uploads via a `Blob` multi-chunk body so the JSON wrapper isn't materialized as
 *     one giant intermediate string — fetch streams the blob to the network.
 *
 * Net peak memory ≈ raw + base64 ≈ 2.33 × X (vs ~3 × X with Octokit JSON path).
 *
 * @returns The student-repo blob SHA suitable for use in a tree entry.
 */
async function copyBlobBetweenRepos(
  templateRepo: string,
  templateBlobSha: string,
  studentRepoFullName: string,
  filePath: string,
  scope?: Sentry.Scope
): Promise<string> {
  const templateOctokit = await github.getOctoKit(templateRepo, scope);
  const studentOctokit = await github.getOctoKit(studentRepoFullName, scope);
  if (!templateOctokit) throw new Error(`No octokit available for template repo ${templateRepo}`);
  if (!studentOctokit) throw new Error(`No octokit available for student repo ${studentRepoFullName}`);

  const [tOwner, tRepo] = templateRepo.split("/");
  const [sOwner, sRepo] = studentRepoFullName.split("/");

  // Resolve fresh GitHub App installation tokens via Octokit's auth strategy.
  // We can't use `octokit.request.endpoint(...)` directly because that returns
  // the *unauthenticated* request descriptor — auth is normally injected by
  // Octokit's request hooks at fire time. For raw `fetch` we have to add it
  // ourselves.
  const tAuth = (await templateOctokit.auth({ type: "installation" })) as { token: string };
  const sAuth = (await studentOctokit.auth({ type: "installation" })) as { token: string };

  const commonHeaders: Record<string, string> = {
    "User-Agent": "pawtograder-sync",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  // 1) Download raw bytes from the template (Accept: vnd.github.v3.raw) — saves
  //    the 33% base64 inflation that the JSON-wrapped blob endpoint would force.
  const getUrl = `https://api.github.com/repos/${encodeURIComponent(tOwner)}/${encodeURIComponent(
    tRepo
  )}/git/blobs/${encodeURIComponent(templateBlobSha)}`;
  const getResponse = await fetch(getUrl, {
    method: "GET",
    headers: {
      ...commonHeaders,
      Accept: "application/vnd.github.v3.raw",
      Authorization: `token ${tAuth.token}`
    }
  });
  if (!getResponse.ok) {
    const body = await getResponse.text().catch(() => "");
    throw new Error(
      `Failed to fetch raw blob ${templateBlobSha} for ${filePath} from ${templateRepo}: ` +
        `${getResponse.status} ${getResponse.statusText}: ${body.slice(0, 200)}`
    );
  }

  // 2) Encode to base64 once. We do this in an inner closure so the raw buffer
  //    reference is dropped before the upload starts, giving V8 the opportunity
  //    to GC it under memory pressure during the POST.
  const base64: string = await (async () => {
    const ab = await getResponse.arrayBuffer();
    const u8 = new Uint8Array(ab);
    return encodeBase64(u8);
  })();

  scope?.addBreadcrumb({
    message: `Copied ${filePath} via raw fetch (${base64.length} bytes base64)`,
    category: "sync",
    level: "debug"
  });

  // 3) Upload via a multi-chunk Blob body so the JSON wrapper isn't concatenated
  //    into one giant intermediate string. `fetch` streams the Blob without
  //    materializing it. Saves another full base64-string allocation that
  //    Octokit's JSON.stringify path would otherwise create.
  const postUrl = `https://api.github.com/repos/${encodeURIComponent(sOwner)}/${encodeURIComponent(sRepo)}/git/blobs`;
  const body = new Blob(['{"content":"', base64, '","encoding":"base64"}'], {
    type: "application/json"
  });
  const postResponse = await fetch(postUrl, {
    method: "POST",
    headers: {
      ...commonHeaders,
      Accept: "application/vnd.github+json",
      Authorization: `token ${sAuth.token}`,
      "Content-Type": "application/json"
    },
    body
  });
  if (!postResponse.ok) {
    const errBody = await postResponse.text().catch(() => "");
    throw new Error(
      `Failed to upload blob for ${filePath} to ${studentRepoFullName}: ` +
        `${postResponse.status} ${postResponse.statusText}: ${errBody.slice(0, 200)}`
    );
  }
  const json = (await postResponse.json()) as { sha?: string };
  if (!json.sha) {
    throw new Error(`Blob upload for ${filePath} returned no SHA`);
  }
  return json.sha;
}

/**
 * Create a branch and commit changes to a target repository
 * For text files with patches, applies the patch to the content at baseSha
 * For binary files or files with full content, uses the provided content
 * @param templateRepo - Optional template repo name for fallback when patch fails
 * @param templateSha - Optional template SHA to fetch content from when patch fails
 */
export async function createBranchAndCommit(
  repoFullName: string,
  branchName: string,
  baseSha: string,
  files: FileChange[],
  commitMessage: string,
  scope?: Sentry.Scope,
  templateRepo?: string,
  templateSha?: string
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

  // Create or update branch - handle various edge cases robustly
  let newRef: { ref: string };
  try {
    // First, try to create the branch
    const createResult = await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });
    newRef = createResult.data;
  } catch (createError: unknown) {
    const errorMessage = createError instanceof Error ? createError.message : String(createError);

    // If branch already exists, force-update it to the base SHA
    if (errorMessage.includes("Reference already exists")) {
      scope?.addBreadcrumb({
        message: `Branch ${branchName} already exists, force-updating to ${baseSha}`,
        category: "git",
        level: "info"
      });

      try {
        const updateResult = await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          owner,
          repo,
          ref: `heads/${branchName}`,
          sha: baseSha,
          force: true // Force update even if not a fast-forward
        });
        newRef = updateResult.data;
      } catch (updateError: unknown) {
        // If force update fails, try delete then create
        const updateErrorMsg = updateError instanceof Error ? updateError.message : String(updateError);
        scope?.addBreadcrumb({
          message: `Force update failed: ${updateErrorMsg}, trying delete+create`,
          category: "git",
          level: "warning"
        });

        try {
          await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
            owner,
            repo,
            ref: `heads/${branchName}`
          });
        } catch {
          // Ignore delete errors - branch might not exist or might be protected
        }

        // Try create again
        const retryResult = await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
          owner,
          repo,
          ref: `refs/heads/${branchName}`,
          sha: baseSha
        });
        newRef = retryResult.data;
      }
    } else {
      // Some other error - rethrow
      throw createError;
    }
  }
  scope?.setTag("new_ref", newRef.ref);

  const { data: baseCommit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner,
    repo,
    commit_sha: baseSha
  });
  scope?.setTag("base_commit_sha", baseCommit.sha);

  // Create blobs for all changed files. We process sequentially with a running
  // byte counter so peak memory is bounded by ~one file at a time, regardless
  // of how big the handout is.
  let totalBytesBuffered = 0;
  const enforceSizeBudget = (incomingBytes: number, filePath: string) => {
    totalBytesBuffered += incomingBytes;
    if (totalBytesBuffered > MAX_SYNC_TOTAL_BYTES) {
      const mb = (totalBytesBuffered / (1024 * 1024)).toFixed(1);
      const limitMb = (MAX_SYNC_TOTAL_BYTES / (1024 * 1024)).toFixed(0);
      throw new Error(
        `Handout sync exceeds size limit (${mb}MB > ${limitMb}MB) at file '${filePath}'. ` +
          `Use Git LFS or remove large binary assets from the handout repository.`
      );
    }
  };

  const treeItems: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
  for (const file of files) {
    // Handle removed files
    if (file.status === "removed") {
      treeItems.push({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: null
      });
      continue;
    }

    // Pre-flight size check using metadata from getChangedFiles, when available.
    if (typeof file.size === "number") {
      enforceSizeBudget(file.size, file.path);
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

      let patchedContent: string;
      try {
        const result = applyPatch(baseContent, file.patch);
        if (result === false) {
          throw new Error("Patch application failed");
        }
        patchedContent = result;
      } catch (patchError) {
        const patchPreview = file.patch ? file.patch.substring(0, 200) : "no patch";
        const baseContentPreview = baseContent.substring(0, 200);
        scope?.addBreadcrumb({
          message: `Failed to apply patch to ${file.path}`,
          category: "patch",
          level: "error",
          data: {
            error: String(patchError),
            baseContentLength: baseContent.length,
            patchLength: file.patch?.length || 0,
            patchPreview,
            baseContentPreview
          }
        });
        console.error(`Failed to apply patch to ${file.path}:`, patchError);
        console.error(`Base content length: ${baseContent.length}, Patch length: ${file.patch?.length || 0}`);
        console.error(`Patch preview: ${patchPreview}`);
        console.error(`Base content preview: ${baseContentPreview}`);

        // Fallback: fetch full content from template repo if available
        if (templateRepo && templateSha) {
          scope?.addBreadcrumb({
            message: `Attempting fallback: fetching full content from template repo for ${file.path}`,
            category: "patch",
            level: "info"
          });

          try {
            const templateOctokit = await github.getOctoKit(templateRepo, scope);
            if (templateOctokit) {
              const [templateOwner, templateRepoName] = templateRepo.split("/");
              const { data: templateFileData } = await templateOctokit.request(
                "GET /repos/{owner}/{repo}/contents/{path}",
                {
                  owner: templateOwner,
                  repo: templateRepoName,
                  path: file.path,
                  ref: templateSha
                }
              );

              if ("content" in templateFileData && templateFileData.content) {
                patchedContent = atob(templateFileData.content);
                scope?.addBreadcrumb({
                  message: `Successfully fetched full content from template repo for ${file.path}`,
                  category: "patch",
                  level: "info"
                });
              } else {
                throw new Error("Template file content not available");
              }
            } else {
              throw new Error("Could not get octokit for template repo");
            }
          } catch (fallbackError) {
            scope?.addBreadcrumb({
              message: `Fallback failed for ${file.path}: ${fallbackError}`,
              category: "patch",
              level: "error"
            });
            console.error(`Fallback failed for ${file.path}:`, fallbackError);
            throw new Error(
              `Patch application failed and fallback failed: ${patchError}. Fallback error: ${fallbackError}`
            );
          }
        } else {
          throw patchError;
        }
      }

      // Account for transient memory: base content + patched content concurrently in scope.
      enforceSizeBudget(baseContent.length + patchedContent.length, file.path);

      const encodedPatched = btoa(patchedContent);
      const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner,
        repo,
        content: encodedPatched,
        encoding: "base64"
      });

      treeItems.push({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha
      });
      continue;
    }

    // Handle binary files / initial-sync added files: copy the blob from the
    // template repo to the student repo using the memory-frugal raw-fetch +
    // streaming-Blob path (see `copyBlobBetweenRepos`), so peak memory stays
    // around 2.33× the file size instead of the ~3× the Octokit JSON path
    // would force.
    if (file.isBinary || file.status === "added") {
      if (!file.sha) {
        throw new Error(`File ${file.path} is binary/added but has no template blob SHA`);
      }
      if (!templateRepo) {
        throw new Error(`File ${file.path} requires lazy blob fetch but no templateRepo provided`);
      }

      const blobSha = await copyBlobBetweenRepos(templateRepo, file.sha, repoFullName, file.path, scope);

      // Account for the bytes we transiently held for this file (raw + base64).
      // We deliberately discarded the buffer above, so we approximate from the
      // known raw size when available. This budget mainly guards against the
      // pathological "many medium files" case rather than the single-file peak
      // (which is bounded by MAX_SYNC_FILE_BYTES + the 2.33× transient inflation).
      if (typeof file.size === "number") {
        enforceSizeBudget(Math.ceil(file.size * 1.34), file.path);
      }

      treeItems.push({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobSha
      });
      continue;
    }

    throw new Error(`File ${file.path} has neither patch nor blob SHA`);
  }

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

/**
 * Check if a repository already has the handout changes applied.
 *
 * This handles the case where a PR was merged but our database wasn't updated.
 * The student may have made ADDITIONAL edits to files (changing the SHA),
 * but the handout patch might already be applied.
 *
 * We check this by simulating what would happen if we applied the patches:
 * - For removed files: check if they're already gone
 * - For binary files: check if the content matches the template
 * - For text files with patches: check if applying the patch results in no change
 *   (meaning the patch is already applied)
 *
 * @returns true if all handout changes are already applied (no diff needed), false otherwise
 */
export async function isRepoAlreadyInSync(
  studentRepoFullName: string,
  templateRepo: string,
  changedFiles: FileChange[],
  templateToSha: string,
  scope?: Sentry.Scope
): Promise<boolean> {
  const studentOctokit = await github.getOctoKit(studentRepoFullName, scope);
  const templateOctokit = await github.getOctoKit(templateRepo, scope);

  if (!studentOctokit || !templateOctokit) {
    return false; // Can't verify, assume not in sync
  }

  const [studentOwner, studentRepo] = studentRepoFullName.split("/");
  const [templateOwner, templateRepoName] = templateRepo.split("/");

  scope?.addBreadcrumb({
    message: `Checking if ${studentRepoFullName} already has handout changes applied (${changedFiles.length} files)`,
    category: "sync",
    level: "info"
  });

  try {
    for (const file of changedFiles) {
      // Handle removed files
      if (file.status === "removed") {
        try {
          await studentOctokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner: studentOwner,
            repo: studentRepo,
            path: file.path,
            ref: "main"
          });
          // File still exists - not in sync
          scope?.addBreadcrumb({
            message: `File ${file.path} should be removed but still exists`,
            category: "sync",
            level: "debug"
          });
          return false;
        } catch (error: unknown) {
          // Only treat 404 as "file doesn't exist" - other errors (rate limit, auth, network) should fail the check
          const status =
            error && typeof error === "object" && "status" in error ? (error as { status: number }).status : undefined;
          if (status === 404) {
            // File doesn't exist - good, it was supposed to be removed
            continue;
          }
          // Other error (rate limit, auth, network, etc.) - can't reliably determine sync status
          scope?.addBreadcrumb({
            message: `Error checking if removed file ${file.path} exists: status=${status}, error=${error}`,
            category: "sync",
            level: "warning"
          });
          return false;
        }
      }

      // For binary files: compare blob SHAs (cheap, constant memory) instead of
      // downloading both contents. The contents endpoint returns the file's blob SHA.
      if (file.isBinary) {
        if (!file.sha) {
          // Can't verify without template SHA — fall through to "not in sync"
          return false;
        }
        try {
          const { data: studentMeta } = await studentOctokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner: studentOwner,
            repo: studentRepo,
            path: file.path,
            ref: "main"
          });
          const studentSha =
            studentMeta && typeof studentMeta === "object" && "sha" in studentMeta
              ? (studentMeta as { sha?: string }).sha
              : undefined;
          if (!studentSha || studentSha !== file.sha) {
            scope?.addBreadcrumb({
              message: `Binary file ${file.path} blob SHA differs from template`,
              category: "sync",
              level: "debug"
            });
            return false;
          }
          continue;
        } catch (error: unknown) {
          const status =
            error && typeof error === "object" && "status" in error ? (error as { status: number }).status : undefined;
          scope?.addBreadcrumb({
            message: `Error fetching binary file ${file.path} from student repo: status=${status}, error=${error}`,
            category: "sync",
            level: "warning"
          });
          return false;
        }
      }

      // For text files with patches we need student content to apply the patch.
      let studentContent: string;
      try {
        const { data: studentFile } = await studentOctokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          owner: studentOwner,
          repo: studentRepo,
          path: file.path,
          ref: "main"
        });
        if ("content" in studentFile && studentFile.content) {
          studentContent = atob(studentFile.content);
        } else {
          return false;
        }
      } catch (error: unknown) {
        const status =
          error && typeof error === "object" && "status" in error ? (error as { status: number }).status : undefined;
        if (status === 404) {
          scope?.addBreadcrumb({
            message: `File ${file.path} doesn't exist in student repo but should`,
            category: "sync",
            level: "debug"
          });
        } else {
          scope?.addBreadcrumb({
            message: `Error fetching file ${file.path} from student repo: status=${status}, error=${error}`,
            category: "sync",
            level: "warning"
          });
        }
        return false;
      }

      // For text files with patches: check if applying the patch results in no change
      if (file.patch && !file.isBinary) {
        try {
          const patchedContent = applyPatch(studentContent, file.patch);

          if (patchedContent === false) {
            // Patch failed to apply - could mean conflicts or already applied differently.
            // Compare student's file to expected template content as a loose secondary check.
            const { data: templateFile } = await templateOctokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
              owner: templateOwner,
              repo: templateRepoName,
              path: file.path,
              ref: templateToSha
            });

            if ("content" in templateFile && templateFile.content) {
              const expectedContent = atob(templateFile.content);
              if (studentContent.includes(expectedContent) || expectedContent === studentContent) {
                continue;
              }
            }

            scope?.addBreadcrumb({
              message: `Patch for ${file.path} failed to apply and content doesn't match template`,
              category: "sync",
              level: "debug"
            });
            return false;
          }

          if (patchedContent === studentContent) {
            // The patch is already applied
            continue;
          }

          scope?.addBreadcrumb({
            message: `File ${file.path} would change if patch applied - not in sync`,
            category: "sync",
            level: "debug"
          });
          return false;
        } catch (patchError) {
          scope?.addBreadcrumb({
            message: `Error applying patch to ${file.path}: ${patchError}`,
            category: "sync",
            level: "debug"
          });
          return false;
        }
      }

      // For added text files (no patch): compare student blob SHA to template blob SHA.
      if (file.status === "added" && file.sha) {
        // We already fetched studentFile above; recompare using its blob SHA if we have it.
        // (We don't have studentFile.sha in this scope; fall through to a content-includes check
        // using a fresh fetch is unnecessary — fall back to "not in sync" to be safe.)
        return false;
      }
    }

    // All files are in sync!
    scope?.addBreadcrumb({
      message: `Repository ${studentRepoFullName} already has all handout changes applied`,
      category: "sync",
      level: "info"
    });
    return true;
  } catch (error) {
    scope?.addBreadcrumb({
      message: `Error checking sync status: ${error}`,
      category: "sync",
      level: "warning"
    });
    return false; // On error, assume not in sync and proceed with normal flow
  }
}

/**
 * Find existing sync PRs for a repository with the given branch name pattern.
 * Returns info about any existing PR (open, merged, or closed without merge).
 */
export async function findExistingSyncPR(
  repoFullName: string,
  branchName: string,
  scope?: Sentry.Scope
): Promise<{
  exists: boolean;
  merged?: boolean;
  isOpen?: boolean;
  closedWithoutMerge?: boolean;
  prNumber?: number;
  prUrl?: string;
  mergeSha?: string;
} | null> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    return null;
  }

  const [owner, repo] = repoFullName.split("/");

  try {
    // Search for PRs with the given head branch
    const { data: prs } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      head: `${owner}:${branchName}`,
      state: "all" // Include both open and closed PRs
    });

    if (prs.length === 0) {
      return { exists: false };
    }

    const pr = prs[0]; // Get the most recent PR with this branch
    const prUrl = pr.html_url;
    const merged = pr.merged_at !== null;
    const isOpen = pr.state === "open";
    const closedWithoutMerge = pr.state === "closed" && !merged;

    scope?.addBreadcrumb({
      message: `Found existing PR #${pr.number} for branch ${branchName} (state: ${pr.state}, merged: ${merged}, closedWithoutMerge: ${closedWithoutMerge})`,
      category: "sync",
      level: "info"
    });

    return {
      exists: true,
      merged,
      isOpen,
      closedWithoutMerge,
      prNumber: pr.number,
      prUrl,
      mergeSha: pr.merge_commit_sha || undefined
    };
  } catch (error) {
    scope?.addBreadcrumb({
      message: `Error checking for existing PR: ${error}`,
      category: "sync",
      level: "warning"
    });
    return null;
  }
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
  console.log("Waiting for outer sync limiter to be available", org);
  return await limiter.schedule(async () => {
    console.log("Waiting for inner sync limiter to be available", org);
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

        // Size pre-flight: decide concurrency class BEFORE doing any heavy work.
        // Sizes are populated by getChangedFiles from the recursive tree (Redis-cached),
        // so this is essentially free.
        let maxFileBytes = 0;
        let totalChangedBytes = 0;
        let largestFilePath = "";
        for (const f of changedFiles) {
          if (typeof f.size === "number") {
            totalChangedBytes += f.size;
            if (f.size > maxFileBytes) {
              maxFileBytes = f.size;
              largestFilePath = f.path;
            }
          }
        }

        // Per-file hard cap. Files larger than this can't be synced through the Edge
        // Function runtime — base64-encoding a single 50MB+ blob already exceeds the
        // v8 heap budget. Fail fast with an actionable error.
        if (maxFileBytes > MAX_SYNC_FILE_BYTES) {
          const mb = (maxFileBytes / (1024 * 1024)).toFixed(1);
          const limitMb = (MAX_SYNC_FILE_BYTES / (1024 * 1024)).toFixed(0);
          throw new Error(
            `File '${largestFilePath}' is ${mb}MB which exceeds the per-file sync limit of ${limitMb}MB. ` +
              `Use Git LFS, host the data out-of-band, or remove it from the handout repository.`
          );
        }

        const isHeavySync = maxFileBytes > LARGE_FILE_THRESHOLD;
        scope?.setTag("sync_size_class", isHeavySync ? "heavy" : "light");
        scope?.setTag("max_file_bytes", String(maxFileBytes));
        scope?.setTag("total_changed_bytes", String(totalChangedBytes));
        scope?.setTag("largest_file", largestFilePath);
        if (isHeavySync) {
          scope?.addBreadcrumb({
            message:
              `Heavy sync detected: largest file '${largestFilePath}' is ${(maxFileBytes / (1024 * 1024)).toFixed(1)}MB ` +
              `(threshold ${(LARGE_FILE_THRESHOLD / (1024 * 1024)).toFixed(0)}MB). Will serialize through heavy-sync lock.`,
            category: "sync",
            level: "info"
          });
        }

        const branchName = `sync-to-${toSha.substring(0, 7)}`;

        // RESILIENCE CHECK 1: Check for existing PR with this branch name FIRST
        // This must happen before any branch deletion to avoid closing open PRs
        const existingPR = await findExistingSyncPR(repositoryFullName, branchName, scope);

        // RESILIENCE CHECK 2: Check if student repo is already in sync with template
        // This handles cases where a previous PR was merged but our database wasn't updated
        const alreadyInSync = await isRepoAlreadyInSync(repositoryFullName, templateRepo, changedFiles, toSha, scope);

        if (alreadyInSync) {
          scope?.addBreadcrumb({
            message: `Repository ${repositoryFullName} is already in sync with template at ${toSha}`,
            category: "sync",
            level: "info"
          });

          // If there's an existing merged PR, return its info so DB can be updated
          if (existingPR?.exists && existingPR.merged) {
            return {
              success: true,
              pr_number: existingPR.prNumber,
              pr_url: existingPR.prUrl,
              merged: true,
              merge_sha: existingPR.mergeSha
            };
          }

          // If there's an open PR but repo is in sync, the PR is stale
          // Don't delete the branch - let the PR remain for visibility
          // Just report no changes needed
          if (existingPR?.exists && !existingPR.merged) {
            scope?.addBreadcrumb({
              message: `Repository in sync but has open PR #${existingPR.prNumber} - may need manual review`,
              category: "sync",
              level: "warning"
            });
          }

          // Only clean up branch if NO PR exists (safe to delete)
          if (!existingPR?.exists) {
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
                // Branch doesn't exist, which is fine
              }
            }
          }

          return {
            success: true,
            no_changes: true
          };
        }

        if (existingPR?.exists) {
          if (existingPR.merged) {
            // PR was already merged! Just return success so the database can be updated
            scope?.addBreadcrumb({
              message: `Found already-merged PR #${existingPR.prNumber} for ${repositoryFullName}`,
              category: "sync",
              level: "info"
            });
            return {
              success: true,
              pr_number: existingPR.prNumber,
              pr_url: existingPR.prUrl,
              merged: true,
              merge_sha: existingPR.mergeSha
            };
          } else if (existingPR.isOpen) {
            // PR exists and is still open - return its info so caller knows the state
            scope?.addBreadcrumb({
              message: `Found open PR #${existingPR.prNumber} for ${repositoryFullName}`,
              category: "sync",
              level: "info"
            });
            return {
              success: true,
              pr_number: existingPR.prNumber,
              pr_url: existingPR.prUrl,
              merged: false
            };
          } else if (existingPR.closedWithoutMerge) {
            // PR was closed without merge - we need to create a new PR
            // The branch will be recreated below, and a new PR will be opened
            scope?.addBreadcrumb({
              message: `Found closed-without-merge PR #${existingPR.prNumber} for ${repositoryFullName} - will create new PR`,
              category: "sync",
              level: "info"
            });
            // Fall through to create new branch and PR
          }
        }

        // Create branch and commit based on syncedRepoSha (Student_orig)
        // This enables proper 3-way merging when the PR targets current main
        const commitMessage = `Sync handout updates to ${toSha.substring(0, 7)}

This commit was automatically generated by an instructor to sync
changes from the template repository.

Changed files:
${changedFiles.map((f) => `- ${f.path}`).join("\n")}`;

        // For heavy syncs, serialize the memory-intensive work (blob fetch + commit)
        // through a per-isolate semaphore so we never hold multiple large blobs in
        // memory simultaneously. Light syncs run as before.
        const runCommit = () =>
          createBranchAndCommit(
            repositoryFullName,
            branchName,
            syncedRepoSha,
            changedFiles,
            commitMessage,
            scope,
            templateRepo,
            toSha
          );
        if (isHeavySync) {
          await withHeavySyncLock(runCommit);
        } else {
          await runCommit();
        }

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
        let prUrl: string;
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
          prUrl = `https://github.com/${repositoryFullName}/pull/${prNumber}`;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          // Handle case where there are no commits between branches (repo already up to date)
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

          // Handle case where PR already exists (race condition or retry after partial failure)
          if (errorMessage.includes("A pull request already exists") || errorMessage.includes("already exists for")) {
            scope?.addBreadcrumb({
              message: `PR already exists for branch ${branchName}, looking up existing PR`,
              category: "sync",
              level: "info"
            });

            // Look up the existing PR
            const existingPRAfterError = await findExistingSyncPR(repositoryFullName, branchName, scope);
            if (existingPRAfterError?.exists) {
              if (existingPRAfterError.merged) {
                return {
                  success: true,
                  pr_number: existingPRAfterError.prNumber,
                  pr_url: existingPRAfterError.prUrl,
                  merged: true,
                  merge_sha: existingPRAfterError.mergeSha
                };
              } else {
                // Use the existing PR
                prNumber = existingPRAfterError.prNumber!;
                prUrl = existingPRAfterError.prUrl!;
                // Continue to auto-merge attempt below
              }
            } else {
              // Couldn't find the existing PR - re-throw the error
              throw error;
            }
          } else {
            // Re-throw if it's a different error
            throw error;
          }
        }

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
