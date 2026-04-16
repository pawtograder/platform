/* eslint-disable no-console */
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

const INITIAL_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 30000;
const MAX_RETRIES = 4;

export function getCloneUrl(repository: string): string {
  return `git@github.com:${repository}.git`;
}

export function getRepoDirectoryName(repository: string): string {
  const parts = repository.split("/");
  return parts[parts.length - 1];
}

export async function runGitCommand(args: string[], cwd?: string): Promise<{ success: boolean; output: string }> {
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
        output: code === 0 ? stdout : stderr || stdout
      });
    });
  });
}

export async function runRsync(args: string[]): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn("rsync", args, { stdio: ["pipe", "pipe", "pipe"] });
    let combined = "";
    proc.stdout.on("data", (d) => {
      combined += d.toString();
    });
    proc.stderr.on("data", (d) => {
      combined += d.toString();
    });
    proc.on("close", (code) => {
      resolve({ success: code === 0, output: combined });
    });
  });
}

export function rsyncIndicatesTransfers(output: string): boolean {
  const m = output.match(/Number of regular files transferred:\s*(\d+)/);
  if (m) {
    return parseInt(m[1], 10) > 0;
  }
  const m2 = output.match(/Number of files transferred:\s*(\d+)/);
  if (m2) {
    return parseInt(m2[1], 10) > 0;
  }
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  const itemized = lines.filter((l) => /^[><]f|^[*]deleting|^\.f/.test(l));
  return itemized.length > 0;
}

function isConnectionResetError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("connection reset") ||
    lower.includes("kex_exchange_identification") ||
    lower.includes("connection refused") ||
    lower.includes("timed out") ||
    lower.includes("econnreset")
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Clone or update a GitHub repo (SSH) to repoDir on branch main.
 */
export async function ensureRepoOnMainAtPath(
  repository: string,
  repoDir: string,
  onRetry?: (repository: string, attempt: number, delayMs: number) => void
): Promise<{ success: boolean; message: string }> {
  const cloneUrl = getCloneUrl(repository);
  const existedBefore = existsSync(repoDir);

  const tryOnce = async (): Promise<{ success: boolean; message: string }> => {
    if (!existsSync(repoDir)) {
      let r = await runGitCommand(["clone", "-b", "main", "--single-branch", "--depth", "1", cloneUrl, repoDir]);
      if (r.success) {
        return { success: true, message: "cloned" };
      }
      r = await runGitCommand(["clone", cloneUrl, repoDir]);
      if (!r.success) {
        return { success: false, message: r.output.trim() || "clone failed" };
      }
      const co = await runGitCommand(["checkout", "main"], repoDir);
      if (!co.success) {
        return { success: false, message: `checkout main failed: ${co.output.trim()}` };
      }
      return { success: true, message: "cloned" };
    }

    const fetchResult = await runGitCommand(["fetch", "--all"], repoDir);
    if (!fetchResult.success) {
      return { success: false, message: `fetch failed: ${fetchResult.output.trim()}` };
    }

    let co = await runGitCommand(["checkout", "main"], repoDir);
    if (!co.success) {
      co = await runGitCommand(["checkout", "-B", "main", "origin/main"], repoDir);
      if (!co.success) {
        return { success: false, message: `checkout main failed: ${co.output.trim()}` };
      }
    }

    const pullResult = await runGitCommand(["pull", "--ff-only", "origin", "main"], repoDir);
    if (!pullResult.success) {
      return { success: false, message: `pull --ff-only failed: ${pullResult.output.trim()}` };
    }
    return { success: true, message: "updated" };
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await tryOnce();
    if (result.success) {
      return result;
    }
    if (!isConnectionResetError(result.message) || attempt === MAX_RETRIES) {
      return result;
    }
    const baseDelay = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
    const delayMs = Math.round(baseDelay + Math.random() * 1000);
    if (onRetry) {
      onRetry(repository, attempt + 1, delayMs);
    }
    if (!existedBefore && existsSync(repoDir)) {
      try {
        rmSync(repoDir, { recursive: true });
      } catch {
        // ignore
      }
    }
    await sleep(delayMs);
  }
  return { success: false, message: "max retries" };
}

export async function processInBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R>,
  onProgress?: (completed: number, total: number) => void,
  delayBetweenBatchesMs = 0
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
    if (onProgress) {
      onProgress(Math.min(i + batchSize, items.length), items.length);
    }
    if (delayBetweenBatchesMs > 0 && i + batchSize < items.length) {
      await sleep(delayBetweenBatchesMs);
    }
  }
  return results;
}

export interface RepoRef {
  repository: string;
}

export async function cloneAllReposOnMain(
  repos: RepoRef[],
  workDir: string,
  concurrency: number,
  delayMs: number
): Promise<{ failures: { repo: string; message: string }[] }> {
  const results = await processInBatches(
    repos,
    concurrency,
    async (repo) => {
      const repoDir = join(workDir, getRepoDirectoryName(repo.repository));
      const res = await ensureRepoOnMainAtPath(repo.repository, repoDir, (name, attempt, ms) => {
        console.log(`  Retry ${attempt} for ${name} in ${ms}ms...`);
      });
      return { repo: repo.repository, ...res };
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
