/**
 * The git handout-sync engine (docs/handout-sync-git-worker.md §5).
 *
 * Moves a student repo from handout revision `F` to `H` by building one commit on top of the
 * student's baseline `S`, with git doing every byte of file I/O. JavaScript sees paths, modes and
 * object ids, never file content, so the size of a handout bounds disk and not heap. That is the
 * point of the rewrite: on 2026-10-26 a ~30 MB, 27-file sync of `neu-cs5004/fa26-handout-hw-img1`
 * OOMed the 256 MB edge isolate on every attempt (§1).
 *
 * The student-work policy is not reimplemented here. Classification runs the primitives of
 * `syncConflictGuard.ts` (`classifyStudentFile`, `findBlockingAncestor`, `decideFileAction`) in
 * the same order `findStudentModifiedFiles` does, over complete local tree listings instead of
 * GitHub's possibly truncated ones.
 *
 * Standalone by design: no REST, Supabase, Redis or Sentry. Everything that needs GitHub's API
 * (the branch-safety compare, PRs, merges) is injected or left to the caller (WP3), and every git
 * child goes through `runGit()`.
 *
 * Layout per job (§5): a bare repo under `jobsDir` whose `objects/info/alternates` points at the
 * template's cache, so template objects are read in place and never copied. No working tree is
 * ever written. The job directory is removed when `withSyncJob` returns or throws.
 */
import {
  classifyStudentFile,
  type ChangedFileShape,
  decideFileAction,
  type FileAction,
  findBlockingAncestor,
  type TreeEntry,
  type UnresolvedReason
} from "../syncConflictGuard.ts";
import { GitSyncError, GitSyncTerminalError, GitUnfetchableError, InvalidSyncInputError } from "./errors.ts";
import {
  decodePath,
  escapePath,
  parseCommitHeader,
  parseDiffTreeRaw,
  parseLsTree,
  parseNumstatBinary,
  type RawDiffRecord
} from "./gitOutput.ts";
import {
  type GitContext,
  type GitIdentity,
  type GitLogger,
  type GitTestHooks,
  type RemoteConfig,
  runGit,
  runGitChecked
} from "./runGit.ts";
import type { TemplateCache } from "./templateCache.ts";
import { EMPTY_TREE_SHA, validateLocalPath, validateRepoFullName, validateSha } from "./validate.ts";

// ---------------------------------------------------------------------------------------------
// Inputs, context and results
// ---------------------------------------------------------------------------------------------

/** The spec §4 inputs, as the handler has them. */
export interface SyncInput {
  /** `T`: the handout repo, `owner/repo`. */
  templateRepo: string;
  /** `F`: handout revision the repo was last synced to, or null when the row records none. */
  fromSha: string | null;
  /** `H`: target handout revision. */
  toSha: string;
  /** `S`: student commit at the last sync, or null to use the current head of `main`, once. */
  syncedRepoSha: string | null;
  /** `R`: the student repo, `owner/repo`. */
  repoFullName: string;
}

/** Phase boundaries, for logs and for the crash-convergence tests (§6.1). */
export type SyncPhase = "fetch" | "classify" | "tree" | "commit" | "push";

/** One structured engine event. Never carries file content or credentials. */
export type EngineEvent = { msg: string } & Record<string, unknown>;
export type EngineLogger = (event: EngineEvent) => void;

export interface SyncJobContext {
  /** Identifies the job in its directory name and logs. The queue message id in production. */
  jobId: string;
  /** Parent of per-job bare repos (`/work/jobs`). */
  jobsDir: string;
  /** The pod's template cache. One instance per process, so its mutex is process-wide. */
  templateCache: TemplateCache;
  /** Defaults to GitHub over https. Tests pass `file://` remotes (§9.1). */
  remote?: RemoteConfig;
  /** Installation token for this job (§8.2). */
  token?: string;
  /** Fires at the job deadline and kills the running git child (§3.1). */
  signal?: AbortSignal;
  /** Author and committer of the sync commit (§5.7). */
  identity: GitIdentity;
  /** `HANDOUT_SYNC_MAX_MERGE_BYTES` (§5.5). Defaults to `DEFAULT_MAX_MERGE_BYTES`. */
  maxMergeBytes?: number;
  /** Engine events. Defaults to one JSON line per event on stdout. */
  log?: EngineLogger;
  /** Per-git-call log, passed to `runGit`. */
  gitLog?: GitLogger;
  testOnly?: {
    git?: GitTestHooks;
    /**
     * Runs after each phase completes, with the job's bare repo. Throwing here simulates a crash
     * at that boundary.
     */
    afterPhase?: (phase: SyncPhase, jobGitDir: string) => void | Promise<void>;
  };
}

/** 8 MiB. Above this, a blob is never handed to `merge-file` (§5.5). */
export const DEFAULT_MAX_MERGE_BYTES = 8 * 1024 * 1024;

/**
 * One path the handout diff touches, in the shape the guard reads (§5.3), plus the object ids
 * and modes git reported. Modes and oids are null on the side where the path is absent.
 */
export interface HandoutChange {
  path: string;
  status: "added" | "modified" | "removed";
  /** What `diff-tree` said, before the mapping to `status`. */
  gitStatus: "A" | "M" | "D" | "T";
  isBinary: boolean;
  hasPatch: boolean;
  /** Always false: git reports a deletion as `D`, never as a `+0,0` modify (§5.3). */
  patchDeletesFile: false;
  oldMode: string | null;
  newMode: string | null;
  oldOid: string | null;
  newOid: string | null;
}

/** A changed path with the guard's verdict and the action it implies. */
export interface ClassifiedFile {
  change: HandoutChange;
  /** Undefined when the path is not the student's (the guard's "unmodified"). */
  reason: UnresolvedReason | undefined;
  action: FileAction;
}

/**
 * Tags for the caller's Sentry scope and metrics. Each is set only when it applies, with the
 * value "true" unless noted.
 *
 * - `sync_from_sha_unfetchable`: `F` could not be fetched; the old-handout side is the empty tree.
 * - `sync_without_handout_history`: `F` was null (today's tag for the same situation).
 * - `sync_baseline_from_head`: `S` was null and the head of main stood in for it.
 * - `sync_baseline_unreachable`: `S` could not be fetched and the head of main stood in for it.
 * - `template_cache_stale_locks`: the number of stale lock files removed before fetching.
 * - `gitlinks_dropped`: the number of submodule entries left out of the diff.
 */
export type SyncTags = Record<string, string>;

/** Everything §5.1–§5.4 established about one sync, before any object is written. */
export interface SyncAnalysis {
  input: SyncInput;
  /** The `S` actually used: the input, or the head of main when it was null or unreachable. */
  baselineSha: string;
  /** The head of the student's `main` when it was fetched. */
  mainSha: string;
  /** `F`'s tree, or the empty tree when `F` is null or unfetchable. */
  handoutBeforeTree: string;
  handoutTree: string;
  /** `H`'s committer date, `<unix seconds> <+|-HHMM>`. The sync commit's date (§5.7). */
  handoutCommitDate: string;
  /** Every handout change in diff order, classified. Empty means no changes. */
  files: ClassifiedFile[];
  /** The paths the handout deletes, which the ancestor check exempts. */
  removedPaths: ReadonlySet<string>;
  tags: SyncTags;
}

/**
 * `H` could not be fetched from the template. Retryable: GitHub may simply not have it yet, or be
 * failing. The caller makes it terminal `handout_revision_missing` once `retry_count` reaches 5
 * (§5.1), since only the caller knows the count.
 */
export class HandoutRevisionUnfetchableError extends GitUnfetchableError {
  constructor(
    readonly templateRepo: string,
    readonly sha: string
  ) {
    super(`handout revision ${sha} is not fetchable from ${templateRepo}`);
    this.name = "HandoutRevisionUnfetchableError";
  }
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The local ref the student's `main` is fetched into. */
const STUDENT_MAIN_REF = "refs/remotes/student/main";

/** A sync job: one bare repo, used for one sync and then removed. */
export interface SyncJob {
  /** Absolute path of the job's bare repo. */
  readonly gitDir: string;
  /** §5.1–§5.4: fetch, diff and classify. Writes no object and pushes nothing. */
  analyze(input: SyncInput): Promise<SyncAnalysis>;
  /**
   * §6.3: classifies `paths` with the student's current `main` (fetched in `analyze`) as the
   * student side and `H` as the handout side, exactly as `blockedByStudentChanges` calls
   * `findStudentModifiedFiles(head, H, paths, removedPaths)` today. An empty map means every path
   * already holds the handout's content.
   */
  classifyPathsAgainstHead(
    analysis: SyncAnalysis,
    paths: readonly string[]
  ): Promise<{ headSha: string; stillDiffering: Map<string, UnresolvedReason> }>;
}

/**
 * Creates a job repo, runs `fn` with it, and removes the job directory however `fn` ends.
 *
 * A callback rather than separate plan and push functions because the push (§5.8) sends objects
 * that only exist in the job repo, and the blocked recheck (§6.3) reads the `main` this job
 * fetched. Both have to run before the directory goes.
 */
export async function withSyncJob<T>(ctx: SyncJobContext, fn: (job: SyncJob) => Promise<T>): Promise<T> {
  if (typeof ctx.jobId !== "string" || !JOB_ID_RE.test(ctx.jobId)) {
    throw new InvalidSyncInputError("job id", ctx.jobId, "must be 1-64 of [A-Za-z0-9_-]");
  }
  const jobsDir = validateLocalPath(ctx.jobsDir, "jobs dir");
  // A random suffix, so a redelivered message that overlaps a still-running attempt in the same
  // process gets its own directory instead of deleting the other attempt's.
  const gitDir = `${jobsDir}/${ctx.jobId}.${crypto.randomUUID().slice(0, 8)}.git`;
  const releases: Array<() => void> = [];
  await Deno.mkdir(gitDir, { recursive: true });
  try {
    const git: GitContext = {
      home: gitDir,
      token: ctx.token,
      signal: ctx.signal,
      remote: ctx.remote,
      log: ctx.gitLog,
      testOnly: ctx.testOnly?.git
    };
    await runGitChecked({ op: "init", gitDir }, git);
    const job = new Job(ctx, gitDir, git, releases);
    try {
      return await fn(job);
    } catch (e) {
      // §7: on ENOSPC, free the space the next attempt needs. Caches in use by a running job
      // are kept; everything else is re-fetchable.
      if (e instanceof GitSyncError && e.kind === "disk_full") {
        for (const release of releases.splice(0)) release();
        const evicted = await ctx.templateCache.evictAllIdle().catch(() => []);
        (ctx.log ?? defaultLog)({ msg: "template cache evicted after ENOSPC", job: ctx.jobId, evicted });
      }
      throw e;
    }
  } finally {
    for (const release of releases) release();
    await Deno.remove(gitDir, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
  }
}

/**
 * Removes job directories left behind by a process that died mid-job. Run once at worker
 * startup, before any job starts: the emptyDir outlives a container restart, so an OOM-killed
 * worker would otherwise leak a job repo per crash.
 */
export async function sweepStaleJobDirs(jobsDir: string): Promise<string[]> {
  validateLocalPath(jobsDir, "jobs dir");
  const removed: string[] = [];
  try {
    for await (const entry of Deno.readDir(jobsDir)) {
      if (!entry.isDirectory || !entry.name.endsWith(".git")) continue;
      await Deno.remove(`${jobsDir}/${entry.name}`, { recursive: true });
      removed.push(entry.name);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return removed;
}

function defaultLog(event: EngineEvent): void {
  console.log(JSON.stringify(event));
}

class Job implements SyncJob {
  #analyzed = false;
  #log: EngineLogger;

  constructor(
    private readonly ctx: SyncJobContext,
    readonly gitDir: string,
    private readonly git: GitContext,
    private readonly releases: Array<() => void>
  ) {
    this.#log = ctx.log ?? defaultLog;
  }

  async #phaseDone(phase: SyncPhase): Promise<void> {
    this.#log({ msg: "handout sync phase", job: this.ctx.jobId, phase });
    await this.ctx.testOnly?.afterPhase?.(phase, this.gitDir);
  }

  async analyze(input: SyncInput): Promise<SyncAnalysis> {
    if (this.#analyzed) throw new Error("a SyncJob analyzes exactly one sync");
    this.#analyzed = true;
    const templateRepo = validateRepoFullName(input.templateRepo, "template repo");
    const repo = validateRepoFullName(input.repoFullName, "repository");
    const toSha = validateSha(input.toSha, "to sha");
    const fromSha = input.fromSha === null ? null : validateSha(input.fromSha, "from sha");
    const syncedRepoSha = input.syncedRepoSha === null ? null : validateSha(input.syncedRepoSha, "synced repo sha");
    const tags: SyncTags = {};

    // §5.1: the handout, through the cache.
    const cache = this.ctx.templateCache;
    this.releases.push(cache.acquire(templateRepo));
    const wanted = fromSha ? [toSha, fromSha] : [toSha];
    const { outcomes, staleLocksRemoved } = await cache.ensureCommits(templateRepo, wanted, this.git);
    if (staleLocksRemoved.length > 0) {
      tags.template_cache_stale_locks = String(staleLocksRemoved.length);
      this.#log({ msg: "removed stale template cache locks", templateRepo, locks: staleLocksRemoved });
    }
    if (outcomes.get(toSha) === "unfetchable") throw new HandoutRevisionUnfetchableError(templateRepo, toSha);
    let handoutBeforeCommit: string | null = fromSha;
    if (fromSha === null) {
      tags.sync_without_handout_history = "true";
    } else if (outcomes.get(fromSha) === "unfetchable") {
      // History rewritten and the old revision garbage-collected. The empty tree claims nothing
      // at any path, so every path the student holds classifies as theirs: today's
      // `fromSha = null` semantics, failing in the safe direction.
      handoutBeforeCommit = null;
      tags.sync_from_sha_unfetchable = "true";
    }
    await Deno.mkdir(`${this.gitDir}/objects/info`, { recursive: true });
    await Deno.writeTextFile(`${this.gitDir}/objects/info/alternates`, `${cache.dirFor(templateRepo)}/objects\n`);

    // §5.2: the student repo. `main` first: it is the fallback baseline, the push's exclusion
    // set and the blocked recheck's head, and a repo without it is terminal before anything
    // else is asked of it.
    const mainSha = await this.#fetchStudentMain(repo);
    let baselineSha: string;
    if (syncedRepoSha === null) {
      baselineSha = mainSha;
      tags.sync_baseline_from_head = "true";
    } else if (await this.#hasCommit(syncedRepoSha)) {
      baselineSha = syncedRepoSha;
    } else {
      try {
        await runGitChecked(
          { op: "fetch", gitDir: this.gitDir, repo, target: { kind: "sha", sha: syncedRepoSha }, depth: 1 },
          this.git
        );
        baselineSha = syncedRepoSha;
      } catch (e) {
        if (!(e instanceof GitUnfetchableError)) throw e;
        // The student force-pushed the baseline away and GitHub collected it. The head of main
        // is the documented null-baseline stand-in (`resolveSyncBaselineSha`).
        baselineSha = mainSha;
        tags.sync_baseline_unreachable = "true";
      }
    }
    await this.#phaseDone("fetch");

    // §5.3: the handout diff, tree to tree.
    const handoutHeader = await this.#commitHeader(toSha);
    const handoutBeforeTree = handoutBeforeCommit
      ? (await this.#commitHeader(handoutBeforeCommit)).tree
      : EMPTY_TREE_SHA;
    const changes = await this.#handoutDiff(handoutBeforeTree, handoutHeader.tree, tags);

    // §5.4: classification, unchanged policy.
    const removedPaths = new Set(changes.filter((c) => c.status === "removed").map((c) => c.path));
    let files: ClassifiedFile[] = [];
    if (changes.length > 0) {
      const [student, handoutBefore] = await Promise.all([
        this.#lsTree(baselineSha),
        handoutBeforeTree === EMPTY_TREE_SHA
          ? Promise.resolve(new Map<string, TreeEntry>())
          : this.#lsTree(handoutBeforeTree)
      ]);
      const verdicts = classifyPaths(
        changes.map((c) => c.path),
        student,
        handoutBefore,
        removedPaths
      );
      files = changes.map((change) => {
        const reason = verdicts.get(change.path);
        return { change, reason, action: decideFileAction(shapeOf(change), reason) };
      });
    }
    await this.#phaseDone("classify");

    return {
      input: { templateRepo, fromSha, toSha, syncedRepoSha, repoFullName: repo },
      baselineSha,
      mainSha,
      handoutBeforeTree,
      handoutTree: handoutHeader.tree,
      handoutCommitDate: handoutHeader.committerDate,
      files,
      removedPaths,
      tags
    };
  }

  async classifyPathsAgainstHead(
    analysis: SyncAnalysis,
    paths: readonly string[]
  ): Promise<{ headSha: string; stillDiffering: Map<string, UnresolvedReason> }> {
    if (paths.length === 0) return { headSha: analysis.mainSha, stillDiffering: new Map() };
    const [student, handout] = await Promise.all([this.#lsTree(analysis.mainSha), this.#lsTree(analysis.handoutTree)]);
    return {
      headSha: analysis.mainSha,
      stillDiffering: classifyPaths(paths, student, handout, analysis.removedPaths)
    };
  }

  /**
   * Fetches `refs/heads/main` (depth 1) and returns its SHA. A remote with no `main` is terminal
   * `student_repo_has_no_main` (§5.2): an empty repo, or one whose default branch has another
   * name. It must not fall through to the unreachable-baseline path, which would read the head of
   * a branch that does not exist.
   */
  async #fetchStudentMain(repo: string): Promise<string> {
    try {
      await runGitChecked(
        { op: "fetch", gitDir: this.gitDir, repo, target: { kind: "main", trackingRef: STUDENT_MAIN_REF }, depth: 1 },
        this.git
      );
    } catch (e) {
      if (e instanceof GitUnfetchableError) {
        throw new GitSyncTerminalError(
          `${repo} has no refs/heads/main to sync onto (empty, or its default branch has another name)`,
          "student_repo_has_no_main"
        );
      }
      throw e;
    }
    return await readLocalRef(this.gitDir, STUDENT_MAIN_REF);
  }

  async #hasCommit(sha: string): Promise<boolean> {
    const r = await runGit(
      { op: "cat-file", gitDir: this.gitDir, object: sha, mode: "exists", peel: "commit" },
      this.git
    );
    return r.code === 0 && r.signal === null && !r.timedOut && !r.aborted;
  }

  async #commitHeader(sha: string) {
    const r = await runGitChecked({ op: "cat-file", gitDir: this.gitDir, object: sha, mode: "commit" }, this.git);
    return parseCommitHeader(r.stdout);
  }

  async #lsTree(treeish: string): Promise<Map<string, TreeEntry>> {
    const r = await runGitChecked({ op: "ls-tree", gitDir: this.gitDir, treeish }, this.git);
    const parsed = parseLsTree(r.stdout);
    if (parsed.nonUtf8Paths > 0) {
      this.#log({ msg: "ls-tree entries with non-UTF-8 paths ignored", treeish, count: parsed.nonUtf8Paths });
    }
    return parsed.entries;
  }

  async #handoutDiff(fromTree: string, toTree: string, tags: SyncTags): Promise<HandoutChange[]> {
    const [raw, numstat] = await Promise.all([
      runGitChecked({ op: "diff-tree", gitDir: this.gitDir, from: fromTree, to: toTree, format: "raw" }, this.git),
      runGitChecked({ op: "diff-tree", gitDir: this.gitDir, from: fromTree, to: toTree, format: "numstat" }, this.git)
    ]);
    const { changes, gitlinksDropped } = mapHandoutDiff(
      parseDiffTreeRaw(raw.stdout),
      parseNumstatBinary(numstat.stdout)
    );
    if (gitlinksDropped.length > 0) {
      tags.gitlinks_dropped = String(gitlinksDropped.length);
      this.#log({ msg: "submodule entries dropped from the handout diff", paths: gitlinksDropped });
    }
    return changes;
  }
}

// ---------------------------------------------------------------------------------------------
// §5.3 mapping and §5.4 classification (pure)
// ---------------------------------------------------------------------------------------------

const GITLINK_MODE = "160000";

/**
 * Maps `diff-tree` records onto the shape the guard reads (§5.3):
 *
 * | git | status   | isBinary     | hasPatch   |
 * |-----|----------|--------------|------------|
 * | A   | added    | from numstat | !isBinary  |
 * | M   | modified | from numstat | !isBinary  |
 * | D   | removed  | from numstat | false      |
 * | T   | modified | true         | false      |
 *
 * Gitlinks (mode 160000) are dropped, since the sync never wrote one. A type change between a
 * gitlink and a blob keeps its blob side: a file that became a submodule is a removal of the
 * file, and a submodule that became a file is an addition. That is what the REST path's tree
 * diff does for a rewritten handout today (`getChangedFiles`, the `rewritten` branch), which
 * reads only blob entries on each side.
 *
 * A path that is not valid UTF-8 is terminal `non_utf8_path`. Only handout paths become index
 * entries, and JS strings cannot carry those bytes unchanged.
 */
export function mapHandoutDiff(
  records: readonly RawDiffRecord[],
  binaryByKey: ReadonlyMap<string, boolean>
): { changes: HandoutChange[]; gitlinksDropped: string[] } {
  const changes: HandoutChange[] = [];
  const gitlinksDropped: string[] = [];
  for (const rec of records) {
    const path = decodePath(rec.pathBytes);
    if (path === null) {
      const shown = escapePath(rec.pathBytes);
      throw new GitSyncTerminalError(
        `the handout diff contains a path that is not valid UTF-8: ${shown}`,
        "non_utf8_path",
        shown
      );
    }
    let { status, oldMode, newMode, oldOid, newOid } = rec;
    const oldIsLink = oldMode === GITLINK_MODE;
    const newIsLink = newMode === GITLINK_MODE;
    if (oldIsLink || newIsLink) {
      gitlinksDropped.push(path);
      if (oldIsLink && newIsLink) continue;
      if (status === "A" || status === "D") continue;
      // `T` across a gitlink: keep the blob side.
      if (newIsLink) {
        status = "D";
        newMode = null;
        newOid = null;
      } else {
        status = "A";
        oldMode = null;
        oldOid = null;
      }
    }
    // A record numstat did not list is read as binary, which only ever removes the merge option.
    const numstatBinary = binaryByKey.get(rec.key) ?? true;
    let change: HandoutChange;
    const base = { path, gitStatus: status, patchDeletesFile: false as const, oldMode, newMode, oldOid, newOid };
    switch (status) {
      case "A":
        change = { ...base, status: "added", isBinary: numstatBinary, hasPatch: !numstatBinary };
        break;
      case "M":
        change = { ...base, status: "modified", isBinary: numstatBinary, hasPatch: !numstatBinary };
        break;
      case "D":
        change = { ...base, status: "removed", isBinary: numstatBinary, hasPatch: false };
        break;
      case "T":
        change = { ...base, status: "modified", isBinary: true, hasPatch: false };
        break;
    }
    changes.push(change);
  }
  return { changes, gitlinksDropped };
}

export function shapeOf(change: HandoutChange): ChangedFileShape {
  return {
    path: change.path,
    status: change.status,
    isBinary: change.isBinary,
    hasPatch: change.hasPatch,
    patchDeletesFile: change.patchDeletesFile
  };
}

/**
 * The classification loop of `findStudentModifiedFiles`, over complete local listings: the
 * guard's verdict for each path, then the structural ancestor check unless the handout is
 * deleting the path. Returns only the paths that are the student's.
 *
 * Kept line for line with that loop so the two cannot drift while both exist. The truncated-tree
 * lookups around it are gone, because `ls-tree` is never truncated (§5.4).
 */
export function classifyPaths(
  paths: readonly string[],
  student: Map<string, TreeEntry>,
  handout: Map<string, TreeEntry>,
  removedPaths: ReadonlySet<string>
): Map<string, UnresolvedReason> {
  const modified = new Map<string, UnresolvedReason>();
  for (const path of paths) {
    const verdict = classifyStudentFile(student.get(path), handout.get(path));
    if (verdict !== "unmodified") {
      modified.set(path, verdict);
      continue;
    }
    if (removedPaths.has(path)) continue;
    if (findBlockingAncestor(path, student, handout)) {
      modified.set(path, "path_blocked_in_your_repo");
    }
  }
  return modified;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * Reads a ref the job itself just wrote. A file read, not a git call: `runGit` has no rev-parse
 * builder, and a fresh job repo has only the loose ref the fetch created (with `packed-refs` as
 * the fallback git would use).
 */
async function readLocalRef(gitDir: string, ref: string): Promise<string> {
  try {
    const sha = (await Deno.readTextFile(`${gitDir}/${ref}`)).trim();
    return validateSha(sha, ref);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  try {
    for (const line of (await Deno.readTextFile(`${gitDir}/packed-refs`)).split("\n")) {
      const [sha, name] = line.split(" ");
      if (name === ref) return validateSha(sha, ref);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  throw new GitSyncError(`fetch reported success but ${ref} was not written`, "git_failed", true);
}
