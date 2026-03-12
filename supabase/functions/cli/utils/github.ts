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

  // Wait for target repo to be ready
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Get the source repo default branch tree
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

  // Get the source commit to find the tree
  const sourceCommit = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner: sourceOrg,
    repo: sourceRepo,
    commit_sha: sourceCommitSha
  });

  const sourceTreeSha = sourceCommit.data.tree.sha;

  // Get the full source tree (recursive)
  const sourceTree = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner: sourceOrg,
    repo: sourceRepo,
    tree_sha: sourceTreeSha,
    recursive: "true"
  });

  // Copy each blob from source to target
  const newTreeEntries: GitTreeBlobEntry[] = [];

  const treeItems = sourceTree.data.tree as Array<{ type?: string; sha?: string; path?: string; mode?: string }>;
  for (const item of treeItems) {
    if (item.type === "blob" && item.sha) {
      const blob = await sourceOctokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner: sourceOrg,
        repo: sourceRepo,
        file_sha: item.sha
      });

      const newBlob = await targetOctokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner: targetOrg,
        repo: targetRepo,
        content: blob.data.content,
        encoding: blob.data.encoding
      });

      newTreeEntries.push({
        path: item.path,
        mode: item.mode,
        type: "blob",
        sha: newBlob.data.sha
      });
    }
  }

  if (newTreeEntries.length === 0) return;

  const newTree = await targetOctokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner: targetOrg,
    repo: targetRepo,
    tree: newTreeEntries as Array<{
      path?: string;
      mode?: "100644" | "100755" | "040000" | "160000" | "120000";
      type?: "blob";
      sha: string;
    }>
  });

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

  const newCommit = await targetOctokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner: targetOrg,
    repo: targetRepo,
    message: `Copy content from ${sourceRepoFullName}`,
    tree: newTree.data.sha,
    parents: [targetRef.data.object.sha]
  });

  const refName = (targetRef.data as { ref?: string }).ref?.replace("refs/", "") ?? "heads/main";
  await targetOctokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner: targetOrg,
    repo: targetRepo,
    ref: refName,
    sha: newCommit.data.sha
  });
}
