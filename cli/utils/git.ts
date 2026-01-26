/**
 * Git utilities for the Pawtograder CLI
 *
 * Provides functions for cloning and pushing repositories using local git commands.
 * Based on patterns from scripts/CloneStudentRepos.ts
 */

import { spawn } from "child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, cpSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { logger, CLIError } from "./logger";

export interface GitResult {
  success: boolean;
  output: string;
}

/**
 * Run a git command and return the result
 */
async function runGitCommand(args: string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({
        success: code === 0,
        output: code === 0 ? stdout : stderr
      });
    });
  });
}

/**
 * Create a temporary directory for git operations
 */
export async function createTempDir(prefix: string): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  return tempDir;
}

/**
 * Clean up a temporary directory
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Copy content from source repository to target repository.
 * The target repository must already exist on GitHub (created via edge function).
 *
 * This function clones both repos, copies all files from source to target,
 * commits the changes with a descriptive message, and pushes.
 *
 * @param sourceRepo - Source repository in format "org/repo"
 * @param targetRepo - Target repository in format "org/repo"
 * @param tempDir - Temporary directory to use for the operation
 */
export async function cloneAndPushRepo(sourceRepo: string, targetRepo: string, tempDir: string): Promise<void> {
  const sourceUrl = `git@github.com:${sourceRepo}.git`;
  const targetUrl = `git@github.com:${targetRepo}.git`;
  const sourceDir = join(tempDir, "source");
  const targetDir = join(tempDir, "target");

  // Clone source repo
  logger.info(`    Cloning source from ${sourceRepo}...`);
  const cloneSourceResult = await runGitCommand(["clone", sourceUrl, sourceDir]);
  if (!cloneSourceResult.success) {
    throw new CLIError(`Failed to clone ${sourceRepo}: ${cloneSourceResult.output.trim()}`);
  }

  // Clone target repo
  logger.info(`    Cloning target from ${targetRepo}...`);
  const cloneTargetResult = await runGitCommand(["clone", targetUrl, targetDir]);
  if (!cloneTargetResult.success) {
    throw new CLIError(`Failed to clone ${targetRepo}: ${cloneTargetResult.output.trim()}`);
  }

  // Remove all files from target (except .git)
  logger.info(`    Copying files from source to target...`);
  const targetContents = readdirSync(targetDir);
  for (const item of targetContents) {
    if (item !== ".git") {
      rmSync(join(targetDir, item), { recursive: true, force: true });
    }
  }

  // Copy all files from source to target (except .git)
  const sourceContents = readdirSync(sourceDir);
  for (const item of sourceContents) {
    if (item !== ".git") {
      cpSync(join(sourceDir, item), join(targetDir, item), { recursive: true });
    }
  }

  // Stage all changes
  logger.info(`    Staging changes...`);
  const addResult = await runGitCommand(["add", "-A"], targetDir);
  if (!addResult.success) {
    throw new CLIError(`Failed to stage changes: ${addResult.output.trim()}`);
  }

  // Check if there are changes to commit
  const statusResult = await runGitCommand(["status", "--porcelain"], targetDir);
  if (!statusResult.output.trim()) {
    logger.info(`    No changes to commit (target already up to date)`);
    return;
  }

  // Commit with descriptive message
  const commitMessage = `Copy assignment content from ${sourceRepo}\n\nThis commit copies the assignment content from the source repository\nto set up this assignment for the new class.`;
  logger.info(`    Committing changes...`);
  const commitResult = await runGitCommand(["commit", "-m", commitMessage], targetDir);
  if (!commitResult.success) {
    throw new CLIError(`Failed to commit changes: ${commitResult.output.trim()}`);
  }

  // Push to remote
  logger.info(`    Pushing to ${targetRepo}...`);
  const pushResult = await runGitCommand(["push", "origin", "HEAD"], targetDir);
  if (!pushResult.success) {
    throw new CLIError(`Failed to push to ${targetRepo}: ${pushResult.output.trim()}`);
  }

  logger.info(`    Successfully synced to ${targetRepo}`);
}

/**
 * Check if a repository exists and is accessible
 */
export async function checkRepoAccess(repo: string): Promise<boolean> {
  const url = `git@github.com:${repo}.git`;

  // Use ls-remote to check if repo is accessible
  const result = await runGitCommand(["ls-remote", "--exit-code", url]);
  return result.success;
}

/**
 * Get the default branch of a repository
 */
export async function getDefaultBranch(repo: string): Promise<string | null> {
  const url = `git@github.com:${repo}.git`;

  // Get remote HEAD reference
  const result = await runGitCommand(["ls-remote", "--symref", url, "HEAD"]);
  if (!result.success) {
    return null;
  }

  // Parse output like: "ref: refs/heads/main\tHEAD"
  const match = result.output.match(/ref: refs\/heads\/(\S+)/);
  return match ? match[1] : null;
}
