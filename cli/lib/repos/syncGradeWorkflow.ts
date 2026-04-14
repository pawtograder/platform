/* eslint-disable no-console */
import { dirname, join, resolve } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { GRADE_WORKFLOW_PATH } from "./constants";
import { cloneAllReposOnMain, getRepoDirectoryName, runGitCommand } from "./git";
import type { SyncGradeWorkflowContext } from "./types";

export interface SyncGradeWorkflowOptions {
  workDir: string;
  dryRun: boolean;
  concurrency: number;
  delayMs: number;
}

export interface SyncGradeWorkflowResult {
  updated: number;
  skipped: number;
  wouldUpdate: number;
  errors: number;
}

function buildCommitMessage(templateRepo: string, refSha: string): string {
  const path = GRADE_WORKFLOW_PATH;
  return `chore: sync ${path} from handout ${templateRepo} @ ${refSha}\n\nSource: ${templateRepo}\nRef: ${refSha}`;
}

export async function runSyncGradeWorkflow(
  ctx: SyncGradeWorkflowContext,
  opts: SyncGradeWorkflowOptions
): Promise<SyncGradeWorkflowResult> {
  const workDir = resolve(opts.workDir);
  if (!existsSync(workDir)) {
    mkdirSync(workDir, { recursive: true });
  }

  const canonical = Buffer.from(ctx.grade_yml_base64, "base64");
  const refSha = ctx.grade_yml_blob_sha ?? "unknown";
  const commitSubject = buildCommitMessage(ctx.template_repo, refSha);
  const studentRepos = ctx.repositories;

  if (studentRepos.length === 0) {
    return { updated: 0, skipped: 0, wouldUpdate: 0, errors: 0 };
  }

  console.log(`\nSyncing ${studentRepos.length} student repos on main...`);
  const { failures } = await cloneAllReposOnMain(studentRepos, workDir, opts.concurrency, opts.delayMs);
  if (failures.length > 0) {
    console.error("Student clone/fetch failures:");
    for (const f of failures.slice(0, 20)) {
      console.error(`  ${f.repo}: ${f.message}`);
    }
    if (failures.length > 20) {
      console.error(`  ... and ${failures.length - 20} more`);
    }
    throw new Error(`${failures.length} clone/fetch failure(s)`);
  }

  let updated = 0;
  let skipped = 0;
  let wouldUpdate = 0;
  let errors = 0;

  for (const repo of studentRepos) {
    const label = repo.repository;
    const studentDir = join(workDir, getRepoDirectoryName(repo.repository));
    const studentGradePath = join(studentDir, GRADE_WORKFLOW_PATH);

    const matches = existsSync(studentGradePath) && readFileSync(studentGradePath).equals(canonical);

    if (matches) {
      skipped++;
      continue;
    }

    if (opts.dryRun) {
      wouldUpdate++;
      const reason = !existsSync(studentGradePath) ? "missing file" : "content differs";
      console.log(`[would update] ${label} (${reason})`);
      console.log(`  commit: ${commitSubject.split("\n")[0]}`);
      continue;
    }

    try {
      mkdirSync(dirname(studentGradePath), { recursive: true });
      writeFileSync(studentGradePath, canonical);
    } catch (e) {
      console.error(`[error] ${label}: write ${GRADE_WORKFLOW_PATH}: ${e}`);
      errors++;
      continue;
    }

    const addResult = await runGitCommand(["add", GRADE_WORKFLOW_PATH], studentDir);
    if (!addResult.success) {
      console.error(`[error] ${label}: git add: ${addResult.output.trim()}`);
      errors++;
      continue;
    }

    const diffResult = await runGitCommand(["diff", "--cached", "--quiet"], studentDir);
    if (diffResult.success) {
      skipped++;
      continue;
    }

    const commitResult = await runGitCommand(["commit", "-m", commitSubject], studentDir);
    if (!commitResult.success) {
      console.error(`[error] ${label}: git commit: ${commitResult.output.trim()}`);
      errors++;
      continue;
    }

    const pushResult = await runGitCommand(["push", "origin", "main"], studentDir);
    if (!pushResult.success) {
      console.error(`[error] ${label}: git push: ${pushResult.output.trim()}`);
      errors++;
      continue;
    }

    updated++;
    console.log(`[updated] ${label}`);
  }

  console.log("\n--- Summary ---");
  if (opts.dryRun) {
    console.log(`wouldUpdate: ${wouldUpdate}`);
    console.log(`skipped (already match): ${skipped}`);
    console.log(`errors: ${errors}`);
  } else {
    console.log(`updated: ${updated}`);
    console.log(`skipped: ${skipped}`);
    console.log(`errors: ${errors}`);
  }

  return { updated, skipped, wouldUpdate, errors };
}
