/**
 * GitHub API utilities for CLI.
 *
 * Historically this module also contained a REST-based `copyRepoContentsViaGitHub`
 * that walked a source repo's tree via the GitHub Git Data API (blobs → tree →
 * commit → ref) and recreated it in a target repo. That path was removed: large
 * trees hit GitHub's recursive-tree truncation, repeatedly exceeded Supabase
 * Edge Function timeouts, and were capped at ~95k blobs.
 *
 * The content copy is now performed locally by the CLI (see
 * `cli/lib/assignments/copyAssignmentRepos.ts`) via SSH `git clone` + `rsync`
 * + `git push`. The Edge Function only creates empty target repos from GitHub
 * templates and verifies their reachability.
 */

import { getOctoKit } from "../../_shared/GitHubWrapper.ts";

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
