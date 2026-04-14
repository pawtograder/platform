/* eslint-disable no-console */
import { join, resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import {
  cloneAllReposOnMain,
  getRepoDirectoryName,
  runGitCommand,
  runRsync,
  rsyncIndicatesTransfers
} from "./git";
import type { CrossAssignmentCopyContext } from "./types";

export interface CrossAssignmentCopyOptions {
  workDir: string;
  dryRun: boolean;
  mirrorDelete: boolean;
  concurrency: number;
  delayMs: number;
}

export interface CrossAssignmentCopyResult {
  copied: number;
  skipped: number;
  notYetDue: number;
  wouldCopy: number;
  wouldSkip: number;
  errors: number;
}

function buildCommitMessage(sourceRepo: string, sha: string): string {
  return `chore: sync from ${sourceRepo} @ ${sha}\n\nSource: ${sourceRepo}\nSHA: ${sha}`;
}

export async function runCrossAssignmentCopy(
  ctx: CrossAssignmentCopyContext,
  opts: CrossAssignmentCopyOptions
): Promise<CrossAssignmentCopyResult> {
  const workDir = resolve(opts.workDir);
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }

  if (ctx.errors.length > 0) {
    console.log("Context errors (from API; these repos were not paired):");
    for (const e of ctx.errors.slice(0, 30)) {
      console.log(`  ${e.source_repository}: ${e.reason}`);
    }
    if (ctx.errors.length > 30) {
      console.log(`  ... and ${ctx.errors.length - 30} more`);
    }
    console.log("");
  }

  const repoSet = new Map<string, { repository: string }>();
  for (const p of ctx.pairs) {
    repoSet.set(p.source_repository, { repository: p.source_repository });
    repoSet.set(p.target_repository, { repository: p.target_repository });
  }
  const allRepos = [...repoSet.values()];

  if (allRepos.length === 0) {
    console.log("No repository pairs to sync.");
    return { copied: 0, skipped: 0, notYetDue: 0, wouldCopy: 0, wouldSkip: 0, errors: 0 };
  }

  console.log(`\nCloning/updating ${allRepos.length} unique repos on main...`);
  const { failures } = await cloneAllReposOnMain(allRepos, workDir, opts.concurrency, opts.delayMs);
  if (failures.length > 0) {
    console.error("Clone/fetch failures:");
    for (const f of failures.slice(0, 20)) {
      console.error(`  ${f.repo}: ${f.message}`);
    }
    if (failures.length > 20) {
      console.error(`  ... and ${failures.length - 20} more`);
    }
    throw new Error(`${failures.length} clone/fetch failure(s)`);
  }

  let copied = 0;
  let skipped = 0;
  let notYetDue = 0;
  let wouldCopy = 0;
  let wouldSkip = 0;
  let errors = 0;

  for (const pair of ctx.pairs) {
    const label = pair.source_repository;
    const targetRepo = pair.target_repository;

    if (!pair.eligible_for_copy) {
      notYetDue++;
      continue;
    }

    const sourceDir = join(workDir, getRepoDirectoryName(pair.source_repository));
    const targetDir = join(workDir, getRepoDirectoryName(targetRepo));

    const shaResult = await runGitCommand(["rev-parse", "main"], sourceDir);
    if (!shaResult.success) {
      console.error(`[error] ${label}: rev-parse main: ${shaResult.output.trim()}`);
      errors++;
      continue;
    }
    const sha = shaResult.output.trim();
    const commitMsg = buildCommitMessage(pair.source_repository, sha);

    const srcPath = `${sourceDir.replace(/\/$/, "")}/`;
    const dstPath = `${targetDir.replace(/\/$/, "")}/`;

    if (opts.dryRun) {
      const previewArgs = ["-a", "--exclude=.git", "--stats", "-i", "-n"];
      if (opts.mirrorDelete) {
        previewArgs.push("--delete");
      }
      previewArgs.push(srcPath, dstPath);
      const preview = await runRsync(previewArgs);
      if (!preview.success) {
        console.error(`[error] ${label}: rsync (dry-run): ${preview.output.trim()}`);
        errors++;
        continue;
      }
      const hasTransfers = rsyncIndicatesTransfers(preview.output);
      if (hasTransfers) {
        wouldCopy++;
        console.log(`[would copy] ${label} -> ${targetRepo} (${sha.slice(0, 7)})`);
        console.log(`  message: ${commitMsg.split("\n")[0]}`);
      } else {
        wouldSkip++;
      }
      continue;
    }

    const applyArgs = ["-a", "--exclude=.git", "--stats"];
    if (opts.mirrorDelete) {
      applyArgs.push("--delete");
    }
    applyArgs.push(srcPath, dstPath);
    const applied = await runRsync(applyArgs);
    if (!applied.success) {
      console.error(`[error] ${label}: rsync: ${applied.output.trim()}`);
      errors++;
      continue;
    }

    const hasTransfers = rsyncIndicatesTransfers(applied.output);
    if (!hasTransfers) {
      skipped++;
      continue;
    }

    const addResult = await runGitCommand(["add", "-A"], targetDir);
    if (!addResult.success) {
      console.error(`[error] ${label}: git add: ${addResult.output.trim()}`);
      errors++;
      continue;
    }

    const diffResult = await runGitCommand(["diff", "--cached", "--quiet"], targetDir);
    if (diffResult.success) {
      skipped++;
      continue;
    }

    const commitResult = await runGitCommand(["commit", "-m", commitMsg], targetDir);
    if (!commitResult.success) {
      console.error(`[error] ${label}: git commit: ${commitResult.output.trim()}`);
      errors++;
      continue;
    }

    const pushResult = await runGitCommand(["push", "origin", "main"], targetDir);
    if (!pushResult.success) {
      console.error(`[error] ${label}: git push: ${pushResult.output.trim()}`);
      errors++;
      continue;
    }

    copied++;
    console.log(`[copied] ${label} -> ${targetRepo} (${sha.slice(0, 7)})`);
  }

  console.log("\n--- Summary ---");
  if (opts.dryRun) {
    console.log(`wouldCopy: ${wouldCopy}`);
    console.log(`wouldSkip: ${wouldSkip}`);
    console.log(`notYetDue: ${notYetDue}`);
    console.log(`errors: ${errors}`);
  } else {
    console.log(`copied: ${copied}`);
    console.log(`skipped: ${skipped}`);
    console.log(`notYetDue: ${notYetDue}`);
    console.log(`errors: ${errors}`);
  }

  return { copied, skipped, notYetDue, wouldCopy, wouldSkip, errors };
}
