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
 *
 * Every step is read-only, content-addressed or a compare-and-swap, and the commit is a pure
 * function of the inputs (§5.7), so a job killed at any point and re-run from scratch builds the
 * same commit and either pushes it or finds it already pushed (§6.1). Nothing is persisted between
 * attempts.
 */
import { SYNC_COMMIT_MESSAGE_PREFIX } from "../handoutSyncPush.ts";
import {
  type BlobMode,
  classifyStudentFile,
  type ChangedFileShape,
  decideFileAction,
  type FileAction,
  findBlockingAncestor,
  isBlobMode,
  isHandoutOwnedPath,
  type TreeEntry,
  type UnresolvedFile,
  type UnresolvedReason
} from "../syncConflictGuard.ts";
import { isBinaryPath } from "./binaryPath.ts";
import {
  GitSyncError,
  GitSyncRetryableError,
  GitSyncTerminalError,
  GitUnfetchableError,
  InvalidSyncInputError
} from "./errors.ts";
import {
  decodePath,
  escapePath,
  firstToken,
  parseCommitHeader,
  parseDiffTreeRaw,
  parseLsTree,
  parseNumstatBinary,
  type RawDiffRecord
} from "./gitOutput.ts";
import {
  classifyGitFailure,
  type GitContext,
  type GitIdentity,
  type GitLogger,
  type GitTestHooks,
  type IndexInfoEntry,
  lsRemoteSyncBranch,
  type RemoteConfig,
  runGit,
  runGitChecked
} from "./runGit.ts";
import type { TemplateCache } from "./templateCache.ts";
import { EMPTY_TREE_SHA, syncBranchFor, validateLocalPath, validateRepoFullName, validateSha } from "./validate.ts";

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
  /**
   * Installation token for the student side of this job (§8.2): the student fetch, `ls-remote`,
   * the push and the job repo's local calls. Never sent to the template.
   */
  token?: string;
  /**
   * Installation token for the template fetches into the template cache, from the template org's
   * installation and scoped to the template repo with `contents: read`. A separate token keeps the
   * student token, which can write, away from the template, and lets a handout in another org
   * sync. Undefined means template fetches carry no credential; there is no fallback to `token`.
   */
  templateToken?: string;
  /** Fires at the job deadline and kills the running git child (§3.1). */
  signal?: AbortSignal;
  /** Author and committer of the sync commit (§5.7). */
  identity: GitIdentity;
  /** `HANDOUT_SYNC_MAX_MERGE_BYTES` (§5.5). Defaults to `DEFAULT_MAX_MERGE_BYTES`. */
  maxMergeBytes?: number;
  /** Per-file `merge-file` timeout. Defaults to `runGit`'s 60 s (§8.4). */
  mergeFileTimeoutMs?: number;
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
  /**
   * A modify to the empty blob. Git reports a deletion as `D`, but a handout that truncates a file
   * to 0 bytes is the shape today's `patchDeletesEntireFile` also matched (a `+0,0` hunk), and
   * `decideFileAction` keys its "both sides deleted it" noop on this flag.
   */
  patchDeletesFile: boolean;
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
 * - `sync_without_handout_history`: `F` was null (today's tag for the same situation).
 * - `sync_baseline_from_head`: `S` was null and the head of main stood in for it.
 * - `sync_baseline_unreachable`: `S` could not be fetched and the head of main stood in for it.
 * - `template_cache_stale_locks`: the number of stale lock files removed before fetching.
 * - `gitlinks_dropped`: the number of submodule entries left out of the diff.
 * - `merge_file_too_large`: files not merged because a blob was over `maxMergeBytes` (§5.5).
 * - `merge_file_failed`: files whose `merge-file` was killed, timed out or errored.
 * - `merge_file_conflicts`: files whose `merge-file` reported conflicts.
 */
export type SyncTags = Record<string, string>;

/** Everything §5.1–§5.4 established about one sync, before any object is written. */
export interface SyncAnalysis {
  input: SyncInput;
  /** The `S` actually used: the input, or the head of main when it was null or unreachable. */
  baselineSha: string;
  /** The head of the student's `main` when it was fetched. */
  mainSha: string;
  /** `F`'s tree, or the empty tree when `F` is null. */
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

/**
 * `F` could not be fetched from the template: the handout's history was rewritten and the old
 * revision collected. Retryable; the caller makes it terminal `handout_base_missing` once
 * `retry_count` reaches 5 (§5.1).
 *
 * Deliberately not the empty-tree fallback that a null `F` gets. With no old handout to compare
 * against, every file the student holds reads as theirs, and the sync would open a PR listing
 * nearly the whole repository as their own work. Today a missing `F` fails the sync too
 * (`getRepoTree` throws).
 */
export class HandoutBaseUnfetchableError extends GitUnfetchableError {
  constructor(
    readonly templateRepo: string,
    readonly sha: string
  ) {
    super(`handout base revision ${sha} is not fetchable from ${templateRepo}`);
    this.name = "HandoutBaseUnfetchableError";
  }
}

/** The plan for a sync whose handout diff is empty: `{ success: true, no_changes: true }`. */
export interface NoChangesPlan {
  kind: "no_changes";
  analysis: SyncAnalysis;
}

/**
 * Every file was left to the student or needed nothing, so the tree equals the baseline's and
 * there is nothing to commit (§5.6). The caller runs the blocked recheck (§6.3) on
 * `unresolved` paths, as `blockedByStudentChanges(unresolved.map(f => f.path))` does today.
 */
export interface NothingSurvivedPlan {
  kind: "nothing_survived";
  analysis: SyncAnalysis;
  unresolved: UnresolvedFile[];
}

/** A commit built and ready to push to `branch`. Nothing has been pushed yet. */
export interface CommitPlan {
  kind: "commit";
  analysis: SyncAnalysis;
  /** `sync-to-${H:0:7}`. */
  branch: string;
  commit: string;
  tree: string;
  /** Always the baseline `S` (§5.7). */
  parent: string;
  /** The commit message, byte for byte as the REST path writes it. */
  message: string;
  /** The paths the message lists: every file the sync wrote or tried to merge. */
  changedFiles: string[];
  /** Files left to the student, in diff order. */
  unresolved: UnresolvedFile[];
}

export type SyncPlan = NoChangesPlan | NothingSurvivedPlan | CommitPlan;

export interface PushResult {
  /** False when the branch was already at the commit (a retry of a job that had pushed). */
  pushed: boolean;
  /** The branch head before this push, or null when the branch did not exist. */
  previousHead: string | null;
}

export interface PushOptions {
  /**
   * Called only when the branch exists at a commit that is neither the plan's commit nor its
   * parent (§5.8 "other"). `head` is the branch head `ls-remote` read, and `base` is the plan's
   * parent `S`. It must throw to refuse the reset, and otherwise RETURN the head sha it validated.
   *
   * WP3 backs it with the REST branch-safety check, which must compare `${base}...${head}` for
   * exactly this `head`, not re-read the branch. `assertSyncBranchSafeToReset` reads the ref
   * itself, and a lagging read can return an older sync commit of ours while `ls-remote` already
   * sees a student's commit on top of it: the check would approve ours, and the lease on the
   * student's head would then force-push over their work. So the engine pushes only when the
   * returned sha equals `head`, and the lease pins that same sha.
   */
  confirmResetSafe: (args: { head: string; base: string }) => Promise<string>;
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
  /**
   * §5.1–§5.4: fetch, diff and classify. Writes no object and pushes nothing. A job analyzes one
   * sync: call this or `plan`, once.
   */
  analyze(input: SyncInput): Promise<SyncAnalysis>;
  /** §5.1–§5.7: `analyze`, then resolve each file, build the tree and the commit. Pushes nothing. */
  plan(input: SyncInput): Promise<SyncPlan>;
  /** §5.8: pushes a commit plan from this job to its sync branch with a compare-and-swap. */
  push(plan: CommitPlan, opts: PushOptions): Promise<PushResult>;
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
 * Plan-only (shadow) mode: everything up to the commit, in a job of its own, and never a push.
 * The plan's objects go with the job directory; `plan.tree` and `plan.unresolved` are what a
 * shadow comparison records.
 */
export async function planHandoutSync(input: SyncInput, ctx: SyncJobContext): Promise<SyncPlan> {
  return await withSyncJob(ctx, (job) => job.plan(input));
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
  /** The student's tree at the baseline, from `analyze`. `modeFor` reads modes from it. */
  #student = new Map<string, TreeEntry>();
  #plans = new WeakSet<CommitPlan>();

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
    // The template's own credential, never the student token (§8.2).
    const templateGit: GitContext = { ...this.git, token: this.ctx.templateToken };
    const { outcomes, staleLocksRemoved } = await cache.ensureCommits(templateRepo, wanted, templateGit);
    if (staleLocksRemoved.length > 0) {
      tags.template_cache_stale_locks = String(staleLocksRemoved.length);
      this.#log({ msg: "removed stale template cache locks", templateRepo, locks: staleLocksRemoved });
    }
    if (outcomes.get(toSha) === "unfetchable") throw new HandoutRevisionUnfetchableError(templateRepo, toSha);
    if (fromSha === null) {
      // The row records no handout revision at all (legacy, adopted or hand-made). The empty tree
      // claims nothing at any path, so every path the student holds classifies as theirs:
      // today's `fromSha = null` semantics.
      tags.sync_without_handout_history = "true";
    } else if (outcomes.get(fromSha) === "unfetchable") {
      throw new HandoutBaseUnfetchableError(templateRepo, fromSha);
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
    const handoutBeforeTree = fromSha ? (await this.#commitHeader(fromSha)).tree : EMPTY_TREE_SHA;
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
      this.#student = student;
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

  async plan(input: SyncInput): Promise<SyncPlan> {
    const analysis = await this.analyze(input);
    if (analysis.files.length === 0) return { kind: "no_changes", analysis };
    const { tags } = analysis;

    // §5.5: each file to an index update. Removals and sets go in separate calls (§5.6).
    const removals: IndexInfoEntry[] = [];
    const sets: IndexInfoEntry[] = [];
    const unresolved: UnresolvedFile[] = [];
    const changedFiles: string[] = [];
    for (const { change, reason, action } of analysis.files) {
      const { path } = change;
      if (action === "noop") continue;
      if (action === "skip") {
        // No index update: the baseline supplies the student's own file.
        unresolved.push({ path, reason: reason as UnresolvedReason });
        continue;
      }
      changedFiles.push(path);
      if (action === "write") {
        if (change.status === "removed") {
          removals.push({ kind: "remove", path });
        } else if (isHandoutOwnedPath(path)) {
          // Content and mode are the handout's. A workflow the student made executable is still a
          // workflow the handout decides.
          sets.push({
            kind: "set",
            path,
            mode: isBlobMode(change.newMode ?? undefined) ? (change.newMode as BlobMode) : "100644",
            oid: change.newOid!
          });
        } else {
          // Not the student's, so the handout's blob is exactly what today's `applyPatch` onto an
          // unmodified base produces, and what its template fallback writes.
          sets.push({ kind: "set", path, mode: this.#modeFor(path, change.newMode, !!reason), oid: change.newOid! });
        }
        continue;
      }
      // attempt_patch: a 3-way merge into the student's copy, or the file is left to them.
      const merged = await this.#mergeFile(change, tags);
      if (merged === null) {
        unresolved.push({ path, reason: "content_differs" });
      } else {
        sets.push({ kind: "set", path, mode: this.#modeFor(path, change.newMode, true), oid: merged });
      }
    }

    // §5.6: the tree, in a private index seeded from the baseline. Removals go first, as the spec
    // orders them, so a directory the handout replaces with a file is already empty when the file
    // is added. `--replace` on the sets would also resolve that collision; the mutation run found
    // the order unobservable, and it is kept so neither call depends on the other's flags.
    const indexFile = `${this.gitDir}/sync.index`;
    const parent = analysis.baselineSha;
    await runGitChecked({ op: "read-tree", gitDir: this.gitDir, indexFile, treeish: parent }, this.git);
    if (removals.length > 0) {
      await runGitChecked({ op: "update-index", gitDir: this.gitDir, indexFile, entries: removals }, this.git);
    }
    if (sets.length > 0) {
      await runGitChecked({ op: "update-index", gitDir: this.gitDir, indexFile, entries: sets }, this.git);
    }
    const tree = firstToken(
      (await runGitChecked({ op: "write-tree", gitDir: this.gitDir, indexFile }, this.git)).stdout
    );
    validateSha(tree, "write-tree output");
    await this.#phaseDone("tree");

    // Nothing survived: every file was left to the student, or every write was already there.
    // No ref exists yet, so unlike the REST path there is no empty branch to clean up.
    if (tree === (await this.#commitHeader(parent)).tree) {
      return { kind: "nothing_survived", analysis, unresolved };
    }

    // §5.7: deterministic. Identity, date, tree, parent and message are all functions of the
    // inputs, so a retry builds the same sha.
    const message = syncCommitMessage(analysis.input.toSha, changedFiles);
    const commit = firstToken(
      (
        await runGitChecked(
          {
            op: "commit-tree",
            gitDir: this.gitDir,
            tree,
            parents: [parent],
            message,
            identity: this.ctx.identity,
            // The explicit epoch form: git refuses a bare `<secs> <tz>` outside ~1973-2100.
            date: `@${analysis.handoutCommitDate}`
          },
          this.git
        )
      ).stdout
    );
    validateSha(commit, "commit-tree output");
    await this.#phaseDone("commit");
    const plan: CommitPlan = {
      kind: "commit",
      analysis,
      branch: syncBranchFor(analysis.input.toSha),
      commit,
      tree,
      parent,
      message,
      changedFiles,
      unresolved
    };
    this.#plans.add(plan);
    return plan;
  }

  async push(plan: CommitPlan, opts: PushOptions): Promise<PushResult> {
    // The commit's objects exist only in this job's repo.
    if (!this.#plans.has(plan)) throw new Error("push takes a commit plan built by this job");
    const repo = plan.analysis.input.repoFullName;
    const head = await lsRemoteSyncBranch({ gitDir: this.gitDir, repo, branch: plan.branch }, this.git);
    let expect: string | null;
    if (head === null) {
      expect = null;
    } else if (head.sha === plan.commit) {
      // A retry of a job that already pushed.
      await this.#phaseDone("push");
      return { pushed: false, previousHead: head.sha };
    } else if (head.sha === plan.parent) {
      // Where a previous attempt's branch creation left it; nothing on it to lose.
      expect = plan.parent;
    } else {
      // Something else is there: an earlier sync commit of ours, or a student's work. The caller
      // decides, and the lease holds the push to the exact head it decided about. An approval of
      // any other sha is no approval of this one.
      const validated = await opts.confirmResetSafe({ head: head.sha, base: plan.parent });
      if (validated !== head.sha) {
        throw new GitSyncRetryableError(
          `the reset check for ${plan.branch} validated ${String(validated).slice(0, 40)}, but the branch is at ${head.sha}`,
          "reset_check_mismatch"
        );
      }
      expect = head.sha;
    }
    await runGitChecked(
      { op: "push", gitDir: this.gitDir, repo, commit: plan.commit, branch: plan.branch, expect },
      this.git
    );
    await this.#phaseDone("push");
    return { pushed: true, previousHead: head?.sha ?? null };
  }

  /**
   * `modeFor` from `createBranchAndCommit`, ported verbatim (§5.5.1): the student's mode for a
   * file that is theirs, otherwise the handout's, otherwise whichever is known, otherwise 100644.
   */
  #modeFor(path: string, handoutMode: string | null, isTheStudents: boolean): BlobMode {
    const existing = this.#student.get(path);
    const studentMode = existing?.type === "blob" && isBlobMode(existing.mode) ? existing.mode : undefined;
    if (isTheStudents && studentMode) return studentMode;
    if (isBlobMode(handoutMode ?? undefined)) return handoutMode as BlobMode;
    return studentMode ?? "100644";
  }

  /**
   * `git merge-file --object-id S:p F:p H:p` (§5.5). Returns the merged blob's id, or null when
   * the file has to be left to the student: a conflict, a blob over the merge cap, or a child that
   * timed out, was killed or errored. None of those fails the sync.
   *
   * The cap exists because merge-file has no memory bound and the cgroup OOM killer picks its
   * victim by size, which can be the worker rather than the git child.
   */
  async #mergeFile(change: HandoutChange, tags: SyncTags): Promise<string | null> {
    const student = this.#student.get(change.path);
    if (student?.type !== "blob" || !change.oldOid || !change.newOid) return null;
    const max = this.ctx.maxMergeBytes ?? DEFAULT_MAX_MERGE_BYTES;
    for (const oid of [student.sha, change.oldOid, change.newOid]) {
      const r = await runGitChecked({ op: "cat-file", gitDir: this.gitDir, object: oid, mode: "size" }, this.git);
      if (Number(firstToken(r.stdout)) > max) {
        bump(tags, "merge_file_too_large");
        this.#log({ msg: "merge-file skipped: blob over the merge cap", path: change.path, maxMergeBytes: max });
        return null;
      }
    }
    const r = await runGit(
      {
        op: "merge-file",
        gitDir: this.gitDir,
        student: student.sha,
        handoutBefore: change.oldOid,
        handout: change.newOid,
        timeoutMs: this.ctx.mergeFileTimeoutMs
      },
      this.git
    );
    // The job deadline is the job failing, not this file.
    if (r.aborted) throw classifyGitFailure(r)!;
    // merge-file exits with the conflict count, capped at 127, and with 255 (its -1) on an error
    // such as binary content on the student's side.
    if (r.signal !== null || r.timedOut || r.outputCapExceeded || r.code >= 128) {
      bump(tags, "merge_file_failed");
      this.#log({
        msg: "merge-file failed; file left to the student",
        path: change.path,
        code: r.code,
        signal: r.signal
      });
      return null;
    }
    if (r.code > 0) {
      bump(tags, "merge_file_conflicts");
      return null;
    }
    return validateSha(firstToken(r.stdout), "merge-file output");
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

/**
 * The sync commit's message, byte for byte as `syncRepositoryToHandout` builds it: the subject
 * must keep matching `SYNC_COMMIT_SUBJECT_RE`, which `isOurSyncCommit` and the
 * `github-repo-webhook` "this push is not a submission" path both depend on (§5.7).
 */
export function syncCommitMessage(toSha: string, changedFiles: readonly string[]): string {
  return `${SYNC_COMMIT_MESSAGE_PREFIX} ${toSha.substring(0, 7)}

This commit was automatically generated by an instructor to sync
changes from the template repository.

Changed files:
${changedFiles.map((path) => `- ${path}`).join("\n")}`;
}

function bump(tags: SyncTags, tag: string): void {
  tags[tag] = String(Number(tags[tag] ?? 0) + 1);
}

// ---------------------------------------------------------------------------------------------
// §5.3 mapping and §5.4 classification (pure)
// ---------------------------------------------------------------------------------------------

const GITLINK_MODE = "160000";

/** The empty blob. A modify to it is a truncation to 0 bytes. */
export const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

/**
 * Maps `diff-tree` records onto the shape the guard reads (§5.3):
 *
 * | git | status   | isBinary                        | hasPatch   |
 * |-----|----------|---------------------------------|------------|
 * | A   | added    | numstat `-\t-` or `isBinaryPath` | !isBinary  |
 * | M   | modified | numstat `-\t-` or `isBinaryPath` | !isBinary, false for a mode-only change |
 * | D   | removed  | numstat `-\t-` or `isBinaryPath` | false      |
 * | T   | modified | true                            | false      |
 *
 * The extension list keeps today's answer for files such as PDFs and class files whose bytes
 * happen to look like text, which would otherwise become mergeable.
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
    const binary = (binaryByKey.get(rec.key) ?? true) || isBinaryPath(path);
    let change: HandoutChange;
    const base = { path, gitStatus: status, patchDeletesFile: false, oldMode, newMode, oldOid, newOid };
    switch (status) {
      case "A":
        change = { ...base, status: "added", isBinary: binary, hasPatch: !binary };
        break;
      case "M":
        change = {
          ...base,
          status: "modified",
          isBinary: binary,
          // A mode-only change (same blob) carries no patch, as GitHub's compare reports it. With
          // one, a student-edited file went to merge-file, which returned their blob with their
          // mode, so the handout's +x vanished and the file was not listed as left to them.
          hasPatch: !binary && oldOid !== newOid,
          patchDeletesFile: newOid === EMPTY_BLOB_SHA && oldOid !== EMPTY_BLOB_SHA
        };
        break;
      case "D":
        change = { ...base, status: "removed", isBinary: binary, hasPatch: false };
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
export async function readLocalRef(gitDir: string, ref: string): Promise<string> {
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
