/* eslint-disable no-console */
/**
 * Demo repo content sync.
 *
 * Demo provisioning lets pawtograder's normal async workflow OWN every repo
 * creation: `assignment-create-handout-repo` and `assignment-create-solution-repo`
 * make empty repos from the platform's default templates, and the
 * `check_assignment_for_repo_creation` trigger fans out per-student repos when
 * release_date flips past. This module only deals with *content*: we clone the
 * platform-created target, overlay the canned source files on top, commit as a
 * regular commit, push (no force). Git history stays clean: template commit ←
 * "Demo content" commit.
 *
 * Requires:
 *   • `gh` CLI logged in with `repo` scope. Read on the source class repos, write
 *     on the demo org repos. (`gh auth setup-git` once on this machine for the
 *     https credential helper.)
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface OverlayResult {
  targetFullName: string;
  /** HEAD sha after the overlay push (the new commit, or the pre-existing HEAD when there was nothing to commit). */
  headSha: string;
  /** True when the overlay added no changes — file contents already matched. */
  noChanges: boolean;
  /** True when the commit came from `fallbackFiles` because the source overlay was empty. */
  usedFallback?: boolean;
}

async function run(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean } = {}): Promise<string> {
  if (!opts.quiet) console.log(`  $ ${cmd} ${args.join(" ")}`);
  const { stdout } = await execFileAsync(cmd, args, { cwd: opts.cwd, maxBuffer: 100 * 1024 * 1024 });
  return stdout;
}

async function repoExists(fullName: string): Promise<boolean> {
  try {
    await execFileAsync("gh", ["repo", "view", fullName, "--json", "name"]);
    return true;
  } catch {
    return false;
  }
}

export interface MirrorToOrgResult {
  /** `owner/repo` of the copy in the target org. */
  target: string;
  /** True if we created+mirrored it this run; false if it already existed. */
  created: boolean;
}

/**
 * Init-time helper: ensure a full mirror of `sourceFullName` exists in `targetOrg`,
 * creating it private if missing. Idempotent — if the deterministic target name
 * already exists, returns it untouched. Uses `git clone --mirror` + `git push
 * --mirror` so ALL refs and commit SHAs are preserved (the manifest references
 * specific submission SHAs, so a shallow/HEAD-only copy wouldn't resolve them).
 *
 * The target is created `--private`; within a locked-down org (base permission
 * "no access") that makes it visible to org admins + the creator only, which is
 * the "private to admins" requirement. The name is the source `owner/repo`
 * flattened to `owner-repo` so copies from different source orgs never collide.
 */
export async function mirrorRepoToOrgIfMissing(
  sourceFullName: string,
  targetOrg: string,
  opts: { private?: boolean } = {}
): Promise<MirrorToOrgResult> {
  const flattened = sourceFullName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-");
  const target = `${targetOrg}/${flattened}`;
  if (await repoExists(target)) return { target, created: false };

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pawtograder-demo-srcmirror-"));
  const mirrorDir = path.join(tempRoot, "mirror.git");
  try {
    await run("git", ["clone", "--mirror", `https://github.com/${sourceFullName}.git`, mirrorDir]);
    const visibility = opts.private === false ? "--public" : "--private";
    await run("gh", ["repo", "create", target, visibility, "--description", `Demo source mirror of ${sourceFullName}`]);
    // NOT `git push --mirror`: a --mirror clone also fetches GitHub's hidden
    // PR refs (refs/pull/*), which the remote rejects ("deny updating a hidden
    // ref") and which makes the whole mirror push fail even though branches
    // pushed fine. Push only branches + tags explicitly, which is all a content
    // mirror needs (commit SHAs are preserved via the branch tips).
    await run(
      "git",
      ["push", `https://github.com/${target}.git`, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
      { cwd: mirrorDir }
    );
    return { target, created: true };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Wait for the platform's async workflow to materialize a repo on GitHub.
 * Returns true once it's visible. Throws after timeoutMs.
 */
export async function waitForRepo(fullName: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000; // 5 min
  const pollMs = opts.pollMs ?? 5_000;
  const start = Date.now();
  while (true) {
    if (await repoExists(fullName)) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out (${timeoutMs}ms) waiting for ${fullName} to appear on GitHub`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Recursively copy every entry from `srcDir` into `destDir`, overwriting on
 * collision. Skips `.git` so the destination's git metadata is preserved.
 */
function overlayDirectory(srcDir: string, destDir: string, rootDir: string = srcDir): void {
  const rootPrefix = path.resolve(rootDir) + path.sep;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      overlayDirectory(srcPath, destPath, rootDir);
    } else if (entry.isSymbolicLink()) {
      // Resolve and copy as a regular file — symlinks don't make sense in the demo target.
      const real = fs.readlinkSync(srcPath);
      const resolved = path.resolve(path.dirname(srcPath), real);
      // Only follow links that stay inside the source repo; a link escaping
      // rootDir (e.g. ../../etc/passwd) would otherwise copy an arbitrary host
      // file into the demo repo. Skip (don't copy) anything that points outside.
      if (resolved.startsWith(rootPrefix) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        fs.copyFileSync(resolved, destPath);
      } else if (!resolved.startsWith(rootPrefix)) {
        console.warn(`Skipping symlink escaping source repo: ${srcPath} -> ${resolved}`);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Clone `targetFullName`, overlay the contents of `sourceFullName` (excluding
 * `.git`) onto it, then commit + push the result. The platform must have already
 * created `targetFullName` (via the normal `assignment-create-handout-repo` /
 * `assignment-create-all-repos` flow).
 *
 * `sourceCommitOffsetFromHead` lets multiple students each get a different
 * historical commit from the same source repo: 0=HEAD, 1=HEAD~1, etc. The
 * offset is clamped to the source's actual history length, so callers asking
 * for offset 2 on a 1-commit repo still get a valid checkout. The resulting
 * target commit is dated to match the source commit's authored timestamp so
 * the demo timeline reads as three separate students working at different
 * times.
 *
 * Safe to call concurrently against different (source, target) pairs.
 */
export async function pushSourceContent(
  // null/empty → no source repo to overlay; rely entirely on fallbackFiles. Used
  // for group assignments where no canned student submission was captured.
  sourceFullName: string | null,
  targetFullName: string,
  opts: {
    commitMessage?: string;
    authorName?: string;
    authorEmail?: string;
    /** Polling timeout while waiting for the platform to create the target repo. */
    waitForTargetTimeoutMs?: number;
    /** 0=HEAD, 1=HEAD~1, … Clamped to the source's real history length. */
    sourceCommitOffsetFromHead?: number;
    /** Exact source commit to check out (full or short sha, tag, or branch). When
     * set, takes precedence over `sourceCommitOffsetFromHead`. Demo provisioning
     * uses this to push the specific sha jon-bell submitted in class 500, so the
     * platform's autograder produces matching scores on its own. */
    sourceRef?: string;
    /** Files to write into the target if (and only if) overlaying the source
     * produced no changes — i.e. the source had no files, or its tree already
     * matched the handout. Without this, an empty submission results (and is
     * rejected when permit_empty_submissions=false). Each entry's `content` is
     * written verbatim at `path` (relative to repo root). */
    fallbackFiles?: Array<{ path: string; content: string }>;
  } = {}
): Promise<OverlayResult> {
  const commitMessage = opts.commitMessage ?? `Demo content overlay from ${sourceFullName ?? "fallback files"}`;
  const authorName = opts.authorName ?? "Pawtograder Demo";
  const authorEmail = opts.authorEmail ?? "demo@pawtograder.net";
  const requestedOffset = Math.max(0, opts.sourceCommitOffsetFromHead ?? 0);

  await waitForRepo(targetFullName, { timeoutMs: opts.waitForTargetTimeoutMs });

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pawtograder-demo-overlay-"));
  const targetDir = path.join(tempRoot, "target");
  const sourceDir = path.join(tempRoot, "source");
  try {
    await run("git", ["clone", `https://github.com/${targetFullName}.git`, targetDir]);

    let sourceDate = "";
    let sourceSha = "";
    let actualOffset = requestedOffset;

    if (sourceFullName) {
      // Full clone (no --depth) so we can checkout HEAD~N for any N up to the source's history length.
      await run("git", ["clone", `https://github.com/${sourceFullName}.git`, sourceDir]);

      let checkoutLabel = "HEAD";
      if (opts.sourceRef) {
        try {
          await run("git", ["checkout", "--detach", opts.sourceRef], { cwd: sourceDir, quiet: true });
          checkoutLabel = opts.sourceRef;
        } catch (e) {
          // Fall back to HEAD if the ref isn't reachable (e.g. wrong sha).
          console.warn(
            `  ⚠ sourceRef ${opts.sourceRef} not checkoutable; falling back to HEAD: ${(e as Error).message}`
          );
        }
      } else if (requestedOffset > 0) {
        const totalRaw = await run("git", ["rev-list", "--count", "HEAD"], { cwd: sourceDir, quiet: true });
        const total = parseInt(totalRaw.trim(), 10);
        actualOffset = !Number.isFinite(total) || total <= 0 ? 0 : Math.min(requestedOffset, total - 1);
        if (actualOffset > 0) {
          await run("git", ["checkout", `HEAD~${actualOffset}`], { cwd: sourceDir, quiet: true });
          checkoutLabel = `HEAD~${actualOffset}`;
        }
      }
      void checkoutLabel;

      // Capture the original commit's authored date so the demo target commit gets
      // the same timestamp instead of "now". This is the one thing that makes the
      // three fleet members look like distinct students who pushed on different days.
      sourceDate = (await run("git", ["log", "-1", "--format=%aI"], { cwd: sourceDir, quiet: true })).trim();
      sourceSha = (await run("git", ["rev-parse", "HEAD"], { cwd: sourceDir, quiet: true })).trim();

      overlayDirectory(sourceDir, targetDir);
    }

    const isDirty = async (): Promise<boolean> => {
      await run("git", ["add", "-A"], { cwd: targetDir, quiet: true });
      try {
        await execFileAsync("git", ["diff", "--cached", "--quiet"], { cwd: targetDir });
        return false;
      } catch {
        return true;
      }
    };

    let dirty = await isDirty();
    let usedFallback = false;
    if (!dirty && opts.fallbackFiles && opts.fallbackFiles.length > 0) {
      // The source contributed nothing new (empty submission, or tree identical to
      // the handout). Write the caller's stub files so the submission isn't empty.
      console.warn(
        `  ⚠ ${sourceFullName ?? "(no source)"} produced no changes for ${targetFullName}; writing ${opts.fallbackFiles.length} fallback file(s)`
      );
      for (const f of opts.fallbackFiles) {
        const dest = path.join(targetDir, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.content);
      }
      dirty = await isDirty();
      usedFallback = dirty;
    }
    if (!dirty) {
      const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: targetDir, quiet: true })).trim();
      return { targetFullName, headSha: sha, noChanges: true };
    }
    const provenance = sourceFullName
      ? `From ${sourceFullName}@${sourceSha.slice(0, 7)} (offset ${actualOffset} from HEAD)`
      : usedFallback
        ? `Fallback stub files (no canned source submission available)`
        : "";
    const messageWithProvenance = provenance ? `${commitMessage}\n\n${provenance}` : commitMessage;
    const commitArgs = [
      "-c",
      `user.name=${authorName}`,
      "-c",
      `user.email=${authorEmail}`,
      "commit",
      "-m",
      messageWithProvenance,
      "--no-gpg-sign"
    ];
    if (sourceDate) commitArgs.push(`--date=${sourceDate}`);
    await execFileAsync("git", commitArgs, {
      cwd: targetDir,
      env: {
        ...process.env,
        ...(sourceDate ? { GIT_AUTHOR_DATE: sourceDate, GIT_COMMITTER_DATE: sourceDate } : {})
      },
      maxBuffer: 100 * 1024 * 1024
    });

    // The caller is expected to have polled for `repositories.is_github_ready=true`
    // before invoking us, which means the platform has finished its initial setup
    // pushes — so a single `git push` should normally succeed without rebase.
    // We keep a single rebase retry as a safety net (e.g. the autograder workflow
    // racing in with a tag/commit), and log loudly when it fires so it's visible.
    // Each rebase changes our overlay commit's sha and shows up as a phantom
    // workflow run on the previously-attempted sha, so the goal is to never need
    // this branch.
    const MAX_PUSH_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_PUSH_ATTEMPTS; attempt++) {
      try {
        await run("git", ["push"], { cwd: targetDir });
        break;
      } catch (e) {
        const msg = (e as Error).message;
        const isRejection = msg.includes("[rejected]") || msg.includes("fetch first");
        if (!isRejection || attempt === MAX_PUSH_ATTEMPTS) throw e;
        console.warn(
          `  ⚠ push rejected on ${targetFullName} (attempt ${attempt}/${MAX_PUSH_ATTEMPTS}); pull-rebasing`
        );
        try {
          await run("git", ["pull", "--rebase", "-X", "theirs", "origin"], { cwd: targetDir });
        } catch (rebaseErr) {
          // Rebase failed irrecoverably (rare with -X theirs). Bail out cleanly.
          try {
            await run("git", ["rebase", "--abort"], { cwd: targetDir, quiet: true });
          } catch {
            /* nothing to abort */
          }
          throw new Error(`pull-rebase failed on ${targetFullName}: ${(rebaseErr as Error).message}`);
        }
      }
    }

    const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: targetDir, quiet: true })).trim();
    return { targetFullName, headSha: sha, noChanges: false, usedFallback };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * Run async tasks with a bounded concurrency. Preserves task order in the result.
 */
export async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}
