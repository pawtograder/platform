/* eslint-disable no-console */
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import {
  ensureRepoOnMainAtPath,
  processInBatches,
  runGitCommand,
  runRsync,
  rsyncIndicatesTransfers
} from "../repos/git";
import type { RepoCopyPair } from "./types";

/**
 * Prefix used in the commit message we make when copying source contents into the
 * freshly-templated target repo. Matches the historical server-side marker so re-runs
 * can detect prior success and skip.
 */
export const COPY_CONTENT_COMMIT_MESSAGE_PREFIX = "Copy content from ";

export interface CopyAssignmentReposOptions {
  workDir: string;
  dryRun: boolean;
  concurrency: number;
  delayMs: number;
}

export interface CopyAssignmentReposResult {
  copied: number;
  skipped: number;
  wouldCopy: number;
  wouldSkip: number;
  errors: number;
  cloneFailures: number;
}

export interface PerPairStatus {
  pair: RepoCopyPair;
  status: "copied" | "skipped" | "would_copy" | "would_skip" | "error";
  message?: string;
}

/**
 * Build a stable per-repo working directory under `<workDir>/<org>/<repo>`.
 * Using org-scoped subdirectories avoids collisions when source and target repos
 * share the same basename across different GitHub organizations.
 */
function repoPath(workDir: string, repoFullName: string): string {
  const [org, ...rest] = repoFullName.split("/");
  const repo = rest.join("/");
  return join(workDir, org, repo);
}

function buildCommitMessage(sourceRepo: string): string {
  return `${COPY_CONTENT_COMMIT_MESSAGE_PREFIX}${sourceRepo}`;
}

async function targetAlreadyCopied(targetDir: string, sourceRepo: string): Promise<boolean> {
  const subject = await runGitCommand(["log", "-1", "--pretty=%s"], targetDir);
  if (!subject.success) return false;
  const expected = buildCommitMessage(sourceRepo);
  return subject.output.trim() === expected;
}

/**
 * Clone (or update) every unique repo referenced by the pairs in parallel batches.
 */
async function cloneAllRepos(
  pairs: RepoCopyPair[],
  workDir: string,
  concurrency: number,
  delayMs: number
): Promise<{ failures: { repo: string; message: string }[] }> {
  const unique = new Set<string>();
  for (const p of pairs) {
    unique.add(p.source_repo);
    unique.add(p.target_repo);
  }
  const repos = [...unique];

  const results = await processInBatches(
    repos,
    concurrency,
    async (repo) => {
      const dir = repoPath(workDir, repo);
      mkdirSync(join(dir, ".."), { recursive: true });
      const res = await ensureRepoOnMainAtPath(repo, dir, (name, attempt, ms) => {
        console.log(`  Retry ${attempt} for ${name} in ${ms}ms...`);
      });
      return { repo, ...res };
    },
    (done, total) => {
      process.stdout.write(`\r  Progress: ${done}/${total}`);
    },
    delayMs
  );
  console.log("");
  const failures = results.filter((r) => !r.success).map((r) => ({ repo: r.repo, message: r.message }));
  return { failures };
}

/**
 * Copy repo contents from source to target using a local `git clone` + `rsync` + `git push`.
 * Writes a single synthetic commit `"Copy content from <source>"` so subsequent runs are
 * idempotent (we skip any target whose latest commit already matches).
 */
export async function runCopyAssignmentRepos(
  pairs: RepoCopyPair[],
  opts: CopyAssignmentReposOptions
): Promise<{ result: CopyAssignmentReposResult; perPair: PerPairStatus[] }> {
  const workDir = resolve(opts.workDir);
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }

  const perPair: PerPairStatus[] = [];
  const result: CopyAssignmentReposResult = {
    copied: 0,
    skipped: 0,
    wouldCopy: 0,
    wouldSkip: 0,
    errors: 0,
    cloneFailures: 0
  };

  if (pairs.length === 0) {
    console.log("No repo pairs to copy.");
    return { result, perPair };
  }

  console.log(`\nCloning ${new Set(pairs.flatMap((p) => [p.source_repo, p.target_repo])).size} unique repos...`);
  const { failures } = await cloneAllRepos(pairs, workDir, opts.concurrency, opts.delayMs);
  if (failures.length > 0) {
    console.error("Clone/fetch failures:");
    for (const f of failures.slice(0, 20)) {
      console.error(`  ${f.repo}: ${f.message}`);
    }
    if (failures.length > 20) {
      console.error(`  ... and ${failures.length - 20} more`);
    }
    result.cloneFailures = failures.length;
    // Continue: mark pairs that reference any failed repo as errors below.
  }
  const failedRepos = new Set(failures.map((f) => f.repo));

  for (const pair of pairs) {
    const label = `${pair.kind}: ${pair.source_repo} -> ${pair.target_repo}`;

    if (failedRepos.has(pair.source_repo) || failedRepos.has(pair.target_repo)) {
      result.errors++;
      perPair.push({ pair, status: "error", message: "clone/fetch failed" });
      console.error(`[error] ${label}: clone/fetch failed`);
      continue;
    }

    const sourceDir = repoPath(workDir, pair.source_repo);
    const targetDir = repoPath(workDir, pair.target_repo);

    if (await targetAlreadyCopied(targetDir, pair.source_repo)) {
      if (opts.dryRun) {
        result.wouldSkip++;
        perPair.push({ pair, status: "would_skip", message: "already copied" });
      } else {
        result.skipped++;
        perPair.push({ pair, status: "skipped", message: "already copied" });
      }
      console.log(`[skip] ${label} (already copied)`);
      continue;
    }

    const srcPath = `${sourceDir.replace(/\/$/, "")}/`;
    const dstPath = `${targetDir.replace(/\/$/, "")}/`;

    if (opts.dryRun) {
      const previewArgs = ["-a", "--exclude=.git", "--stats", "-i", "-n", srcPath, dstPath];
      const preview = await runRsync(previewArgs);
      if (!preview.success) {
        result.errors++;
        perPair.push({ pair, status: "error", message: `rsync (dry-run): ${preview.output.trim()}` });
        console.error(`[error] ${label}: rsync (dry-run): ${preview.output.trim()}`);
        continue;
      }
      const hasTransfers = rsyncIndicatesTransfers(preview.output);
      if (hasTransfers) {
        result.wouldCopy++;
        perPair.push({ pair, status: "would_copy" });
        console.log(`[would copy] ${label}`);
      } else {
        result.wouldSkip++;
        perPair.push({ pair, status: "would_skip", message: "no transfers" });
      }
      continue;
    }

    const applyArgs = ["-a", "--exclude=.git", "--stats", srcPath, dstPath];
    const applied = await runRsync(applyArgs);
    if (!applied.success) {
      result.errors++;
      perPair.push({ pair, status: "error", message: `rsync: ${applied.output.trim()}` });
      console.error(`[error] ${label}: rsync: ${applied.output.trim()}`);
      continue;
    }

    const addResult = await runGitCommand(["add", "-A"], targetDir);
    if (!addResult.success) {
      result.errors++;
      perPair.push({ pair, status: "error", message: `git add: ${addResult.output.trim()}` });
      console.error(`[error] ${label}: git add: ${addResult.output.trim()}`);
      continue;
    }

    const diffResult = await runGitCommand(["diff", "--cached", "--quiet"], targetDir);
    if (diffResult.success) {
      // No staged changes — rsync copied files that were byte-identical (or empty source).
      result.skipped++;
      perPair.push({ pair, status: "skipped", message: "no diff after rsync" });
      console.log(`[skip] ${label} (no diff)`);
      continue;
    }

    const commitMsg = buildCommitMessage(pair.source_repo);
    const commitResult = await runGitCommand(["commit", "-m", commitMsg], targetDir);
    if (!commitResult.success) {
      result.errors++;
      perPair.push({ pair, status: "error", message: `git commit: ${commitResult.output.trim()}` });
      console.error(`[error] ${label}: git commit: ${commitResult.output.trim()}`);
      continue;
    }

    const pushResult = await runGitCommand(["push", "origin", "main"], targetDir);
    if (!pushResult.success) {
      result.errors++;
      perPair.push({ pair, status: "error", message: `git push: ${pushResult.output.trim()}` });
      console.error(`[error] ${label}: git push: ${pushResult.output.trim()}`);
      continue;
    }

    result.copied++;
    perPair.push({ pair, status: "copied" });
    console.log(`[copied] ${label}`);
  }

  console.log("\n--- Repo copy summary ---");
  if (opts.dryRun) {
    console.log(`wouldCopy: ${result.wouldCopy}`);
    console.log(`wouldSkip: ${result.wouldSkip}`);
    console.log(`errors: ${result.errors}`);
  } else {
    console.log(`copied: ${result.copied}`);
    console.log(`skipped: ${result.skipped}`);
    console.log(`errors: ${result.errors}`);
  }
  if (result.cloneFailures > 0) {
    console.log(`cloneFailures: ${result.cloneFailures}`);
  }

  return { result, perPair };
}
