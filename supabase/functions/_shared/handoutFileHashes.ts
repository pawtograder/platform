// Handout file hashing, shared because more than one flow has to record it.
//
// `assignment_handout_file_hashes` is what lets the submission paths tell "the student
// pushed nothing of their own" from "the student did work": an ingested submission is
// compared against the handout's hash for the same file set. Only the template-repo push
// webhook used to write it, which meant a handout whose hashes were never recorded made
// every unchanged starter repo look like real work — on a repo-only assignment, where every
// push is a submission, that turns an untouched clone into the student's active submission.
//
// Extracted verbatim from github-repo-webhook so assignment-create-handout-repo and
// github-repo-configure-webhook can seed the same rows.

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import micromatch from "npm:micromatch";
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno";
import { getOctoKit } from "./GitHubWrapper.ts";
import { Database } from "./SupabaseTypes.d.ts";
import { PawtograderConfig } from "./PawtograderYml.d.ts";

export function sha256Hex(buf: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(buf);
  return hash.digest("hex");
}

export function computeCombinedHashFromFileHashes(file_hashes: Record<string, string>): string {
  const combinedInput = Object.keys(file_hashes)
    .sort()
    .map((name) => `${name}\0${file_hashes[name]}\n`)
    .join("");
  return sha256Hex(Buffer.from(combinedInput, "utf-8"));
}

/** Cache key for commit+tree (templateRepo, commitSha). */
export const commitTreeCacheKey = (templateRepo: string, commitSha: string) => `${templateRepo}:${commitSha}`;

/** Cache key for blob hash (owner, repo, blobSha). */
export const blobCacheKey = (owner: string, repo: string, blobSha: string) => `${owner}:${repo}:${blobSha}`;

/** Per-webhook caches to avoid duplicate GitHub API calls across assignments sharing a template repo. */
export type HandoutHashCaches = {
  commitTree: Map<string, { treeSha: string; tree: { path?: string; sha?: string; type?: string }[] }>;
  blobHash: Map<string, string>;
};

export async function computeHandoutFileHashesForCommit(params: {
  templateRepo: string;
  commitSha: string;
  expectedFiles: string[];
  scope: Sentry.Scope;
  caches?: HandoutHashCaches;
}): Promise<{ file_hashes: Record<string, string>; combined_hash: string }> {
  const { templateRepo, commitSha, expectedFiles, scope, caches } = params;
  const octokit = await getOctoKit(templateRepo, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${templateRepo}`);
  }
  const [owner, repo] = templateRepo.split("/");

  const ctKey = commitTreeCacheKey(templateRepo, commitSha);
  let treeSha: string;
  let tree: { path?: string; sha?: string; type?: string }[];

  if (caches?.commitTree?.has(ctKey)) {
    const cached = caches.commitTree.get(ctKey)!;
    treeSha = cached.treeSha;
    tree = cached.tree;
  } else {
    const { data: commit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
      owner,
      repo,
      commit_sha: commitSha
    });
    treeSha = commit.tree.sha;

    const { data: treeData } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner,
      repo,
      tree_sha: treeSha,
      recursive: "true"
    });
    tree = treeData.tree || [];

    caches?.commitTree?.set(ctKey, { treeSha, tree });
  }

  const wantedPaths = tree
    .filter((item) => item.type === "blob" && !!item.path && !!item.sha)
    .map((item) => ({ path: item.path!, sha: item.sha! }))
    .filter(({ path }) => expectedFiles.some((pattern) => micromatch.isMatch(path, pattern)));

  const file_hashes: Record<string, string> = {};
  for (const { path, sha } of wantedPaths) {
    const bKey = blobCacheKey(owner, repo, sha);
    let hash: string | undefined = caches?.blobHash?.get(bKey);
    if (hash === undefined) {
      const { data: blob } = await octokit.request("GET /repos/{owner}/{repo}/git/blobs/{file_sha}", {
        owner,
        repo,
        file_sha: sha
      });
      if (blob.encoding !== "base64") {
        throw new Error(`Unexpected blob encoding for ${path}: ${blob.encoding}`);
      }
      const bytes = Buffer.from(blob.content, "base64");
      hash = sha256Hex(bytes);
      caches?.blobHash?.set(bKey, hash);
    }
    file_hashes[path] = hash;
  }

  const combined_hash = computeCombinedHashFromFileHashes(file_hashes);
  return { file_hashes, combined_hash };
}

/**
 * Record the handout hashes for one assignment at one commit.
 *
 * Skips silently when there is nothing to compare: no handout repo, no commit, or no
 * `submissionFiles` in the autograder config — with no globs there is no comparable file
 * set, which is also how the ingestion path decides it cannot detect emptiness.
 *
 * Returns what it did so callers can log it; never throws, because every caller is
 * completing a larger operation that must not fail over a hash row. The rows are re-derivable
 * from GitHub, and the next handout push recomputes them.
 */
/**
 * `reason` values that mean "there was nothing to seed", not "seeding failed".
 *
 * All three are steady states of a perfectly healthy assignment: no handout repository, a handout
 * that has no commit yet, or a config that declares no `submissionFiles` globs. There is no
 * comparable file set in any of them, so producing no hash rows is the correct outcome.
 *
 * Exported because the distinction is only safe to make here, next to the returns. A caller that
 * treats every `seeded: false` as a failure holds state back on assignments that were never going
 * to have hashes -- see the `latest_autograder_sha` guard in github-repo-webhook, where doing so
 * pinned the pointer on every subsequent push and reported an incident each time.
 */
export const EXPECTED_HANDOUT_SEED_SKIPS = ["no_template_repo", "no_commit_sha", "no_submission_files"] as const;

/** True when a `{ seeded: false }` result is an expected skip rather than a failure. */
export function isExpectedHandoutSeedSkip(reason: string | undefined): boolean {
  return reason !== undefined && (EXPECTED_HANDOUT_SEED_SKIPS as readonly string[]).includes(reason);
}

export async function seedHandoutFileHashes(params: {
  adminSupabase: SupabaseClient<Database>;
  assignmentId: number;
  classId: number;
  templateRepo: string | null;
  commitSha: string | null | undefined;
  scope?: Sentry.Scope;
  caches?: HandoutHashCaches;
}): Promise<{ seeded: boolean; reason?: string }> {
  const { adminSupabase, assignmentId, classId, templateRepo, commitSha, scope, caches } = params;
  if (!templateRepo) return { seeded: false, reason: "no_template_repo" };
  if (!commitSha) return { seeded: false, reason: "no_commit_sha" };
  try {
    const { data: graderConfig, error: graderConfigError } = await adminSupabase
      .from("autograder")
      .select("config")
      .eq("id", assignmentId)
      .maybeSingle();
    if (graderConfigError) throw graderConfigError;
    const pawtograderConfig = (graderConfig?.config as unknown as PawtograderConfig) || null;
    const expectedFiles = pawtograderConfig?.submissionFiles
      ? [...(pawtograderConfig.submissionFiles.files || []), ...(pawtograderConfig.submissionFiles.testFiles || [])]
      : [];
    if (expectedFiles.length === 0) return { seeded: false, reason: "no_submission_files" };

    const { file_hashes, combined_hash } = await computeHandoutFileHashesForCommit({
      templateRepo,
      commitSha,
      expectedFiles,
      scope: scope ?? new Sentry.Scope(),
      caches
    });
    const { error: upsertError } = await adminSupabase.from("assignment_handout_file_hashes").upsert(
      {
        assignment_id: assignmentId,
        sha: commitSha,
        combined_hash,
        file_hashes,
        class_id: classId
      },
      { onConflict: "assignment_id,sha" }
    );
    if (upsertError) throw upsertError;
    scope?.setTag("seeded_handout_file_hashes", commitSha);
    return { seeded: true };
  } catch (e) {
    scope?.setTag("seed_handout_file_hashes_failed", "true");
    if (scope) Sentry.captureException(e, scope);
    else Sentry.captureException(e);
    return { seeded: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
