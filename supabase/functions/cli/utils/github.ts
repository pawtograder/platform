/**
 * GitHub API utilities for CLI (repo existence check, copy contents).
 */

import { getOctoKit } from "../../_shared/GitHubWrapper.ts";

/** Commit message used when copying repo contents - used to detect if copy succeeded in a previous run */
export const COPY_CONTENT_COMMIT_MESSAGE_PREFIX = "Copy content from ";

interface GitTreeBlobEntry {
  path?: string;
  mode?: string;
  type: "blob";
  sha: string;
}

interface SourceBlobRef {
  path: string;
  mode: string;
  sha: string;
}

/** Max blobs per copy; Git tree creation has practical limits (~100k entries). */
const MAX_BLOBS_PER_COPY = 95_000;

function copyBlobConcurrency(): number {
  const raw = Deno.env.get("CLI_GITHUB_COPY_BLOB_CONCURRENCY");
  const n = raw ? parseInt(raw, 100) : NaN;
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.min(64, Math.max(1, n));
}

async function mapPool<T, R>(items: T[], poolSize: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Math.min(poolSize, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function isRetryableRateLimitError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { status?: number; message?: string; response?: { data?: { message?: string } } };
  const status = err.status;
  if (status === 429) return true;
  if (status === 403) {
    const text = [err.message, err.response?.data?.message].filter(Boolean).join(" ").toLowerCase();
    return text.includes("rate") || text.includes("abuse") || text.includes("quota");
  }
  return false;
}

async function withRateLimitRetries<T>(fn: () => Promise<T>): Promise<T> {
  const maxAttempts = 8;
  let delayMs = 2000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isRetryableRateLimitError(e) || attempt === maxAttempts - 1) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(Math.floor(delayMs * 1.8), 90_000);
    }
  }
  throw new Error("unreachable");
}

/**
 * List all blob objects under a tree. Uses recursive tree API when possible;
 * falls back to walking subtrees if the response is truncated (large repos).
 */
async function listSourceBlobRefs(
  sourceOctokit: NonNullable<Awaited<ReturnType<typeof getOctoKit>>>,
  sourceOrg: string,
  sourceRepo: string,
  sourceTreeSha: string
): Promise<SourceBlobRef[]> {
  const { data } = await withRateLimitRetries(() =>
    sourceOctokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner: sourceOrg,
      repo: sourceRepo,
      tree_sha: sourceTreeSha,
      recursive: "true"
    })
  );

  const tree = data.tree as Array<{ type?: string; path?: string; mode?: string; sha?: string }>;
  if (!data.truncated) {
    return tree
      .filter((item) => item.type === "blob" && item.sha && item.path)
      .map((item) => ({
        path: item.path!,
        mode: item.mode ?? "100644",
        sha: item.sha!
      }));
  }

  return walkTreeForBlobs(sourceOctokit, sourceOrg, sourceRepo, sourceTreeSha, "");
}

async function walkTreeForBlobs(
  sourceOctokit: NonNullable<Awaited<ReturnType<typeof getOctoKit>>>,
  owner: string,
  repo: string,
  treeSha: string,
  pathPrefix: string
): Promise<SourceBlobRef[]> {
  const { data } = await withRateLimitRetries(() =>
    sourceOctokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: treeSha
    })
  );

  const out: SourceBlobRef[] = [];
  for (const item of data.tree as Array<{ type?: string; path?: string; mode?: string; sha?: string }>) {
    if (!item.path || !item.sha) continue;
    const fullPath = pathPrefix ? `${pathPrefix}/${item.path}` : item.path;
    if (item.type === "blob") {
      out.push({ path: fullPath, mode: item.mode ?? "100644", sha: item.sha });
    } else if (item.type === "tree") {
      const nested = await walkTreeForBlobs(sourceOctokit, owner, repo, item.sha, fullPath);
      out.push(...nested);
    }
  }
  return out;
}

export async function repoExistsOnGitHub(repoFullName: string): Promise<boolean> {
  const [org, repo] = repoFullName.split("/");
  const octokit = await getOctoKit(org);
  if (!octokit) return false;
  try {
    await octokit.request("GET /repos/{owner}/{repo}", { owner: org, repo });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns true if the target repo has a commit indicating content was successfully copied
 * from the source (e.g. from a previous run that created the repo but then failed after copy).
 */
export async function targetRepoHasContentFromSource(
  sourceRepoFullName: string,
  targetRepoFullName: string
): Promise<boolean> {
  const [targetOrg, targetRepo] = targetRepoFullName.split("/");
  const octokit = await getOctoKit(targetOrg);
  if (!octokit) return false;
  const expectedMessage = `${COPY_CONTENT_COMMIT_MESSAGE_PREFIX}${sourceRepoFullName}`;
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/commits", {
      owner: targetOrg,
      repo: targetRepo,
      per_page: 1
    });
    const latestCommit = Array.isArray(data) ? data[0] : null;
    return latestCommit?.commit?.message?.trim() === expectedMessage;
  } catch {
    return false;
  }
}

export async function copyRepoContentsViaGitHub(sourceRepoFullName: string, targetRepoFullName: string): Promise<void> {
  const [sourceOrg, sourceRepo] = sourceRepoFullName.split("/");
  const [targetOrg, targetRepo] = targetRepoFullName.split("/");

  const sourceOctokit = await getOctoKit(sourceOrg);
  const targetOctokit = await getOctoKit(targetOrg);

  if (!sourceOctokit || !targetOctokit) {
    throw new Error(`GitHub access not available for ${sourceOrg} or ${targetOrg}`);
  }

  // Brief pause so a freshly created target repo accepts writes
  await new Promise((resolve) => setTimeout(resolve, 500));

  let sourceRef: { data: { object: { sha: string }; url?: string } };
  try {
    sourceRef = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/ref/heads/main", {
      owner: sourceOrg,
      repo: sourceRepo
    });
  } catch {
    sourceRef = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/ref/heads/master", {
      owner: sourceOrg,
      repo: sourceRepo
    });
  }

  const sourceCommitSha = sourceRef.data.object.sha;

  const sourceCommit = await withRateLimitRetries(() =>
    sourceOctokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      owner: sourceOrg,
      repo: sourceRepo,
      commit_sha: sourceCommitSha
    })
  );

  const sourceTreeSha = sourceCommit.data.tree.sha;

  const blobRefs = await listSourceBlobRefs(sourceOctokit, sourceOrg, sourceRepo, sourceTreeSha);
  blobRefs.sort((a, b) => a.path.localeCompare(b.path));

  if (blobRefs.length === 0) return;

  if (blobRefs.length > MAX_BLOBS_PER_COPY) {
    throw new Error(
      `Source repo has ${blobRefs.length} files; max supported in one copy is ${MAX_BLOBS_PER_COPY}. ` +
        `Copy a smaller tree or use git externally (e.g. mirror push) and sync --skip-repos for this assignment.`
    );
  }

  const concurrency = copyBlobConcurrency();

  const newTreeEntries: GitTreeBlobEntry[] = await mapPool(blobRefs, concurrency, async (item) => {
    const blob = await withRateLimitRetries(() =>
      sourceOctokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner: sourceOrg,
        repo: sourceRepo,
        file_sha: item.sha
      })
    );

    const newBlob = await withRateLimitRetries(() =>
      targetOctokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner: targetOrg,
        repo: targetRepo,
        content: blob.data.content,
        encoding: blob.data.encoding
      })
    );

    return {
      path: item.path,
      mode: item.mode,
      type: "blob" as const,
      sha: newBlob.data.sha
    };
  });

  const newTree = await withRateLimitRetries(() =>
    targetOctokit.request("POST /repos/{owner}/{repo}/git/trees", {
      owner: targetOrg,
      repo: targetRepo,
      tree: newTreeEntries as Array<{
        path?: string;
        mode?: "100644" | "100755" | "040000" | "160000" | "120000";
        type?: "blob";
        sha: string;
      }>
    })
  );

  let targetRef: { data: { object: { sha: string }; ref: string } };
  try {
    targetRef = await targetOctokit.request("GET /repos/{owner}/{repo}/git/ref/heads/main", {
      owner: targetOrg,
      repo: targetRepo
    });
  } catch {
    targetRef = await targetOctokit.request("GET /repos/{owner}/{repo}/git/ref/heads/master", {
      owner: targetOrg,
      repo: targetRepo
    });
  }

  const newCommit = await withRateLimitRetries(() =>
    targetOctokit.request("POST /repos/{owner}/{repo}/git/commits", {
      owner: targetOrg,
      repo: targetRepo,
      message: `Copy content from ${sourceRepoFullName}`,
      tree: newTree.data.sha,
      parents: [targetRef.data.object.sha]
    })
  );

  const refName = (targetRef.data as { ref?: string }).ref?.replace("refs/", "") ?? "heads/main";
  await withRateLimitRetries(() =>
    targetOctokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      owner: targetOrg,
      repo: targetRepo,
      ref: refName,
      sha: newCommit.data.sha
    })
  );
}
