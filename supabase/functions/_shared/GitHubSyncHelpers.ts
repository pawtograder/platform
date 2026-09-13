/**
 * GitHubSyncHelpers.ts
 *
 * Reusable functions for syncing template repository changes to student repositories.
 * Can be used by async workers, scripts, or manual operations.
 */

import { createRedis, bottleneckRedisOptions, type RedisClient } from "./Redis.ts";
import { SYNC_COMMIT_MESSAGE_PREFIX } from "./handoutSyncPush.ts";
import {
  ancestorPaths,
  classifyStudentFile,
  countsTowardSyncSize,
  decideFileAction,
  decodeRepoTree,
  encodeRepoTree,
  findBlockingAncestor,
  GRADE_WORKFLOW_PATH as GUARD_GRADE_WORKFLOW_PATH,
  isOurSyncCommit,
  isSyncBranchSafeToReset,
  pathsNeedingBlobLookup,
  renderUnresolvedSection,
  resolveAutoMerge,
  type ChangedFileShape,
  type RepoTree,
  type RepoTreeEntry,
  type SyncBranchCommit,
  type TreeEntry,
  type UnresolvedFile,
  type UnresolvedReason
} from "./syncConflictGuard.ts";
import { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import Bottleneck from "https://esm.sh/bottleneck?target=deno";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { applyPatch } from "https://esm.sh/diff@5.1.0";
import { encodeBase64 } from "https://deno.land/std@0.221.0/encoding/base64.ts";
import {
  decodeGitHubBase64Text,
  decodeGitHubTextBytes,
  encodeTextAsGitHubBase64,
  type GitHubTextFile
} from "./GitHubTextEncoding.ts";
import * as github from "./GitHubWrapper.ts";
import { getCreateContentLimiter } from "./GitHubWrapper.ts";
// (Redis-related imports consolidated above into the one createRedis line)
import { Database } from "./SupabaseTypes.d.ts";

/**
 * Pins the guard module's copy of the grading workflow path to the one the rest of the
 * codebase writes and reads. `syncConflictGuard.ts` carries its own literal so it can stay
 * free of GitHub imports and be unit-tested against no mock at all; this file imports both,
 * so it is the one place that can hold them together. Changing either literal stops this
 * assignment compiling, which is the entire point of it.
 */
const _gradeWorkflowPathsAgree: typeof github.GRADE_WORKFLOW_PATH = GUARD_GRADE_WORKFLOW_PATH;

export interface FileChange {
  path: string;
  /**
   * For binary or initial-sync files, this is the GitHub blob SHA at the *template* `toSha`.
   * `createBranchAndCommit` uses it to fetch content lazily so we don't hold every blob in memory at once.
   * For text files with a patch, `sha` is the blob SHA in the comparison response (informational).
   */
  sha?: string;
  patch?: string; // Unified diff for text files
  isBinary?: boolean;
  status?: string; // "added", "modified", "removed", "renamed"
  previous_filename?: string; // For renamed files
  /** Approximate size in bytes from the GitHub API; used by the size guard. */
  size?: number;
}

/**
 * Maximum total bytes of file content we'll buffer while syncing a single repo.
 * Belt-and-suspenders cap on cumulative bytes processed within one sync (each file
 * goes in/out of memory sequentially, so peak memory ≈ one file at a time, but this
 * prevents pathological "many medium files" handouts from blowing the budget).
 *
 * Sized to fit comfortably alongside one ~MAX_SYNC_FILE_BYTES file resident at peak
 * inside the Supabase Edge Function ~150 MB v8 heap.
 */
const MAX_SYNC_TOTAL_BYTES = 200 * 1024 * 1024; // 200 MB cumulative

/**
 * Hard per-file cap. Files larger than this fail fast with a clear error rather than
 * trying (and OOMing) the worker. The blob-copy path (`copyBlobBetweenRepos`) downloads
 * raw bytes (not base64) and uses a streaming Blob body for the upload to avoid the
 * 2× materialization that the Octokit JSON path forces, so peak memory ≈ raw + base64
 * ≈ 2.33×. At 75 MB raw that's ~175 MB transient, which is right at the edge — V8
 * generally GCs the raw buffer before the upload completes, but anything bigger is
 * not safe to attempt in this runtime.
 *
 * If you need to ship something bigger, run `FixStuckSyncs.ts` locally (no memory cap)
 * or move the data out-of-band (S3, course CDN, Git LFS).
 */
const MAX_SYNC_FILE_BYTES = 75 * 1024 * 1024; // 75 MB per single file

/**
 * Threshold above which a single file is considered "heavy" — heavy syncs serialize
 * themselves through `withHeavySyncLock` so we don't hold multiple large blobs in
 * memory simultaneously inside a single Edge Function isolate. Below this, syncs run
 * with the existing per-org Bottleneck concurrency (typical small-handout case).
 */
const LARGE_FILE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

/**
 * Per-isolate semaphore that serializes "heavy" syncs (those with at least one file
 * over LARGE_FILE_THRESHOLD). Light syncs run as before. This is module-level state,
 * scoped to the current Edge Function isolate; cross-isolate coordination is provided
 * by the existing per-org Bottleneck (Redis-backed) which limits total in-flight syncs.
 */
let heavySyncQueue: Promise<unknown> = Promise.resolve();
function withHeavySyncLock<T>(fn: () => Promise<T>): Promise<T> {
  // Chain on top of the previous heavy sync. Use `.then(fn, fn)` so a rejected
  // previous run doesn't permanently poison the chain — either branch invokes `fn`.
  const next = heavySyncQueue.then(
    () => fn(),
    () => fn()
  );
  // Swallow rejection on the queue tail so future awaiters don't see this run's error.
  heavySyncQueue = next.catch(() => undefined);
  return next;
}

export interface SyncResult {
  success: boolean;
  pr_number?: number;
  pr_url?: string;
  merged?: boolean;
  merge_sha?: string;
  error?: string;
  /** The handout holds nothing new for this repo. Safe to record as fully synced. */
  no_changes?: boolean;
  /**
   * The handout DOES hold something new, and none of it could be written, because every
   * changed file is the student's own work.
   *
   * Distinct from `no_changes` on purpose: a caller that records this as synced would mark
   * an update delivered that never reached the repo. There is no PR here either, so the
   * only trace is this flag and the paths below.
   */
  blocked_by_student_changes?: boolean;
  /** The paths that blocked it, for the caller to record. */
  unresolved_paths?: string[];
  /**
   * The repository's head commit, reported ONLY when this sync read it and reached its
   * conclusion from it.
   *
   * `synced_repo_sha` and `synced_handout_sha` are a matched pair: the first is the baseline
   * the conflict guard classifies against, so advancing the second alone leaves the baseline
   * describing an older tree, and every path someone has since brought into line with the
   * handout reads as the student's own work against content that is already correct. The
   * caller needs this value to move the pair together.
   *
   * Absent is a meaningful answer and means "do not move the baseline". The field is set only
   * where the head was the BASIS of the decision, never read afterwards to fill the field in:
   * a head read after the fact can contain a push the student made in the meantime, and
   * recording that as the machine-written baseline hands their next commit to the overwrite
   * this guard exists to prevent.
   */
  repo_head_sha?: string;
  /**
   * Set when the failure was a `TerminalSyncError`: this repository's own problem, which
   * retrying will not fix and which says nothing about GitHub's health.
   *
   * Carried as a field because `success: false` is where the class is lost. Every error here
   * is flattened to a message string, so a caller branching on `instanceof` sees nothing, and
   * the worker's generic path then reads a student's hand-resolved branch as a GitHub outage
   * and pauses handout delivery for the whole org. The value is `TerminalSyncError.reason` --
   * a stable code, not a message -- so the caller can branch per case.
   */
  terminal_reason?: string;
}

// Redis client for caching. createRedis picks ioredis (REDIS_URL) or
// the Upstash REST adapter automatically; both speak the GET/SETEX
// subset this file uses.
let redisClient: RedisClient | null = null;

function getRedisClient(): RedisClient | null {
  if (redisClient) {
    return redisClient;
  }
  redisClient = createRedis();
  return redisClient;
}

const syncLimiters = new Map<string, Bottleneck>();
// Bottleneck limiter for sync operations - limit to 20 concurrent to avoid thrashing between multiple requests
function getSyncLimiter(org: string): Bottleneck {
  const key = org || "unknown";
  const existing = syncLimiters.get(key);
  if (existing) return existing;
  // bottleneckRedisOptions picks ioredis (REDIS_URL) or the Upstash
  // adapter (UPSTASH_REDIS_REST_*) automatically; null falls through
  // to the local-only limiter.
  const redisOpts = bottleneckRedisOptions();
  let limiter: Bottleneck;
  if (redisOpts) {
    limiter = new Bottleneck({
      id: `sync_repo_to_handout:${key}:${Deno.env.get("GITHUB_APP_ID") || ""}`,
      reservoir: 20,
      maxConcurrent: 20,
      reservoirRefreshAmount: 20,
      reservoirRefreshInterval: 60_000,
      timeout: 600000, // 10 minutes
      clearDatastore: false,
      ...redisOpts
    });
    limiter.on("error", (err: Error) => console.error(err));
  } else {
    Sentry.captureMessage("No Redis configured (REDIS_URL / UPSTASH_*), using local sync limiter");
    limiter = new Bottleneck({
      id: `sync_repo_to_handout:${key}:${Deno.env.get("GITHUB_APP_ID") || ""}`,
      reservoir: 10,
      reservoirRefreshAmount: 10,
      reservoirRefreshInterval: 60_000
    });
  }
  syncLimiters.set(key, limiter);
  return limiter;
}

/**
 * Detect if a file is binary based on its extension/path
 */
function isBinaryPath(path: string): boolean {
  const binaryExtensions = [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".bmp",
    ".ico",
    ".pdf",
    ".zip",
    ".tar",
    ".gz",
    ".rar",
    ".7z",
    ".exe",
    ".dll",
    ".so",
    ".dylib",
    ".class",
    ".jar",
    ".war",
    ".ear",
    ".pyc",
    ".pyo",
    ".o",
    ".a",
    ".lib",
    ".woff",
    ".woff2",
    ".ttf",
    ".eot",
    ".otf",
    ".mp3",
    ".mp4",
    ".avi",
    ".mov",
    ".wmv",
    ".flv",
    ".webm",
    ".ogg",
    ".wav",
    ".flac"
  ];

  const lowerPath = path.toLowerCase();
  return binaryExtensions.some((ext) => lowerPath.endsWith(ext));
}

/**
 * True when a unified diff removes all content and adds nothing (`@@ -1,N +0,0 @@`).
 * GitHub sometimes emits this for a handout file deletion while still listing the
 * change as "modified" rather than "removed".
 */
function patchDeletesEntireFile(patch: string): boolean {
  let sawZeroAddHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@") && /\+0,0(?:\s|$)/.test(line)) {
      sawZeroAddHunk = true;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return false;
    }
  }
  return sawZeroAddHunk;
}

function isGitHubNotFound(error: unknown): boolean {
  return (
    error !== null && typeof error === "object" && "status" in error && (error as { status: number }).status === 404
  );
}

/** 12 hours. Every sha this is called with is an immutable commit, so a hit cannot be stale. */
const TREE_CACHE_TTL_SECONDS = 43200;

/**
 * Above this, the tree is fetched every time instead of cached.
 *
 * Upstash rejects a request whose body exceeds its per-request limit, and `setex` sends the
 * whole value in one body. A repo big enough to produce a larger payload than this would fail
 * to cache it on every single sync, log the failure where nobody reads it, and pay the full
 * GitHub fetch anyway. Skipping it deliberately and reporting the skip beats attempting it and
 * losing it.
 */
const MAX_TREE_CACHE_BYTES = 512 * 1024;

/**
 * Trees being fetched right now, by cache key.
 *
 * The per-org limiter lets 20 syncs run at once inside one isolate, and on a handout push
 * every one of them wants the same two trees. Without this they all miss the same cold cache
 * key in the same instant and issue 20 identical full-tree requests, each of which can be
 * megabytes. Sharing the in-flight promise makes that one request. Entries are removed when
 * the fetch settles, so nothing here outlives the work it belongs to.
 */
const inFlightTrees = new Map<string, Promise<RepoTree>>();

/**
 * The recursive tree of a repo at a commit: every path, its kind, its blob sha, its size.
 *
 * One function and one cache key for what used to be two of each. The sizes the pre-flight
 * reads and the blob shas the student-work guard reads come from the same GitHub response,
 * and fetching it twice under two keys meant the handout tree at a given sha was pulled once
 * for its sizes and again, seconds later, for its shas.
 *
 * Blob shas are content addresses, so two repos hold byte-identical copies of a file exactly
 * when this map gives the same sha for that path. That equality is what `classifyStudentFile`
 * uses to tell a file the student has edited from one they have not touched since the last
 * sync.
 */
export async function getRepoTree(repoFullName: string, sha: string, scope?: Sentry.Scope): Promise<RepoTree> {
  const cacheKey = `github:tree:v1:${repoFullName}/${sha}`;
  const inFlight = inFlightTrees.get(cacheKey);
  if (inFlight) return await inFlight;

  const fetching = fetchRepoTree(repoFullName, sha, cacheKey, scope);
  inFlightTrees.set(cacheKey, fetching);
  try {
    return await fetching;
  } finally {
    inFlightTrees.delete(cacheKey);
  }
}

async function fetchRepoTree(
  repoFullName: string,
  sha: string,
  cacheKey: string,
  scope?: Sentry.Scope
): Promise<RepoTree> {
  const redis = getRedisClient();

  if (redis) {
    try {
      // createRedis()'s get() auto-JSON-parses values that round-trip as JSON (the
      // ioredis-compat proxy and the Upstash adapter both do), so a hit can arrive already
      // parsed. Only JSON.parse when it is still a raw string. Otherwise the old
      // `typeof === "string"` guard silently missed every hit.
      const cached = await redis.get(cacheKey);
      if (cached != null) {
        const decoded = decodeRepoTree(cached);
        if (decoded) return decoded;
      }
    } catch (error) {
      console.error("Redis cache read error (tree):", error);
    }
  }

  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }
  const [owner, repo] = repoFullName.split("/");

  const { data: tree } = await octokit.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
    owner,
    repo,
    tree_sha: sha,
    recursive: "true"
  });

  // GitHub truncates the tree response for very large repos (~100k entries / 7MB). Two
  // things degrade at once: the per-file size guard in syncRepositoryToHandout cannot see
  // sizes past the cutoff, and the student-work guard has to resolve the paths it needs one
  // at a time. Operators should know it is happening.
  if (tree.truncated) {
    console.warn(
      `Tree for ${repoFullName}@${sha} is truncated; sizes are incomplete and blob shas need per-file reads`
    );
    scope?.addBreadcrumb({
      message: `Tree truncated for ${repoFullName}@${sha}; falling back to per-file lookups and partial size metadata`,
      category: "sync",
      level: "warning"
    });
  }

  // Every entry, not just blobs. A tree or a submodule standing at a path the handout writes a
  // file to is the case a blob-only map cannot see: both sides read as absent, the path looks
  // like a new file, and writing the blob replaces the directory.
  const entries = new Map<string, RepoTreeEntry>();
  for (const item of tree.tree) {
    if (!item.path || !item.type) continue;
    if (item.type === "blob" || item.type === "tree" || item.type === "commit") {
      if (item.type === "blob" && !item.sha) continue;
      entries.set(item.path, {
        sha: item.sha ?? "",
        type: item.type,
        size: typeof item.size === "number" ? item.size : undefined
      });
    }
  }

  const result: RepoTree = { entries, truncated: !!tree.truncated };
  await cacheRepoTree(cacheKey, result, repoFullName, sha, scope);
  return result;
}

/**
 * Write a tree to Redis, and report it when that fails.
 *
 * Dropping the value silently produces a permanent cache miss that looks exactly like a cache
 * that is working: every sync pays the full tree fetch, and the only record is a console line
 * in an edge function's logs. Both the oversize case and a write request that fails are
 * reported where they can be seen.
 */
async function cacheRepoTree(
  cacheKey: string,
  tree: RepoTree,
  repoFullName: string,
  sha: string,
  scope?: Sentry.Scope
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const payload = encodeRepoTree(tree);
  if (payload.length > MAX_TREE_CACHE_BYTES) {
    const kb = Math.round(payload.length / 1024);
    console.warn(
      `Tree for ${repoFullName}@${sha} serializes to ~${kb}KB, over the ${Math.round(
        MAX_TREE_CACHE_BYTES / 1024
      )}KB cache limit; every sync of this repo will refetch it`
    );
    scope?.addBreadcrumb({
      message: `Tree for ${repoFullName}@${sha} too large to cache (~${kb}KB); refetching on every sync`,
      category: "sync",
      level: "warning"
    });
    scope?.setTag("tree_too_large_to_cache", "true");
    return;
  }

  try {
    await redis.setex(cacheKey, TREE_CACHE_TTL_SECONDS, payload);
  } catch (error) {
    console.error("Redis cache write error (tree):", error);
    scope?.addBreadcrumb({
      message: `Failed to cache tree for ${repoFullName}@${sha}: ${error}`,
      category: "sync",
      level: "warning"
    });
    Sentry.captureMessage(`Redis cache write failed for tree ${repoFullName}@${sha}: ${error}`, "warning");
  }
}

/**
 * A blob sha that can never equal a real one, for a path we could not read.
 *
 * `classifyStudentFile` compares shas, and an unequal sha classifies the path as the
 * student's, which leaves it alone. That is the conservative direction, and it is the only
 * honest answer for a path whose content we were not allowed to see.
 *
 * Distinct per call, so that an unreadable path on BOTH sides of the comparison does not
 * compare equal to itself and read as "unmodified", which would hand back the overwrite
 * this sentinel exists to prevent.
 */
let unreadableBlobCounter = 0;
function unreadableBlobSha(): string {
  unreadableBlobCounter += 1;
  return `unreadable-${unreadableBlobCounter}`;
}

/**
 * One path at one ref, for the paths a truncated tree could not answer.
 *
 * Returns undefined only when the path is genuinely absent: a 404.
 *
 * A blob too large for the Contents API's 1MB inline limit answers 403, not 404, and the
 * only repos that reach this fallback at all are ones large enough for GitHub to truncate
 * their recursive tree, which is exactly where such a blob lives. That case resolves to an
 * unreadable blob, never to "absent": a false "absent" would classify the file as unmodified
 * and re-enable the overwrite the guard exists to prevent, while an unreadable one classifies
 * it as the student's and leaves it alone.
 *
 * A TRANSIENT failure -- a rate limit, a 5xx, a reset connection -- still throws. Resolving
 * those to "the student's own work" would turn a retryable outage into a permanent,
 * `success: true` non-delivery that the queue never retries, and would tell the student
 * "you changed this file" about a file they never opened.
 *
 * An array response is a directory, which the Contents API returns instead of an object.
 * That is the collision case, so it is reported as a tree rather than discarded.
 */
async function fetchTreeEntryAtRef(
  repoFullName: string,
  path: string,
  ref: string,
  scope?: Sentry.Scope
): Promise<TreeEntry | undefined> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) throw new Error(`No octokit available for ${repoFullName}`);
  const [owner, repo] = repoFullName.split("/");
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner,
      repo,
      path,
      ref
    });
    if (Array.isArray(data)) return { sha: "", type: "tree" };
    const meta = data as { sha?: string; type?: string };
    if (!meta.sha) return { sha: unreadableBlobSha(), type: "blob" };
    if (meta.type === "dir") return { sha: meta.sha, type: "tree" };
    if (meta.type === "submodule") return { sha: meta.sha, type: "commit" };
    return { sha: meta.sha, type: "blob" };
  } catch (error) {
    if (isGitHubNotFound(error)) return undefined;
    if (!isBlobTooLargeForContentsApi(error)) throw error;
    scope?.addBreadcrumb({
      message: `${repoFullName} ${path} at ${ref} is too large to read through the Contents API; treating it as the student's own work`,
      category: "sync",
      level: "warning"
    });
    console.warn(`[sync] oversized path ${repoFullName} ${path}@${ref}: ${error}`);
    return { sha: unreadableBlobSha(), type: "blob" };
  }
}

/**
 * A 403 that means "this blob is bigger than the Contents API will inline", as opposed to a
 * 403 that means "slow down" or "you are not allowed in".
 *
 * The distinction decides whether the caller may treat the path as unreadable-and-therefore
 * the-student's, or has to fail and be retried. GitHub's oversize response says so in the
 * message; its secondary rate limit and permission failures say something else.
 */
function isBlobTooLargeForContentsApi(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (!("status" in error) || (error as { status: number }).status !== 403) return false;
  const message = String((error as { message?: unknown }).message ?? "").toLowerCase();
  if (message.includes("rate limit") || message.includes("abuse")) return false;
  return message.includes("too large") || message.includes("up to 1 mb") || message.includes("larger than");
}

/**
 * How many per-path Contents reads one sync may make while resolving a truncated tree.
 *
 * There has to be a number. The work grows with the size of the handout update times the
 * depth of its paths, it runs inside a sync holding one of 20 per-org slots, and pgmq
 * redelivers the message if the batch outlives the visibility timeout, so an uncapped run
 * does not eventually finish, it runs again from the start, forever.
 *
 * Sized against that timeout rather than picked: `DEFAULT_VISIBILITY_TIMEOUT_SECONDS` is
 * 300 and a whole batch of jobs shares it, so this phase may have about 60 seconds of it.
 * At `TRUNCATED_TREE_LOOKUP_CONCURRENCY` in flight and roughly 200ms a call, that is around
 * 2400 reads. A repo that needs more is not slow, it is the wrong shape: a committed
 * `node_modules` and a handout-wide update. It needs an instructor, not a longer wait.
 *
 * Stopping at a stated limit and reporting it is the honest failure. Classifying the paths
 * we ran out of budget for as "not the student's" is the dishonest one, and it overwrites
 * their work.
 */
const MAX_TRUNCATED_TREE_LOOKUPS = 2400;

/** How many of those reads run at once. Reads only, so GitHub's advice on concurrent writes does not bind. */
const TRUNCATED_TREE_LOOKUP_CONCURRENCY = 8;

function assertLookupBudget(lookups: number, repoFullName: string, templateRepo: string, scope?: Sentry.Scope): void {
  if (lookups <= MAX_TRUNCATED_TREE_LOOKUPS) return;
  scope?.setTag("truncated_tree_lookups", String(lookups));
  throw new SyncTreeTooLargeError(repoFullName, templateRepo, lookups, MAX_TRUNCATED_TREE_LOOKUPS);
}

/**
 * Resolve paths a few at a time, handing each answer to `record` as it arrives.
 *
 * A plain `Promise.all` over every path would open as many requests as there are paths,
 * which on the repos that reach this fallback is thousands. Workers pull from a shared
 * cursor, so a slow path delays only itself.
 */
async function resolvePathsInParallel(
  paths: readonly string[],
  fetchOne: (path: string) => Promise<TreeEntry | undefined>,
  record: (path: string, entry: TreeEntry) => void
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < paths.length) {
      const path = paths[next++];
      const entry = await fetchOne(path);
      if (entry) record(path, entry);
    }
  };
  const workers = Math.min(TRUNCATED_TREE_LOOKUP_CONCURRENCY, paths.length);
  await Promise.all(Array.from({ length: workers }, worker));
}

/**
 * The commit to read the student's repo at, for a row that records no baseline.
 *
 * `synced_repo_sha` is the repo-side half of a matched pair: the state the LAST sync left
 * behind, which is what makes "this file differs from the baseline" mean "the student wrote
 * it". Rows exist without one: repositories are inserted with `synced_handout_sha` set and
 * `synced_repo_sha` left null. Something has to stand in.
 *
 * The repository's current head is that stand-in, and it is NOT the repo's first commit. The
 * root commit was the previous fallback and it compared two unrelated trees, so nearly every
 * changed file came back `content_differs` and repositories where the student had changed
 * nothing reported themselves blocked. Reading the head instead makes the comparison the one
 * the baseline approximates in the first place: repository content against the handout at
 * `fromSha`. It errs the safe way: a file the student edited long ago still differs from the
 * handout, so it still reads as theirs.
 *
 * Undefined when there is no head to read, which the E2E stub and the suffixed E2E repo names
 * both produce. Callers must treat that as "nothing is known about this repository", never as
 * "nothing in it is the student's".
 */
export async function resolveSyncBaselineSha(
  repoFullName: string,
  syncedRepoSha: string | null,
  scope?: Sentry.Scope
): Promise<string | undefined> {
  if (syncedRepoSha) return syncedRepoSha;
  const head = await github.getDefaultBranchHeadSha(repoFullName, scope);
  scope?.setTag("sync_baseline_from_head", head ? "true" : "unavailable");
  return head;
}

/**
 * Which of `paths` the student has made their own since the last sync.
 *
 * Compares the student's repo at `syncedRepoSha` against the handout at `fromSha`, one
 * recursive tree each, and falls back to per-file lookups only for paths a truncated tree
 * left unanswered.
 *
 * `fromSha` null means there is no previous sync. The branch base is then the repo's
 * pristine starting state, nothing in it can be the student's own work yet, and the map is
 * empty.
 *
 * `syncedRepoSha` null means the row records no baseline. There is then no such thing as
 * "what the last sync left behind", so the question changes from "has this file moved since
 * we wrote it?" to "does this file match the handout it was written from?" That is the
 * repository as it stands now, against the handout at `fromSha`, resolved by
 * `resolveSyncBaselineSha`. A file that matches is one nobody has touched; anything else is
 * the student's and is left alone.
 *
 * A caller that already resolved a baseline should pass it rather than null, so the head is
 * read once: the classification and the branch it is written onto have to be the same
 * commit. Reading the head twice at two moments lets a push arrive between them, and if the
 * branch base is the newer of the two, the student's commit is inside the base while the
 * classification says the path is untouched, which is an overwrite.
 *
 * When no baseline can be resolved at all, every path is reported as the student's. That is
 * the only honest answer for a repository we cannot see, and the failure direction is a
 * blocked sync rather than a silent overwrite.
 */
export async function findStudentModifiedFiles(
  repoFullName: string,
  syncedRepoSha: string | null,
  templateRepo: string,
  fromSha: string | null,
  paths: readonly string[],
  scope?: Sentry.Scope
): Promise<Map<string, UnresolvedReason>> {
  const modified = new Map<string, UnresolvedReason>();
  if (!fromSha || paths.length === 0) return modified;

  const baselineSha = await resolveSyncBaselineSha(repoFullName, syncedRepoSha, scope);
  if (!baselineSha) {
    scope?.setTag("sync_baseline_unavailable", "true");
    return new Map(paths.map((path) => [path, "content_differs" as UnresolvedReason]));
  }

  const [student, handout] = await Promise.all([
    getRepoTree(repoFullName, baselineSha, scope),
    getRepoTree(templateRepo, fromSha, scope)
  ]);

  const studentEntries = new Map<string, TreeEntry>(student.entries);
  const handoutEntries = new Map<string, TreeEntry>(handout.entries);

  // A truncated tree cannot answer for a path it omitted, and the ancestors matter as much
  // as the paths themselves: a file standing where a directory has to go is the inverse of
  // the directory collision, and is just as invisible to a map that never listed it.
  const studentPathsOfInterest = student.truncated
    ? Array.from(new Set(paths.flatMap((path) => [path, ...ancestorPaths(path)])))
    : paths;

  const studentLookups = pathsNeedingBlobLookup(studentEntries, student.truncated, studentPathsOfInterest);
  const handoutLookups = pathsNeedingBlobLookup(handoutEntries, handout.truncated, paths);
  assertLookupBudget(studentLookups.length + handoutLookups.length, repoFullName, templateRepo, scope);

  // Both sides at once, and several paths at a time within each. These are reads of two
  // different repos with no ordering between them, and the sequential version was the
  // slowest thing in the sync: a 300-file update at depth four expands to more than 1200
  // lookups on the student side alone, which at a couple of hundred milliseconds each is
  // minutes of wall clock spent holding one of the 20 per-org sync slots, and long enough
  // to overrun the pgmq visibility timeout, which redelivers the message and runs the whole
  // sync a second time.
  await Promise.all([
    resolvePathsInParallel(
      studentLookups,
      (path) => fetchTreeEntryAtRef(repoFullName, path, baselineSha, scope),
      (path, entry) => studentEntries.set(path, entry)
    ),
    resolvePathsInParallel(
      handoutLookups,
      (path) => fetchTreeEntryAtRef(templateRepo, path, fromSha, scope),
      (path, entry) => handoutEntries.set(path, entry)
    )
  ]);

  for (const path of paths) {
    const verdict = classifyStudentFile(studentEntries.get(path), handoutEntries.get(path));
    if (verdict !== "unmodified") {
      modified.set(path, verdict);
      continue;
    }
    // The path itself is clear. It can still be unreachable, when a file of the student's
    // stands where one of its parent directories has to go.
    if (findBlockingAncestor(path, studentEntries)) {
      modified.set(path, "path_blocked_in_your_repo");
    }
  }
  return modified;
}

/**
 * Get all changed files between two commits in a template repository.
 * Returns metadata + patches only; binary file content is fetched lazily during
 * `createBranchAndCommit`. `size` is populated for every entry (looked up from
 * the recursive tree) so callers can make size-aware decisions without touching
 * any blob content.
 *
 * Results are cached in Redis with a 12-hour TTL.
 */
export async function getChangedFiles(
  templateRepo: string,
  fromSha: string | null,
  toSha: string,
  scope?: Sentry.Scope
): Promise<FileChange[]> {
  // Try to get from cache first
  const cacheKey = `github:changed-files:${templateRepo}/${fromSha || "initial"}/${toSha}`;
  const redis = getRedisClient();

  if (redis) {
    try {
      // get() may return an already-parsed value (see tree-sizes note above);
      // only JSON.parse a raw string so REDIS_URL deploys actually hit the cache.
      const cached = await redis.get(cacheKey);
      if (cached != null) {
        scope?.addBreadcrumb({
          message: `Cache hit for changed files: ${cacheKey}`,
          category: "cache",
          level: "info"
        });
        return (typeof cached === "string" ? JSON.parse(cached) : cached) as FileChange[];
      }
    } catch (error) {
      console.error("Redis cache read error:", error);
      // Continue to fetch from GitHub if cache fails
    }
  }

  scope?.addBreadcrumb({
    message: `Cache miss for changed files: ${cacheKey}`,
    category: "cache",
    level: "info"
  });

  const octokit = await github.getOctoKit(templateRepo, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${templateRepo}`);
  }

  const [owner, repo] = templateRepo.split("/");

  const fileChanges: FileChange[] = [];

  if (!fromSha) {
    // Initial sync — record metadata for every blob in the template tree.
    // Content is intentionally NOT fetched here: doing so on a large handout
    // (e.g. a CSV dataset or many PDFs) easily exceeds Edge Function memory.
    // `createBranchAndCommit` fetches each blob lazily and discards it after use.
    //
    // Through `getRepoTree` rather than a request of its own: this is the same listing the
    // compare path reads for its sizes and the student-work guard reads for its blob shas,
    // so sharing it means one fetch, one cache entry, and a truncation warning this path
    // used to skip.
    const { entries } = await getRepoTree(templateRepo, toSha, scope);

    for (const [path, entry] of entries) {
      if (entry.type === "blob" && entry.sha) {
        fileChanges.push({
          path,
          sha: entry.sha,
          isBinary: isBinaryPath(path),
          status: "added",
          size: entry.size
        });
      }
    }
  } else {
    // Compare commits — return metadata + patches only. Binary content is fetched
    // lazily during `createBranchAndCommit` to keep peak memory low.
    const { data: comparison } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
      owner,
      repo,
      basehead: `${fromSha}...${toSha}`
    });

    // The `compare` endpoint doesn't return per-file sizes, but we want sizes
    // populated on every FileChange so callers can make size-aware concurrency
    // decisions without downloading any blobs. Pull them from the recursive tree at
    // toSha: one API call, Redis-cached, and the same listing the student-work guard
    // reads, so the two share a fetch rather than making one each.
    let treeAtToSha: RepoTree | undefined;
    try {
      treeAtToSha = await getRepoTree(templateRepo, toSha, scope);
    } catch (error) {
      // Non-fatal: if the tree fetch fails we just don't have sizes; the size guard
      // inside createBranchAndCommit still applies during the lazy blob fetch.
      scope?.addBreadcrumb({
        message: `Failed to fetch tree sizes for ${templateRepo}@${toSha}: ${error}`,
        category: "sync",
        level: "warning"
      });
    }

    for (const file of comparison.files || []) {
      if (file.status === "removed") {
        fileChanges.push({
          path: file.filename,
          status: "removed"
        });
        continue;
      }

      // Handle renamed files: delete the old path, then add the new path
      if (file.status === "renamed" && file.previous_filename) {
        fileChanges.push({
          path: file.previous_filename,
          status: "removed"
        });
        // Continue to add the new filename entry below
      }

      const isBinary = !file.patch || isBinaryPath(file.filename);
      const sizeAtToSha = treeAtToSha?.entries.get(file.filename)?.size;

      if (isBinary) {
        if (!file.sha) {
          throw new Error(`No SHA available for file ${file.filename}`);
        }
        fileChanges.push({
          path: file.filename,
          sha: file.sha,
          isBinary: true,
          status: file.status,
          size: sizeAtToSha
        });
      } else {
        fileChanges.push({
          path: file.filename,
          sha: file.sha || undefined,
          patch: file.patch,
          isBinary: false,
          status: file.status,
          previous_filename: file.previous_filename,
          size: sizeAtToSha
        });
      }
    }
  }

  // Cache the result with 12-hour TTL (43200 seconds)
  if (redis) {
    try {
      await redis.setex(cacheKey, 43200, JSON.stringify(fileChanges));
      scope?.addBreadcrumb({
        message: `Cached changed files: ${cacheKey}`,
        category: "cache",
        level: "info"
      });
    } catch (error) {
      console.error("Redis cache write error:", error);
      // Continue even if caching fails
    }
  }

  return fileChanges;
}

/**
 * Copy a single binary blob from a template repo into a student repo while keeping
 * peak memory as low as the runtime allows.
 *
 * The naive Octokit path (GET → templateBlob.content already base64 ~1.33×; POST →
 * Octokit JSON.stringify materializes another full base64 string) peaks at ~2× the
 * base64 size, which OOMs the Edge Function for files in the tens of MB.
 *
 * This implementation:
 *  1. Downloads RAW bytes (Accept: application/vnd.github.v3.raw) — saves the 33%
 *     base64 inflation on the wire and in memory.
 *  2. Base64-encodes the raw bytes once via @std/encoding/base64 (single allocation).
 *  3. Drops the raw buffer reference before the upload to give V8 a chance to GC it
 *     while the upload streams.
 *  4. Uploads via a `Blob` multi-chunk body so the JSON wrapper isn't materialized as
 *     one giant intermediate string — fetch streams the blob to the network.
 *
 * Net peak memory ≈ raw + base64 ≈ 2.33 × X (vs ~3 × X with Octokit JSON path).
 *
 * @returns The student-repo blob SHA suitable for use in a tree entry.
 */
async function copyBlobBetweenRepos(
  templateRepo: string,
  templateBlobSha: string,
  studentRepoFullName: string,
  filePath: string,
  scope?: Sentry.Scope
): Promise<string> {
  const templateOctokit = await github.getOctoKit(templateRepo, scope);
  const studentOctokit = await github.getOctoKit(studentRepoFullName, scope);
  if (!templateOctokit) throw new Error(`No octokit available for template repo ${templateRepo}`);
  if (!studentOctokit) throw new Error(`No octokit available for student repo ${studentRepoFullName}`);

  const [tOwner, tRepo] = templateRepo.split("/");
  const [sOwner, sRepo] = studentRepoFullName.split("/");

  // Resolve fresh GitHub App installation tokens via Octokit's auth strategy.
  // We can't use `octokit.request.endpoint(...)` directly because that returns
  // the *unauthenticated* request descriptor — auth is normally injected by
  // Octokit's request hooks at fire time. For raw `fetch` we have to add it
  // ourselves.
  const tAuth = (await templateOctokit.auth({ type: "installation" })) as { token: string };
  const sAuth = (await studentOctokit.auth({ type: "installation" })) as { token: string };

  const commonHeaders: Record<string, string> = {
    "User-Agent": "pawtograder-sync",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  // 1) Download raw bytes from the template (Accept: vnd.github.v3.raw) — saves
  //    the 33% base64 inflation that the JSON-wrapped blob endpoint would force.
  const getUrl = `https://api.github.com/repos/${encodeURIComponent(tOwner)}/${encodeURIComponent(
    tRepo
  )}/git/blobs/${encodeURIComponent(templateBlobSha)}`;
  const getResponse = await fetch(getUrl, {
    method: "GET",
    headers: {
      ...commonHeaders,
      Accept: "application/vnd.github.v3.raw",
      Authorization: `token ${tAuth.token}`
    }
  });
  if (!getResponse.ok) {
    const body = await getResponse.text().catch(() => "");
    throw new Error(
      `Failed to fetch raw blob ${templateBlobSha} for ${filePath} from ${templateRepo}: ` +
        `${getResponse.status} ${getResponse.statusText}: ${body.slice(0, 200)}`
    );
  }

  // Defense-in-depth: enforce the per-file cap here using Content-Length, in case the
  // pre-flight in syncRepositoryToHandout missed this file (truncated tree, direct
  // caller bypassing the entry point, etc.). Failing here before reading the body
  // avoids materializing a too-large buffer into memory.
  const contentLengthHeader = getResponse.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (Number.isFinite(contentLength) && contentLength > MAX_SYNC_FILE_BYTES) {
    // Drain the body so the connection can be reused / released.
    await getResponse.body?.cancel().catch(() => undefined);
    const mb = (contentLength / (1024 * 1024)).toFixed(1);
    const limitMb = (MAX_SYNC_FILE_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(
      `File '${filePath}' raw blob is ${mb}MB which exceeds the per-file sync limit of ${limitMb}MB. ` +
        `Use Git LFS, host the data out-of-band, or remove it from the handout repository.`
    );
  }

  // 2) Encode to base64 once. We do this in an inner closure so the raw buffer
  //    reference is dropped before the upload starts, giving V8 the opportunity
  //    to GC it under memory pressure during the POST.
  const base64: string = await (async () => {
    const ab = await getResponse.arrayBuffer();
    const u8 = new Uint8Array(ab);
    return encodeBase64(u8);
  })();

  scope?.addBreadcrumb({
    message: `Copied ${filePath} via raw fetch (${base64.length} bytes base64)`,
    category: "sync",
    level: "debug"
  });

  // 3) Upload via a multi-chunk Blob body so the JSON wrapper isn't concatenated
  //    into one giant intermediate string. `fetch` streams the Blob without
  //    materializing it. Saves another full base64-string allocation that
  //    Octokit's JSON.stringify path would otherwise create.
  const postUrl = `https://api.github.com/repos/${encodeURIComponent(sOwner)}/${encodeURIComponent(sRepo)}/git/blobs`;
  const body = new Blob(['{"content":"', base64, '","encoding":"base64"}'], {
    type: "application/json"
  });
  const postResponse = await fetch(postUrl, {
    method: "POST",
    headers: {
      ...commonHeaders,
      Accept: "application/vnd.github+json",
      Authorization: `token ${sAuth.token}`,
      "Content-Type": "application/json"
    },
    body
  });
  if (!postResponse.ok) {
    const errBody = await postResponse.text().catch(() => "");
    throw new Error(
      `Failed to upload blob for ${filePath} to ${studentRepoFullName}: ` +
        `${postResponse.status} ${postResponse.statusText}: ${errBody.slice(0, 200)}`
    );
  }
  const json = (await postResponse.json()) as { sha?: string };
  if (!json.sha) {
    throw new Error(`Blob upload for ${filePath} returned no SHA`);
  }
  return json.sha;
}

type ContentsFileMeta = {
  sha?: string;
  content?: string;
  download_url?: string;
  encoding?: string;
};

/**
 * Fetch decoded text from a git blob SHA via the raw blob endpoint.
 * Used when the Contents API omits inline content (files >1MB) or for compare SHAs.
 */
async function fetchTextBlobFromRepo(
  repoFullName: string,
  blobSha: string,
  filePath: string,
  scope?: Sentry.Scope
): Promise<GitHubTextFile> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) throw new Error(`No octokit available for ${repoFullName}`);
  const [owner, repo] = repoFullName.split("/");
  const auth = (await octokit.auth({ type: "installation" })) as { token: string };
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo
  )}/git/blobs/${encodeURIComponent(blobSha)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github.v3.raw",
      Authorization: `token ${auth.token}`,
      "User-Agent": "pawtograder-sync",
      "X-GitHub-Api-Version": "2022-11-28"
    }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to fetch blob ${blobSha} for ${filePath} from ${repoFullName}: ${response.status}: ${body.slice(0, 200)}`
    );
  }
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  if (Number.isFinite(contentLength) && contentLength > MAX_SYNC_FILE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    const mb = (contentLength / (1024 * 1024)).toFixed(1);
    const limitMb = (MAX_SYNC_FILE_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`File '${filePath}' is ${mb}MB which exceeds the per-file sync limit of ${limitMb}MB`);
  }
  return decodeGitHubTextBytes(new Uint8Array(await response.arrayBuffer()));
}

/**
 * Fetch a text file's content at a specific ref. Uses inline Contents API data for
 * small files and falls back to the git blob API when GitHub omits content (>1MB).
 */
async function fetchTextFileAtRef(
  repoFullName: string,
  path: string,
  ref: string,
  scope?: Sentry.Scope
): Promise<GitHubTextFile & { sha?: string }> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) throw new Error(`No octokit available for ${repoFullName}`);
  const [owner, repo] = repoFullName.split("/");

  const { data: fileData } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
    owner,
    repo,
    path,
    ref
  });

  if (Array.isArray(fileData)) {
    throw new Error(`Path '${path}' is a directory, not a file`);
  }

  const meta = fileData as ContentsFileMeta;

  if (meta.encoding === "base64" && typeof meta.content === "string") {
    return { ...decodeGitHubBase64Text(meta.content), sha: meta.sha };
  }

  if (meta.sha) {
    return {
      ...(await fetchTextBlobFromRepo(repoFullName, meta.sha, path, scope)),
      sha: meta.sha
    };
  }

  if (meta.download_url) {
    const auth = (await octokit.auth({ type: "installation" })) as { token: string };
    const response = await fetch(meta.download_url, {
      headers: { Authorization: `token ${auth.token}`, "User-Agent": "pawtograder-sync" }
    });
    if (!response.ok) {
      throw new Error(`Failed to download '${path}' from ${repoFullName}: ${response.status}`);
    }
    return decodeGitHubTextBytes(new Uint8Array(await response.arrayBuffer()));
  }

  throw new Error(`No content available for '${path}' at ${ref} in ${repoFullName}`);
}

/**
 * The commit a branch currently points at.
 *
 * Throws rather than returning undefined when the read request fails: every caller here is
 * guarding a destructive ref update, and `github.resolveRef` hides errors, which would turn
 * the guard into a no-op.
 */
async function readBranchHeadSha(repoFullName: string, branchName: string, scope?: Sentry.Scope): Promise<string> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) throw new Error(`No octokit available for ${repoFullName}`);
  const [owner, repo] = repoFullName.split("/");
  const { data: ref } = await octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner,
    repo,
    ref: `heads/${branchName}`
  });
  return ref.object.sha;
}

/**
 * Re-read a branch and fail unless it is still where the caller last saw it.
 *
 * Used immediately before a destructive ref update, so the validation that authorized it is
 * as fresh as it can be made without a compare-and-swap.
 */
async function assertBranchStillAt(
  repoFullName: string,
  branchName: string,
  expectedSha: string,
  scope?: Sentry.Scope
): Promise<void> {
  const actualSha = await readBranchHeadSha(repoFullName, branchName, scope);
  if (actualSha !== expectedSha) {
    scope?.setTag("sync_branch_moved_during_validation", "true");
    throw new SyncBranchMovedError(repoFullName, branchName, expectedSha, actualSha);
  }
}

/**
 * The fields of a FileChange the merge decision branches on, in the shape
 * `decideFileAction` takes. Built in one place so the size gate and the commit path cannot
 * describe the same file differently.
 */
function shapeOf(file: FileChange): ChangedFileShape {
  return {
    path: file.path,
    status: file.status,
    isBinary: file.isBinary,
    hasPatch: !!file.patch,
    patchDeletesFile: !!file.patch && patchDeletesEntireFile(file.patch)
  };
}

/**
 * A sync failure that belongs to ONE repository, and that retrying this job cannot change.
 *
 * The distinction this draws is whose problem the failure is, rather than whether retrying
 * could help. The worker's generic failure path treats an error as evidence that GitHub
 * itself is failing: it opens a 30-second circuit breaker scoped to `<org>:sync_repo_to_handout`
 * and feeds the counter that trips an 8-hour org-wide pause. That is the right response to a
 * rate limit or an outage, and the wrong one to a single student's branch, where it stops
 * handout delivery for an entire course over one repo: six times over, once per retry,
 * before the job dead-letters.
 *
 * Deliberately NOT `NonRetryableGitHubError`: that class is terminal in the same way, but
 * the worker pairs it with writing `creation_error` onto the repository row, which is the
 * field for a repo that could not be created and would put a creation failure in front of an
 * instructor whose repo was created months ago. `reason` is a stable machine-readable code
 * so the worker can record the failure against the sync and decide its own policy per case
 * without parsing a message.
 */
export class TerminalSyncError extends Error {
  constructor(
    message: string,
    /** Stable snake_case code identifying the case, for the caller to record and branch on. */
    readonly reason: string
  ) {
    super(message);
    this.name = "TerminalSyncError";
  }
}

/**
 * Thrown when resolving a truncated tree would cost more per-path reads than one sync may
 * make. See `MAX_TRUNCATED_TREE_LOOKUPS`.
 *
 * Terminal because the next attempt faces the same repo, the same update and the same
 * budget. A later, smaller update may well fit, which is why this is reported against the
 * sync rather than parked on the repository row.
 */
export class SyncTreeTooLargeError extends TerminalSyncError {
  constructor(
    readonly repoFullName: string,
    readonly templateRepo: string,
    readonly lookupsNeeded: number,
    readonly budget: number
  ) {
    super(
      `Cannot verify ${repoFullName} against ${templateRepo} safely: GitHub truncated the file listing for at ` +
        `least one of them, and answering this update would take ${lookupsNeeded} per-file reads against a limit ` +
        `of ${budget}. Splitting the handout change into smaller updates, or removing large generated ` +
        `directories from the repository, brings it back under the limit.`,
      "sync_tree_too_large"
    );
    this.name = "SyncTreeTooLargeError";
  }
}

/**
 * Thrown when a repository records no baseline and its head cannot be read.
 *
 * There is nothing to branch from and nothing to classify against, so every outcome the sync
 * could report would be a guess. Terminal because the next attempt reads the same repository
 * the same way: an empty repository, a revoked installation, or a name GitHub does not have.
 */
export class SyncBaselineUnavailableError extends TerminalSyncError {
  constructor(readonly repoFullName: string) {
    super(
      `Cannot sync ${repoFullName}: it records no previous sync and its default branch head could not be read, ` +
        `so there is no commit to build the update on. Check that the repository exists, has at least one commit, ` +
        `and is still granted to the GitHub App.`,
      "sync_baseline_unavailable"
    );
    this.name = "SyncBaselineUnavailableError";
  }
}

/**
 * Thrown when a sync branch moves between being validated and being reset.
 *
 * Terminal for THIS job even though the underlying condition is transient: the validation
 * that authorized the reset is stale, and the only safe thing to do with a stale
 * authorization is discard it. The next handout push, or an instructor pressing Sync, gets a
 * fresh one, which is a better answer than six retries against a branch someone is actively
 * pushing to.
 */
export class SyncBranchMovedError extends TerminalSyncError {
  constructor(
    readonly repoFullName: string,
    readonly branchName: string,
    readonly expectedSha: string,
    readonly actualSha: string
  ) {
    super(
      `Refusing to reset ${repoFullName} branch '${branchName}': it moved from ${expectedSha.substring(0, 7)} ` +
        `to ${actualSha.substring(0, 7)} while being checked, so someone is pushing to it right now. ` +
        `Retry the sync once the branch is settled.`,
      "sync_branch_moved"
    );
    this.name = "SyncBranchMovedError";
  }
}

/**
 * Thrown when a sync branch carries commits the sync did not write.
 *
 * The student is doing exactly what the pull request asks of them -- resolving the update by
 * hand -- so this is the one failure here that is a person at work rather than anything
 * wrong. Retrying cannot change the answer: the branch still carries their commits on the
 * next attempt and every attempt after that, until they merge the PR, close it, or delete
 * the branch.
 */
export class SyncBranchNotOursError extends TerminalSyncError {
  constructor(
    readonly repoFullName: string,
    readonly branchName: string,
    readonly foreignSubjects: string[]
  ) {
    super(
      `Refusing to reset ${repoFullName} branch '${branchName}': it carries ${foreignSubjects.length} ` +
        `commit(s) this sync did not write, which is someone resolving this update by hand. ` +
        `First commit subject: ${JSON.stringify(foreignSubjects[0] ?? "")}. ` +
        `Merge or close the open pull request, or delete the branch, then sync again.`,
      "sync_branch_not_ours"
    );
    this.name = "SyncBranchNotOursError";
  }
}

/**
 * Refuse to reset a sync branch that someone else has pushed to.
 *
 * The branch is force-updated when it already exists, which throws away everything on it.
 * That is harmless while every commit ahead of the base is one of ours, and it deletes a
 * student's conflict resolution as soon as it is not. Commits we write carry the sync
 * subject line, so anything else on the branch was put there deliberately.
 *
 * A comparison we cannot make is treated as unsafe rather than assumed fine: resetting
 * because the read request failed is the exact outcome this is here to prevent.
 */
async function assertSyncBranchSafeToReset(
  repoFullName: string,
  branchName: string,
  baseSha: string,
  scope?: Sentry.Scope
): Promise<string> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) throw new Error(`No octokit available for ${repoFullName}`);
  const [owner, repo] = repoFullName.split("/");

  // Read the ref FIRST and compare against that exact sha, rather than against the branch
  // name. Comparing by name and then reconstructing the head from the compare payload gets
  // the head wrong on a branch more than 250 commits ahead, because GitHub caps
  // `comparison.commits` at 250 and the last entry is then a mid-branch commit; the
  // `assertBranchStillAt` that follows would compare the real head against that and report
  // a push nobody made. Reading it once gives the reset one unambiguous sha to be
  // authorized against.
  const branchHead = await readBranchHeadSha(repoFullName, branchName, scope);

  const { data: comparison } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner,
    repo,
    basehead: `${baseSha}...${branchHead}`
  });

  // The same 250-commit cap, from the other side: a branch that far ahead is one we cannot
  // read in full, and a check we cannot make is not a check that passed.
  const totalCommits = comparison.total_commits ?? comparison.commits?.length ?? 0;
  const readCommits = comparison.commits?.length ?? 0;
  if (totalCommits > readCommits) {
    scope?.setTag("sync_branch_commits_truncated", "true");
    throw new SyncBranchNotOursError(repoFullName, branchName, [
      `${totalCommits} commit(s) ahead of the base, of which GitHub returned only ${readCommits}; ` +
        `the rest cannot be inspected`
    ]);
  }

  // Subject AND authorship. The subject alone is a string anyone can type, and this repo
  // has already lost work to exactly that kind of over-matching (see the comments on
  // SYNC_COMMIT_SUBJECT_RE in handoutSyncPush.ts). `author` and `committer` are the GitHub
  // accounts GitHub attributed the commit to; either is null when it could not attribute it
  // at all. See `isOurSyncCommit` for why both the type and the login matter.
  const commits: SyncBranchCommit[] = (comparison.commits ?? []).map((c) => ({
    subject: (c.commit?.message ?? "").split("\n")[0],
    authorType: c.author?.type,
    committerLogin: c.committer?.login,
    committerType: c.committer?.type,
    verified: c.commit?.verification?.verified
  }));
  if (isSyncBranchSafeToReset(commits)) return branchHead;

  const foreign = commits
    .filter((commit) => !isOurSyncCommit(commit))
    .map(
      (commit) =>
        `${commit.subject} (author type: ${commit.authorType ?? "unattributed"}, ` +
        `committer: ${commit.committerLogin ?? "unattributed"} [${commit.committerType ?? "unattributed"}], ` +
        `verified: ${commit.verified === true})`
    );
  scope?.setTag("sync_branch_foreign_commits", String(foreign.length));
  throw new SyncBranchNotOursError(repoFullName, branchName, foreign);
}

/**
 * Create a branch and commit changes to a target repository
 * For text files with patches, applies the patch to the content at baseSha
 * For binary files or files with full content, uses the provided content
 *
 * Files the student has made their own since the last sync are left exactly as they are
 * at `baseSha`: no tree entry is emitted for them, so the branch inherits their version
 * from `base_tree` and the merge cannot overwrite it. Every such file is returned so the
 * caller can hold the PR open and tell the student which changes are theirs to apply.
 *
 * @param templateRepo - Optional template repo name for fallback when patch fails
 * @param templateSha - Optional template SHA to fetch content from when patch fails
 * @param studentModified - Paths the student has made their own, from
 *                          `findStudentModifiedFiles`. Computed by the caller because the
 *                          size pre-flight has to see it too, and computing it twice would
 *                          be two more tree reads for the same answer.
 * @returns `unresolved`, the files left to the student, and `committed`, false when every
 *          file was left to them and there was nothing to commit at all.
 */
export async function createBranchAndCommit(
  repoFullName: string,
  branchName: string,
  baseSha: string,
  files: FileChange[],
  commitMessage: string,
  scope?: Sentry.Scope,
  templateRepo?: string,
  templateSha?: string,
  studentModified: Map<string, UnresolvedReason> = new Map()
): Promise<{ unresolved: UnresolvedFile[]; committed: boolean }> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");
  scope?.setTag("owner", owner);
  scope?.setTag("repo", repo);
  scope?.setTag("base_sha", baseSha);
  scope?.setTag("branch_name", branchName);
  scope?.setTag("commit_message", commitMessage);

  console.log("createBranchAndCommit", repoFullName, branchName, baseSha, files.length, "files");

  // Create or update branch - handle various edge cases robustly
  let newRef: { ref: string };
  try {
    // First, try to create the branch
    const createResult = await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });
    newRef = createResult.data;
  } catch (createError: unknown) {
    const errorMessage = createError instanceof Error ? createError.message : String(createError);

    // If branch already exists, force-update it to the base SHA
    if (errorMessage.includes("Reference already exists")) {
      // The branch is about to be discarded. That is ours to do while everything on it is
      // ours, and is the student's conflict resolution being deleted as soon as it is not,
      // so check who wrote the commits ahead of the base before touching it.
      const validatedHead = await assertSyncBranchSafeToReset(repoFullName, branchName, baseSha, scope);
      // ...and confirm the branch is still where it was when that answer was computed. A
      // push between the two invalidates it, and this is a destructive write.
      //
      // This NARROWS the window, it does not close it: a push arriving between this check and
      // the ref update below is still lost. REST has no expected-head parameter on a ref update,
      // so closing it properly means GraphQL updateRefs with beforeOid, which is a compare
      // and swap. That is the right fix and it is not free, so it is recorded here rather
      // than implied to be done.
      await assertBranchStillAt(repoFullName, branchName, validatedHead, scope);

      scope?.addBreadcrumb({
        message: `Branch ${branchName} already exists, force-updating to ${baseSha}`,
        category: "git",
        level: "info"
      });

      try {
        const updateResult = await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
          owner,
          repo,
          ref: `heads/${branchName}`,
          sha: baseSha,
          force: true // Force update even if not a fast-forward
        });
        newRef = updateResult.data;
      } catch (updateError: unknown) {
        // If force update fails, try delete then create
        const updateErrorMsg = updateError instanceof Error ? updateError.message : String(updateError);
        scope?.addBreadcrumb({
          message: `Force update failed: ${updateErrorMsg}, trying delete+create`,
          category: "git",
          level: "warning"
        });

        // Deleting the ref is more destructive than the update that just failed, and one
        // reason that update fails is the branch having moved. Re-check before deleting
        // rather than treating the failed update as permission to try something more
        // destructive.
        await assertBranchStillAt(repoFullName, branchName, validatedHead, scope);

        try {
          await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
            owner,
            repo,
            ref: `heads/${branchName}`
          });
        } catch {
          // Ignore delete errors - branch might not exist or might be protected
        }

        // Try create again
        const retryResult = await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
          owner,
          repo,
          ref: `refs/heads/${branchName}`,
          sha: baseSha
        });
        newRef = retryResult.data;
      }
    } else {
      // Some other error - rethrow
      throw createError;
    }
  }
  scope?.setTag("new_ref", newRef.ref);

  const { data: baseCommit } = await octokit.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner,
    repo,
    commit_sha: baseSha
  });
  scope?.setTag("base_commit_sha", baseCommit.sha);

  // Create blobs for all changed files. We process sequentially with a running
  // byte counter so peak memory is bounded by ~one file at a time, regardless
  // of how big the handout is.
  let totalBytesBuffered = 0;
  const enforceSizeBudget = (incomingBytes: number, filePath: string) => {
    totalBytesBuffered += incomingBytes;
    if (totalBytesBuffered > MAX_SYNC_TOTAL_BYTES) {
      const mb = (totalBytesBuffered / (1024 * 1024)).toFixed(1);
      const limitMb = (MAX_SYNC_TOTAL_BYTES / (1024 * 1024)).toFixed(0);
      throw new Error(
        `Handout sync exceeds size limit (${mb}MB > ${limitMb}MB) at file '${filePath}'. ` +
          `Use Git LFS or remove large binary assets from the handout repository.`
      );
    }
  };

  const unresolved: UnresolvedFile[] = [];
  /**
   * Leave the student's copy alone. Emitting no tree entry means `base_tree` supplies the
   * file, so the branch carries their version and the merge has nothing to overwrite.
   */
  const skipFile = (path: string, reason: UnresolvedReason) => {
    unresolved.push({ path, reason });
    scope?.addBreadcrumb({
      message: `Leaving ${path} untouched: ${reason}`,
      category: "sync",
      level: "info"
    });
    console.log(`[sync] leaving ${repoFullName} ${path} untouched (${reason})`);
  };

  const treeItems: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
  for (const file of files) {
    // Not every path below is destructive. A patch that applies to the student's own
    // content merges the instructor's change INTO their work, which is the outcome worth
    // having, so the guard is asked per branch rather than once at the top: only where a
    // branch would write over their copy does it stop.
    const modifiedReason = studentModified.get(file.path);

    // The same decision the size pre-flight made, from the same predicate, so the two gates
    // cannot disagree about a file. "skip" and "noop" resolve before the per-file charge
    // below, since a file the sync will not read must not be able to exhaust the budget.
    // "attempt_patch" falls through to the patch handling and skips only if the patch fails.
    const action = decideFileAction(shapeOf(file), modifiedReason);
    if (action === "noop") {
      // The handout is deleting a file the student already deleted. Nothing to write, and
      // nothing to tell them: reporting it would hold the pull request open over a deletion
      // that needed no action.
      continue;
    }
    if (action === "skip") {
      // modifiedReason is always set when the action is "skip"; decideFileAction returns
      // "write" for an unclassified file.
      skipFile(file.path, modifiedReason as UnresolvedReason);
      continue;
    }

    // Handle removed files
    if (file.status === "removed") {
      treeItems.push({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: null
      });
      continue;
    }

    // Pre-flight size check using metadata from getChangedFiles, when available.
    if (typeof file.size === "number") {
      enforceSizeBudget(file.size, file.path);
    }

    // Handle files with patches (text files that need to be merged)
    if (file.patch && !file.isBinary) {
      // GitHub may express a handout file deletion as a delete-only patch (`+0,0` hunk)
      // with status "modified". Don't try to apply that patch against the student copy —
      // either mirror the template's current file (if it still exists) or delete it.
      if (patchDeletesEntireFile(file.patch)) {
        scope?.addBreadcrumb({
          message: `Patch for ${file.path} deletes entire file; mirroring template at ${templateSha}`,
          category: "patch",
          level: "info"
        });

        if (!templateRepo || !templateSha) {
          throw new Error(`File ${file.path} has delete-only patch but no template repo/sha provided`);
        }

        try {
          const template = await fetchTextFileAtRef(templateRepo, file.path, templateSha, scope);
          const encoded = template.encode(template.text);
          const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
            owner,
            repo,
            content: encoded,
            encoding: "base64"
          });
          treeItems.push({
            path: file.path,
            mode: "100644" as const,
            type: "blob" as const,
            sha: blob.sha
          });
        } catch (fetchError: unknown) {
          if (isGitHubNotFound(fetchError)) {
            scope?.addBreadcrumb({
              message: `Template deleted ${file.path}; removing from student repo`,
              category: "patch",
              level: "info"
            });
            treeItems.push({
              path: file.path,
              mode: "100644" as const,
              type: "blob" as const,
              sha: null
            });
          } else {
            throw fetchError;
          }
        }
        continue;
      }

      scope?.addBreadcrumb({
        message: `Applying patch to ${file.path}`,
        category: "patch",
        level: "info"
      });

      // Fetch the current content from the student repo at baseSha. `encodePatched` is the
      // encoder that inverts however this file was read, and it moves with the content: the
      // fallback below replaces the text with the template's, so it replaces the encoder too.
      let baseContent = "";
      let encodePatched: (text: string) => string = encodeTextAsGitHubBase64;
      try {
        ({ text: baseContent, encode: encodePatched } = await fetchTextFileAtRef(
          repoFullName,
          file.path,
          baseSha,
          scope
        ));
      } catch (fetchError: unknown) {
        if (isGitHubNotFound(fetchError)) {
          // File doesn't exist in student repo (new file), use empty content
          scope?.addBreadcrumb({
            message: `File ${file.path} doesn't exist at baseSha, treating as new file`,
            category: "patch",
            level: "info"
          });
        } else {
          throw fetchError;
        }
      }

      let patchedContent: string;
      try {
        const result = applyPatch(baseContent, file.patch);
        if (result === false) {
          throw new Error("Patch application failed");
        }
        patchedContent = result;
      } catch (patchError) {
        const patchPreview = file.patch ? file.patch.substring(0, 200) : "no patch";
        const baseContentPreview = baseContent.substring(0, 200);
        scope?.addBreadcrumb({
          message: `Failed to apply patch to ${file.path}`,
          category: "patch",
          level: "error",
          data: {
            error: String(patchError),
            baseContentLength: baseContent.length,
            patchLength: file.patch?.length || 0,
            patchPreview,
            baseContentPreview
          }
        });
        console.error(`Failed to apply patch to ${file.path}:`, patchError);
        console.error(`Base content length: ${baseContent.length}, Patch length: ${file.patch?.length || 0}`);
        console.error(`Patch preview: ${patchPreview}`);
        console.error(`Base content preview: ${baseContentPreview}`);

        // The patch did not apply. When the student has edited this file that is the
        // expected outcome and the fallback below would replace their copy with the
        // template's, so stop here instead. Their version stays, and the PR reports it.
        if (modifiedReason) {
          skipFile(file.path, modifiedReason);
          continue;
        }

        // Fallback: fetch full content from template repo if available
        if (templateRepo && templateSha) {
          scope?.addBreadcrumb({
            message: `Attempting fallback: fetching full content from template repo for ${file.path}`,
            category: "patch",
            level: "info"
          });

          try {
            // Prefer the compare blob SHA — avoids the Contents API 1MB inline limit.
            ({ text: patchedContent, encode: encodePatched } = file.sha
              ? await fetchTextBlobFromRepo(templateRepo, file.sha, file.path, scope)
              : await fetchTextFileAtRef(templateRepo, file.path, templateSha, scope));
            scope?.addBreadcrumb({
              message: `Successfully fetched full content from template repo for ${file.path}`,
              category: "patch",
              level: "info"
            });
          } catch (fallbackError) {
            // Handout removed the file entirely — delete it from the student repo.
            if (isGitHubNotFound(fallbackError) && patchDeletesEntireFile(file.patch)) {
              scope?.addBreadcrumb({
                message: `Template deleted ${file.path} after patch failure; removing from student repo`,
                category: "patch",
                level: "info"
              });
              treeItems.push({
                path: file.path,
                mode: "100644" as const,
                type: "blob" as const,
                sha: null
              });
              continue;
            }

            scope?.addBreadcrumb({
              message: `Fallback failed for ${file.path}: ${fallbackError}`,
              category: "patch",
              level: "error"
            });
            console.error(`Fallback failed for ${file.path}:`, fallbackError);
            throw new Error(
              `Patch application failed for '${file.path}' and fallback failed: ${patchError}. Fallback error: ${fallbackError}`
            );
          }
        } else {
          throw patchError;
        }
      }

      // Account for transient memory: base content + patched content concurrently in scope.
      // Subtract the pre-charged file.size so we don't double-count it (the pre-flight charge
      // above already accounted for one copy of the file's bytes). Only charge the *delta*
      // — i.e. the extra transient memory above the pre-flight estimate.
      const preCharged = typeof file.size === "number" ? file.size : 0;
      const transientPeak = baseContent.length + patchedContent.length;
      const incrementalBytes = Math.max(0, transientPeak - preCharged);
      enforceSizeBudget(incrementalBytes, file.path);

      const encodedPatched = encodePatched(patchedContent);
      const { data: blob } = await octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
        owner,
        repo,
        content: encodedPatched,
        encoding: "base64"
      });

      treeItems.push({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blob.sha
      });
      continue;
    }

    // Handle binary files / initial-sync added files: copy the blob from the
    // template repo to the student repo using the memory-frugal raw-fetch +
    // streaming-Blob path (see `copyBlobBetweenRepos`), so peak memory stays
    // around 2.33× the file size instead of the ~3× the Octokit JSON path
    // would force.
    // No patch is attempted on this branch, so the copy is unconditional. A student who
    // edited a binary file, or who created a file at a path the handout now adds, used to
    // lose it here with no diagnostic; that case is skipped above, before the size charge.
    if (file.isBinary || file.status === "added") {
      if (!file.sha) {
        throw new Error(`File ${file.path} is binary/added but has no template blob SHA`);
      }
      if (!templateRepo) {
        throw new Error(`File ${file.path} requires lazy blob fetch but no templateRepo provided`);
      }

      const blobSha = await copyBlobBetweenRepos(templateRepo, file.sha, repoFullName, file.path, scope);

      // Account for the bytes we transiently held for this file (raw + base64).
      // We deliberately discarded the buffer above, so we approximate from the
      // known raw size when available. This budget mainly guards against the
      // pathological "many medium files" case rather than the single-file peak
      // (which is bounded by MAX_SYNC_FILE_BYTES + the 2.33× transient inflation).
      if (typeof file.size === "number") {
        enforceSizeBudget(Math.ceil(file.size * 1.34), file.path);
      }

      treeItems.push({
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobSha
      });
      continue;
    }

    throw new Error(`File ${file.path} has neither patch nor blob SHA`);
  }

  // Nothing survived. The caller's pre-flight cannot see this coming: a text file the
  // student edited counts as syncable because its patch MIGHT merge into their copy, and
  // when every such patch fails -- which is the expected outcome precisely because they
  // edited it -- every file ends up skipped and there is no tree entry left to make.
  //
  // Committing anyway would post an empty `tree` array and then open a pull request with a
  // zero-line diff, which auto-merge is suppressed on and nobody will ever merge. Say so
  // instead, so the caller can report the update as blocked rather than as delivered.
  //
  // The ref was written at the top of this function, before any file was examined, so there
  // IS a branch to clean up. Leaving it would strand a `sync-to-<sha7>` branch pointing at a
  // months-old commit in the student's repo with no pull request attached, and hand the next
  // run a "Reference already exists" to authorize a reset against for no reason.
  if (treeItems.length === 0) {
    scope?.setTag("sync_commit_empty", "true");
    console.log(`[sync] ${repoFullName}: nothing left to write after ${unresolved.length} skip(s); no commit made`);
    try {
      await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
        owner,
        repo,
        ref: `heads/${branchName}`
      });
    } catch (cleanupError) {
      // Best effort. A branch we could not remove is untidy; failing the sync over it would
      // turn a clean "nothing to deliver" into an error the instructor has to chase.
      scope?.addBreadcrumb({
        message: `Could not delete empty sync branch ${branchName}: ${cleanupError}`,
        category: "git",
        level: "warning"
      });
    }
    return { unresolved, committed: false };
  }

  const { data: newTree } = await octokit.request("POST /repos/{owner}/{repo}/git/trees", {
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: treeItems
  });
  const { data: newCommit } = await octokit.request("POST /repos/{owner}/{repo}/git/commits", {
    owner,
    repo,
    message: commitMessage,
    tree: newTree.sha,
    parents: [baseSha]
  });
  scope?.setTag("new_commit_sha", newCommit.sha);
  await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner,
    repo,
    ref: `heads/${branchName}`,
    sha: newCommit.sha
  });

  return { unresolved, committed: true };
}

/**
 * Create a pull request
 */
export async function createPullRequest(
  repoFullName: string,
  branchName: string,
  baseBranch: string,
  title: string,
  body: string,
  adminSupabase: SupabaseClient<Database>,
  scope?: Sentry.Scope
): Promise<number> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  scope?.setTag("owner", owner);
  scope?.setTag("repo", repo);
  scope?.setTag("branch_name", branchName);
  scope?.setTag("base_branch", baseBranch);
  scope?.setTag("title", title);
  scope?.setTag("body", body);
  scope?.setTag("github_operation", "create_pull_request");
  //Also check the circuit breaker before we hit this, and fail if we have already bit the big one
  const circuitKey = `${owner}:sync_repo_to_handout`;
  const methodCirc = await adminSupabase.schema("public").rpc("get_github_circuit", {
    p_scope: "org_method",
    p_key: circuitKey
  });
  if (!methodCirc.error && Array.isArray(methodCirc.data) && methodCirc.data.length > 0) {
    // const row = methodCirc.data[0] as { state?: string; open_until?: string };
    // if (row?.state === "open" && (!row.open_until || new Date(row.open_until) > new Date())) {
    //   throw new UserVisibleError(
    //     `GitHub operations temporarily unavailable due to repeated errors. Please try again in 8 hours.`
    //   );
    // }
  }
  const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    title,
    body,
    head: branchName,
    base: baseBranch
  });

  return pr.number;
}

/**
 * Check if a repository already has the handout changes applied.
 *
 * This handles the case where a PR was merged but our database wasn't updated.
 * The student may have made ADDITIONAL edits to files (changing the SHA),
 * but the handout patch might already be applied.
 *
 * We check this by simulating what would happen if we applied the patches:
 * - For removed files: check if they're already gone
 * - For binary files: check if the content matches the template
 * - For text files with patches: check if applying the patch results in no change
 *   (meaning the patch is already applied)
 *
 * @returns true if all handout changes are already applied (no diff needed), false otherwise
 */
export async function isRepoAlreadyInSync(
  studentRepoFullName: string,
  templateRepo: string,
  changedFiles: FileChange[],
  templateToSha: string,
  scope?: Sentry.Scope
): Promise<boolean> {
  const studentOctokit = await github.getOctoKit(studentRepoFullName, scope);
  const templateOctokit = await github.getOctoKit(templateRepo, scope);

  if (!studentOctokit || !templateOctokit) {
    return false; // Can't verify, assume not in sync
  }

  const [studentOwner, studentRepo] = studentRepoFullName.split("/");
  const [templateOwner, templateRepoName] = templateRepo.split("/");

  scope?.addBreadcrumb({
    message: `Checking if ${studentRepoFullName} already has handout changes applied (${changedFiles.length} files)`,
    category: "sync",
    level: "info"
  });

  try {
    for (const file of changedFiles) {
      // Handle removed files
      if (file.status === "removed") {
        try {
          await studentOctokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner: studentOwner,
            repo: studentRepo,
            path: file.path,
            ref: "main"
          });
          // File still exists - not in sync
          scope?.addBreadcrumb({
            message: `File ${file.path} should be removed but still exists`,
            category: "sync",
            level: "debug"
          });
          return false;
        } catch (error: unknown) {
          // Only treat 404 as "file doesn't exist" - other errors (rate limit, auth, network) should fail the check
          const status =
            error && typeof error === "object" && "status" in error ? (error as { status: number }).status : undefined;
          if (status === 404) {
            // File doesn't exist - good, it was supposed to be removed
            continue;
          }
          // Other error (rate limit, auth, network, etc.) - can't reliably determine sync status
          scope?.addBreadcrumb({
            message: `Error checking if removed file ${file.path} exists: status=${status}, error=${error}`,
            category: "sync",
            level: "warning"
          });
          return false;
        }
      }

      // For binary files: compare blob SHAs (cheap, constant memory) instead of
      // downloading both contents. The contents endpoint returns the file's blob SHA.
      if (file.isBinary) {
        if (!file.sha) {
          // Can't verify without template SHA — fall through to "not in sync"
          return false;
        }
        try {
          const { data: studentMeta } = await studentOctokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
            owner: studentOwner,
            repo: studentRepo,
            path: file.path,
            ref: "main"
          });
          const studentSha =
            studentMeta && typeof studentMeta === "object" && "sha" in studentMeta
              ? (studentMeta as { sha?: string }).sha
              : undefined;
          if (!studentSha || studentSha !== file.sha) {
            scope?.addBreadcrumb({
              message: `Binary file ${file.path} blob SHA differs from template`,
              category: "sync",
              level: "debug"
            });
            return false;
          }
          continue;
        } catch (error: unknown) {
          const status =
            error && typeof error === "object" && "status" in error ? (error as { status: number }).status : undefined;
          scope?.addBreadcrumb({
            message: `Error fetching binary file ${file.path} from student repo: status=${status}, error=${error}`,
            category: "sync",
            level: "warning"
          });
          return false;
        }
      }

      // For text files with patches we need student content to apply the patch.
      let studentContent: string;
      let studentBlobSha: string | undefined;
      try {
        ({ text: studentContent, sha: studentBlobSha } = await fetchTextFileAtRef(
          studentRepoFullName,
          file.path,
          "main",
          scope
        ));
      } catch (error: unknown) {
        const status =
          error && typeof error === "object" && "status" in error ? (error as { status: number }).status : undefined;
        if (status === 404) {
          scope?.addBreadcrumb({
            message: `File ${file.path} doesn't exist in student repo but should`,
            category: "sync",
            level: "debug"
          });
        } else {
          scope?.addBreadcrumb({
            message: `Error fetching file ${file.path} from student repo: status=${status}, error=${error}`,
            category: "sync",
            level: "warning"
          });
        }
        return false;
      }

      // For text files with patches: check if applying the patch results in no change
      if (file.patch && !file.isBinary) {
        try {
          const patchedContent = applyPatch(studentContent, file.patch);

          if (patchedContent === false) {
            // Patch failed to apply - could mean conflicts or already applied differently.
            // Compare student's file to expected template content as a loose secondary check.
            try {
              const expectedContent = (
                file.sha
                  ? await fetchTextBlobFromRepo(templateRepo, file.sha, file.path, scope)
                  : await fetchTextFileAtRef(templateRepo, file.path, templateToSha, scope)
              ).text;
              if (studentContent.includes(expectedContent) || expectedContent === studentContent) {
                continue;
              }
            } catch {
              // Couldn't fetch template content for comparison — treat as not in sync.
            }

            scope?.addBreadcrumb({
              message: `Patch for ${file.path} failed to apply and content doesn't match template`,
              category: "sync",
              level: "debug"
            });
            return false;
          }

          if (patchedContent === studentContent) {
            // The patch is already applied
            continue;
          }

          scope?.addBreadcrumb({
            message: `File ${file.path} would change if patch applied - not in sync`,
            category: "sync",
            level: "debug"
          });
          return false;
        } catch (patchError) {
          scope?.addBreadcrumb({
            message: `Error applying patch to ${file.path}: ${patchError}`,
            category: "sync",
            level: "debug"
          });
          return false;
        }
      }

      // For added text files (no patch): compare student blob SHA to template blob SHA.
      // GitHub blob SHAs are content-addressable, so equal SHAs means equal content.
      if (file.status === "added" && file.sha) {
        if (studentBlobSha && studentBlobSha === file.sha) {
          continue;
        }
        scope?.addBreadcrumb({
          message: `Added text file ${file.path} blob SHA differs from template (student=${studentBlobSha ?? "n/a"}, template=${file.sha})`,
          category: "sync",
          level: "debug"
        });
        return false;
      }
    }

    // All files are in sync!
    scope?.addBreadcrumb({
      message: `Repository ${studentRepoFullName} already has all handout changes applied`,
      category: "sync",
      level: "info"
    });
    return true;
  } catch (error) {
    scope?.addBreadcrumb({
      message: `Error checking sync status: ${error}`,
      category: "sync",
      level: "warning"
    });
    return false; // On error, assume not in sync and proceed with normal flow
  }
}

/**
 * Find existing sync PRs for a repository with the given branch name pattern.
 * Returns info about any existing PR (open, merged, or closed without merge).
 */
export async function findExistingSyncPR(
  repoFullName: string,
  branchName: string,
  scope?: Sentry.Scope
): Promise<{
  exists: boolean;
  merged?: boolean;
  isOpen?: boolean;
  closedWithoutMerge?: boolean;
  prNumber?: number;
  prUrl?: string;
  mergeSha?: string;
} | null> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    return null;
  }

  const [owner, repo] = repoFullName.split("/");

  try {
    // Search for PRs with the given head branch
    const { data: prs } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
      owner,
      repo,
      head: `${owner}:${branchName}`,
      state: "all" // Include both open and closed PRs
    });

    if (prs.length === 0) {
      return { exists: false };
    }

    const pr = prs[0]; // Get the most recent PR with this branch
    const prUrl = pr.html_url;
    const merged = pr.merged_at !== null;
    const isOpen = pr.state === "open";
    const closedWithoutMerge = pr.state === "closed" && !merged;

    scope?.addBreadcrumb({
      message: `Found existing PR #${pr.number} for branch ${branchName} (state: ${pr.state}, merged: ${merged}, closedWithoutMerge: ${closedWithoutMerge})`,
      category: "sync",
      level: "info"
    });

    return {
      exists: true,
      merged,
      isOpen,
      closedWithoutMerge,
      prNumber: pr.number,
      prUrl,
      mergeSha: pr.merge_commit_sha || undefined
    };
  } catch (error) {
    scope?.addBreadcrumb({
      message: `Error checking for existing PR: ${error}`,
      category: "sync",
      level: "warning"
    });
    return null;
  }
}

/**
 * Attempt to auto-merge a pull request
 */
export async function attemptAutoMerge(
  repoFullName: string,
  prNumber: number,
  scope?: Sentry.Scope
): Promise<{ merged: boolean; mergeSha?: string }> {
  const octokit = await github.getOctoKit(repoFullName, scope);
  if (!octokit) {
    throw new Error(`No octokit found for repository ${repoFullName}`);
  }

  const [owner, repo] = repoFullName.split("/");

  const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber
  });

  if (!pr.mergeable) {
    return { merged: false };
  }

  // Merge the head we just read, not whatever the head is by the time this request arrives. A
  // student pushing to the branch between the two calls gets a 409 here instead of having their
  // commit merged by a run that never saw it, which is the same reason
  // assignment-sync-autograder-workflow passes a blob sha to its rollback delete.
  try {
    const { data: mergeResult } = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      owner,
      repo,
      pull_number: prNumber,
      merge_method: "merge",
      sha: pr.head.sha
    });

    return { merged: true, mergeSha: mergeResult.sha };
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? (error as { status: number }).status : 0;
    // 409 is "head moved"; 405 is "not mergeable any more". Both mean the branch is no
    // longer the thing this run decided to merge, so leave the PR for a human.
    if (status === 409 || status === 405) {
      scope?.addBreadcrumb({
        message: `Auto-merge skipped for ${repoFullName} PR #${prNumber}: head moved or became unmergeable (${status})`,
        category: "sync",
        level: "info"
      });
      return { merged: false };
    }
    throw error;
  }
}

/**
 * Complete sync operation: compare files, create branch, commit, PR, and optionally auto-merge
 *
 * This is the main entry point for syncing a repository to a template
 * Rate-limited using Bottleneck to prevent overwhelming GitHub API
 *
 * @param syncedRepoSha - The SHA of the student repo at the last successful sync (Student_orig).
 *                        This is used as the base for the PR branch to enable proper 3-way merging.
 *                        Null for a row that records no baseline, which is resolved once, here,
 *                        to the repository's current head; see `resolveSyncBaselineSha`. It is
 *                        resolved ONCE because the commit the guard classifies against and the
 *                        commit the branch is built on have to be the same one.
 */
export async function syncRepositoryToHandout(params: {
  repositoryFullName: string;
  templateRepo: string;
  fromSha: string | null;
  toSha: string;
  syncedRepoSha: string | null;
  adminSupabase: SupabaseClient<Database>;
  autoMerge?: boolean;
  waitBeforeMerge?: number; // milliseconds to wait before attempting merge
  scope?: Sentry.Scope;
}): Promise<SyncResult> {
  const org = params.repositoryFullName.split("/")[0];
  const limiter = getSyncLimiter(org);
  const { adminSupabase } = params;
  const createContentLimiter = getCreateContentLimiter(org);
  console.log("Waiting for outer sync limiter to be available", org);
  return await limiter.schedule(async () => {
    console.log("Waiting for inner sync limiter to be available", org);
    return await createContentLimiter.schedule(async () => {
      // Wrap the sync operation in the rate limiter
      console.log("syncRepositoryToHandout", params);
      const {
        repositoryFullName,
        templateRepo,
        fromSha,
        toSha,
        syncedRepoSha,
        autoMerge = true,
        waitBeforeMerge = 2000,
        scope
      } = params;
      scope?.setTag("repository", repositoryFullName);
      scope?.setTag("template_repo", templateRepo);
      scope?.setTag("from_sha", fromSha);
      scope?.setTag("to_sha", toSha);
      scope?.setTag("synced_repo_sha", syncedRepoSha ?? "none");
      scope?.setTag("auto_merge", autoMerge.toString());
      scope?.setTag("wait_before_merge", waitBeforeMerge.toString());
      scope?.setTag("sync_operation", "sync_repository_to_handout");

      scope?.addBreadcrumb({
        message: `Starting rate-limited sync for ${repositoryFullName}`,
        category: "sync",
        level: "info"
      });

      try {
        // Get changed files (with caching)
        const changedFiles = await getChangedFiles(templateRepo, fromSha, toSha, scope);

        if (changedFiles.length === 0) {
          return {
            success: true,
            no_changes: true
          };
        }

        // The commit this sync treats as the repository's baseline, resolved ONCE.
        //
        // Everything downstream uses this one value: the guard classifies against it, the
        // branch is created at it, and the pull request describes it. That is not tidiness.
        // A row with no baseline resolves to the repository's current head, and reading that
        // head twice lets a student's push arrive in between. If the branch base is the newer
        // of the two, their commit is inside the base while the classification still says the
        // path is untouched, and the sync writes over work it was built to protect. One
        // request cannot disagree with itself.
        const baselineSha = await resolveSyncBaselineSha(repositoryFullName, syncedRepoSha, scope);
        if (!baselineSha) {
          // No recorded baseline and no readable head. There is no commit to branch from and
          // nothing to classify against, so there is no safe sync to attempt. Saying so is
          // better than picking a commit and hoping.
          throw new SyncBaselineUnavailableError(repositoryFullName);
        }
        scope?.setTag("baseline_sha", baselineSha);

        // Which of these files are the student's own work, decided BEFORE the size
        // pre-flight below. The pre-flight aborts the whole sync on a single oversized
        // file, and a file we are not going to touch must not be able to do that: the
        // guard skips it without reading a byte, so its size is irrelevant. Doing it here
        // also means the answer is computed once and passed down, rather than twice.
        const studentModified = await findStudentModifiedFiles(
          repositoryFullName,
          baselineSha,
          templateRepo,
          fromSha,
          changedFiles.map((f) => f.path),
          scope
        );

        // The files the sync will actually read and write. NOT simply "the ones the student
        // has not touched": a text file whose content differs is still patchable, and
        // createBranchAndCommit does merge those, so it is fetched and written and its size
        // counts. Both gates ask the same predicate so they cannot disagree.
        const syncableFiles = changedFiles.filter((f) => countsTowardSyncSize(shapeOf(f), studentModified.get(f.path)));

        /**
         * The outcome for an update where nothing could be written: every changed file is
         * the student's own work, so there is no tree entry to make, no commit and no PR.
         *
         * This must NOT report no_changes. The worker reads that as "the handout holds
         * nothing new for this repo" and advances synced_handout_sha to to_sha, which would
         * record an update as delivered that was never written, permanently and with
         * nothing to point at. Reporting it as blocked leaves synced_handout_sha where it
         * is, so the repo stays visibly behind the handout.
         *
         * Reached from two places, which is why it is a function: the pre-flight below
         * (nothing is even worth reading) and, after the commit is built, the case where
         * every file that WAS worth reading turned out to be unwritable once its patch
         * failed. Both end with an empty tree, and both have to report the same thing.
         */
        const blockedByStudentChanges = async (unresolvedPaths: string[]): Promise<SyncResult> => {
          // Everything here is classified against the baseline, the state at the LAST sync.
          // Someone may have applied these changes to the default branch by hand since then,
          // in which case the repo already holds the handout's content and there is nothing
          // blocked about it. Comparing the branch as it stands now against the handout at
          // toSha answers that: an empty result means every one of these paths already
          // matches the target, so this is an ordinary no_changes and recording the repo as
          // synced is correct, because the content really is there.
          //
          // `getDefaultBranchHeadSha` returns undefined under the E2E GitHub stub and for
          // the suffixed E2E repo names that do not exist on GitHub. No head means no second
          // opinion, so the update is reported blocked, which is the conservative direction.
          const headSha = await github.getDefaultBranchHeadSha(repositoryFullName, scope);
          const stillDiffering = headSha
            ? await findStudentModifiedFiles(repositoryFullName, headSha, templateRepo, toSha, unresolvedPaths, scope)
            : new Map(unresolvedPaths.map((path) => [path, "content_differs" as UnresolvedReason]));
          if (stillDiffering.size === 0) {
            scope?.setTag("blocked_paths_already_current", "true");
            scope?.addBreadcrumb({
              message:
                `${repositoryFullName} already holds the handout's version of every path this update ` +
                `touches; recording it as synced rather than blocked`,
              category: "sync",
              level: "info"
            });
            return {
              success: true,
              no_changes: true,
              // The head this decision was made FROM, so the caller can move the baseline to
              // the commit that was actually inspected. `findStudentModifiedFiles` read the
              // repository at this exact sha to conclude the paths already match, so the pair
              // it records describes a state that was really there. Re-reading the head to
              // fill this in would be a different commit and a different claim.
              repo_head_sha: headSha
            };
          }

          scope?.setTag("sync_blocked_by_student_changes", "true");
          scope?.addBreadcrumb({
            message:
              `Every file in this update is the student's own work in ${repositoryFullName} ` +
              `(${unresolvedPaths.join(", ")}); nothing can be merged and nothing was written`,
            category: "sync",
            level: "warning"
          });
          console.warn(
            `[sync] ${repositoryFullName}: handout update ${toSha.substring(0, 7)} not delivered, ` +
              `all ${unresolvedPaths.length} changed file(s) are the student's own work`
          );
          return {
            success: true,
            blocked_by_student_changes: true,
            unresolved_paths: unresolvedPaths
          };
        };

        if (syncableFiles.length === 0) {
          // The paths that actually BLOCK, not every path in the update. A "noop" file -- a
          // handout deletion the student already made -- is unsyncable and needs no action,
          // so naming it here would report a file as blocking that nothing is waiting on.
          return await blockedByStudentChanges(
            changedFiles
              .filter((f) => decideFileAction(shapeOf(f), studentModified.get(f.path)) !== "noop")
              .map((f) => f.path)
          );
        }

        // Size pre-flight: decide concurrency class BEFORE doing any heavy work.
        // Sizes are populated by getChangedFiles from the recursive tree (Redis-cached),
        // so this is essentially free.
        let maxFileBytes = 0;
        let totalChangedBytes = 0;
        let largestFilePath = "";
        for (const f of syncableFiles) {
          if (typeof f.size === "number") {
            totalChangedBytes += f.size;
            if (f.size > maxFileBytes) {
              maxFileBytes = f.size;
              largestFilePath = f.path;
            }
          }
        }

        // Per-file hard cap. Files larger than this can't be synced through the Edge
        // Function runtime — base64-encoding a single 50MB+ blob already exceeds the
        // v8 heap budget. Fail fast with an actionable error.
        if (maxFileBytes > MAX_SYNC_FILE_BYTES) {
          const mb = (maxFileBytes / (1024 * 1024)).toFixed(1);
          const limitMb = (MAX_SYNC_FILE_BYTES / (1024 * 1024)).toFixed(0);
          throw new Error(
            `File '${largestFilePath}' is ${mb}MB which exceeds the per-file sync limit of ${limitMb}MB. ` +
              `Use Git LFS, host the data out-of-band, or remove it from the handout repository.`
          );
        }

        const isHeavySync = maxFileBytes > LARGE_FILE_THRESHOLD;
        scope?.setTag("sync_size_class", isHeavySync ? "heavy" : "light");
        scope?.setTag("max_file_bytes", String(maxFileBytes));
        scope?.setTag("total_changed_bytes", String(totalChangedBytes));
        scope?.setTag("largest_file", largestFilePath);
        if (isHeavySync) {
          scope?.addBreadcrumb({
            message:
              `Heavy sync detected: largest file '${largestFilePath}' is ${(maxFileBytes / (1024 * 1024)).toFixed(1)}MB ` +
              `(threshold ${(LARGE_FILE_THRESHOLD / (1024 * 1024)).toFixed(0)}MB). Will serialize through heavy-sync lock.`,
            category: "sync",
            level: "info"
          });
        }

        const branchName = `sync-to-${toSha.substring(0, 7)}`;

        // RESILIENCE CHECK 1: Check for existing PR with this branch name FIRST
        // This must happen before any branch deletion to avoid closing open PRs
        const existingPR = await findExistingSyncPR(repositoryFullName, branchName, scope);

        // RESILIENCE CHECK 2: Check if student repo is already in sync with template
        // This handles cases where a previous PR was merged but our database wasn't updated
        const alreadyInSync = await isRepoAlreadyInSync(repositoryFullName, templateRepo, changedFiles, toSha, scope);

        if (alreadyInSync) {
          scope?.addBreadcrumb({
            message: `Repository ${repositoryFullName} is already in sync with template at ${toSha}`,
            category: "sync",
            level: "info"
          });

          // If there's an existing merged PR, return its info so DB can be updated
          if (existingPR?.exists && existingPR.merged) {
            return {
              success: true,
              pr_number: existingPR.prNumber,
              pr_url: existingPR.prUrl,
              merged: true,
              merge_sha: existingPR.mergeSha
            };
          }

          // If there's an open PR but repo is in sync, the PR is stale
          // Don't delete the branch - let the PR remain for visibility
          // Just report no changes needed
          if (existingPR?.exists && !existingPR.merged) {
            scope?.addBreadcrumb({
              message: `Repository in sync but has open PR #${existingPR.prNumber} - may need manual review`,
              category: "sync",
              level: "warning"
            });
          }

          // Only clean up branch if NO PR exists (safe to delete)
          if (!existingPR?.exists) {
            const octokit = await github.getOctoKit(repositoryFullName, scope);
            if (octokit) {
              const [owner, repo] = repositoryFullName.split("/");
              try {
                await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
                  owner,
                  repo,
                  ref: `heads/${branchName}`
                });
              } catch {
                // Branch doesn't exist, which is fine
              }
            }
          }

          return {
            success: true,
            no_changes: true
          };
        }

        if (existingPR?.exists) {
          if (existingPR.merged) {
            // PR was already merged! Just return success so the database can be updated
            scope?.addBreadcrumb({
              message: `Found already-merged PR #${existingPR.prNumber} for ${repositoryFullName}`,
              category: "sync",
              level: "info"
            });
            return {
              success: true,
              pr_number: existingPR.prNumber,
              pr_url: existingPR.prUrl,
              merged: true,
              merge_sha: existingPR.mergeSha
            };
          } else if (existingPR.isOpen) {
            // PR exists and is still open - return its info so caller knows the state
            scope?.addBreadcrumb({
              message: `Found open PR #${existingPR.prNumber} for ${repositoryFullName}`,
              category: "sync",
              level: "info"
            });
            return {
              success: true,
              pr_number: existingPR.prNumber,
              pr_url: existingPR.prUrl,
              merged: false
            };
          } else if (existingPR.closedWithoutMerge) {
            // PR was closed without merge - we need to create a new PR
            // The branch will be recreated below, and a new PR will be opened
            scope?.addBreadcrumb({
              message: `Found closed-without-merge PR #${existingPR.prNumber} for ${repositoryFullName} - will create new PR`,
              category: "sync",
              level: "info"
            });
            // Fall through to create new branch and PR
          }
        }

        // Create branch and commit based on the baseline (Student_orig)
        // This enables proper 3-way merging when the PR targets current main
        const commitMessage = `${SYNC_COMMIT_MESSAGE_PREFIX} ${toSha.substring(0, 7)}

This commit was automatically generated by an instructor to sync
changes from the template repository.

Changed files:
${syncableFiles.map((f) => `- ${f.path}`).join("\n")}`;

        // For heavy syncs, serialize the memory-intensive work (blob fetch + commit)
        // through a per-isolate semaphore so we never hold multiple large blobs in
        // memory simultaneously. Light syncs run as before.
        const runCommit = () =>
          createBranchAndCommit(
            repositoryFullName,
            branchName,
            baselineSha,
            // The FULL list, not syncableFiles: createBranchAndCommit has to see the
            // protected paths to skip them explicitly and report them back, which is what
            // holds the PR open. syncableFiles exists for the sizing gates, which must not
            // weigh a file nobody is going to read.
            changedFiles,
            commitMessage,
            scope,
            templateRepo,
            toSha,
            studentModified
          );
        const { unresolved, committed } = isHeavySync ? await withHeavySyncLock(runCommit) : await runCommit();

        // Every file was left to the student after all, so there is nothing to open a pull
        // request about. Report it the same way the pre-flight would have, rather than
        // opening an empty PR and recording the update as delivered.
        if (!committed) {
          return await blockedByStudentChanges(unresolved.map((f) => f.path));
        }

        // A sync that left files to the student is a sync with work still in it. The PR
        // has to stay open for them to finish, whatever the caller asked for.
        const effectiveAutoMerge = resolveAutoMerge(autoMerge, unresolved);
        scope?.setTag("unresolved_file_count", String(unresolved.length));
        scope?.setTag("effective_auto_merge", effectiveAutoMerge.toString());
        if (autoMerge && !effectiveAutoMerge) {
          scope?.addBreadcrumb({
            message:
              `Auto-merge disabled for ${repositoryFullName}: ${unresolved.length} file(s) are the student's own ` +
              `work and were left untouched (${unresolved.map((f) => f.path).join(", ")})`,
            category: "sync",
            level: "info"
          });
          console.log(
            `[sync] ${repositoryFullName}: holding PR open, ${unresolved.length} file(s) left to the student`
          );
        }

        // Create PR
        const prTitle = `[Instructor Update] Sync handout to ${toSha.substring(0, 7)}`;

        // Categorize files for better PR description. Anything left to the student is
        // reported in its own section instead, so these lists describe what this PR
        // actually carries rather than everything the instructor changed.
        const unresolvedPaths = new Set(unresolved.map((f) => f.path));
        const syncedFiles = changedFiles.filter((f) => !unresolvedPaths.has(f.path));
        const textFiles = syncedFiles.filter((f) => !f.isBinary && f.status !== "removed");
        const binaryFiles = syncedFiles.filter((f) => f.isBinary && f.status !== "removed");
        const removedFiles = syncedFiles.filter((f) => f.status === "removed");

        const prBody = `## Handout Update

This pull request syncs the latest changes from the assignment template repository.

**Triggered by:** Instructor
**Template commit:** ${toSha}
**Previous sync:** ${fromSha || "Initial sync"}
**Base commit:** ${baselineSha.substring(0, 7)}

### How This Works

This PR uses a **3-way merge strategy** to preserve your work:
- **Base**: ${
          syncedRepoSha
            ? `The state of your repo at the last sync (${baselineSha.substring(0, 7)})`
            : `Your repo as it stands now (${baselineSha.substring(0, 7)}), because no earlier sync was recorded for it`
        }
- **Changes**: Updates from the handout template
- **Your Work**: Any commits you've made since the last sync

GitHub will automatically merge these together. If you modified the same parts of files that the instructor updated, you'll see merge conflicts that need to be resolved.

${renderUnresolvedSection(unresolved)}### Changed Files

${textFiles.length > 0 ? `**Text files** (will be merged with your changes):\n${textFiles.map((f) => `- \`${f.path}\``).join("\n")}\n\n` : ""}${binaryFiles.length > 0 ? `**Binary files** (replaced with the handout's version):\n${binaryFiles.map((f) => `- \`${f.path}\``).join("\n")}\n\n` : ""}${removedFiles.length > 0 ? `**Removed files**:\n${removedFiles.map((f) => `- \`${f.path}\``).join("\n")}\n\n` : ""}
---
*This PR was automatically generated. ${
          effectiveAutoMerge
            ? "It will be auto-merged if there are no conflicts."
            : unresolved.length > 0
              ? "It will NOT be merged automatically, because some of the files the instructor changed are files you have edited. Review the list above, then merge when you are ready."
              : "It will NOT be merged automatically. Review it, then merge when you are ready."
        } If there are merge conflicts, they will be shown in the GitHub UI - you can resolve them directly on GitHub or locally. If you need help, ask your course staff.*`;

        let prNumber: number;
        let prUrl: string;
        try {
          prNumber = await createPullRequest(
            repositoryFullName,
            branchName,
            "main",
            prTitle,
            prBody,
            adminSupabase,
            scope
          );
          prUrl = `https://github.com/${repositoryFullName}/pull/${prNumber}`;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          // Handle case where there are no commits between branches (repo already up to date)
          if (errorMessage.includes("No commits between")) {
            scope?.addBreadcrumb({
              message: `No commits between branches - repository already up to date`,
              category: "sync",
              level: "info"
            });

            // Clean up the branch we created
            const octokit = await github.getOctoKit(repositoryFullName, scope);
            if (octokit) {
              const [owner, repo] = repositoryFullName.split("/");
              try {
                await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
                  owner,
                  repo,
                  ref: `heads/${branchName}`
                });
              } catch {
                // Ignore cleanup errors
              }
            }

            return {
              success: true,
              no_changes: true
            };
          }

          // Handle case where PR already exists (race condition or retry after partial failure)
          if (errorMessage.includes("A pull request already exists") || errorMessage.includes("already exists for")) {
            scope?.addBreadcrumb({
              message: `PR already exists for branch ${branchName}, looking up existing PR`,
              category: "sync",
              level: "info"
            });

            // Look up the existing PR
            const existingPRAfterError = await findExistingSyncPR(repositoryFullName, branchName, scope);
            if (existingPRAfterError?.exists) {
              if (existingPRAfterError.merged) {
                return {
                  success: true,
                  pr_number: existingPRAfterError.prNumber,
                  pr_url: existingPRAfterError.prUrl,
                  merged: true,
                  merge_sha: existingPRAfterError.mergeSha
                };
              } else {
                // Use the existing PR
                prNumber = existingPRAfterError.prNumber!;
                prUrl = existingPRAfterError.prUrl!;
                // Continue to auto-merge attempt below
              }
            } else {
              // Couldn't find the existing PR - re-throw the error
              throw error;
            }
          } else {
            // Re-throw if it's a different error
            throw error;
          }
        }

        // Attempt auto-merge if requested
        let merged = false;
        let mergeSha: string | undefined;

        if (effectiveAutoMerge) {
          // Wait for GitHub to update mergeable state
          await new Promise((resolve) => setTimeout(resolve, waitBeforeMerge));
          const mergeResult = await attemptAutoMerge(repositoryFullName, prNumber, scope);
          merged = mergeResult.merged;
          mergeSha = mergeResult.mergeSha;
        }

        return {
          success: true,
          pr_number: prNumber,
          pr_url: prUrl,
          merged,
          merge_sha: mergeSha,
          // The partial outcome carries this as well as the fully blocked one. Some of the
          // instructor's changes were not delivered here either, and without this the only
          // record of which ones is the pull request body. The moment it is merged the row
          // reads "Synced" and nobody can name the files that never arrived.
          unresolved_paths: unresolved.length > 0 ? unresolved.map((f) => f.path) : undefined
        };
      } catch (error) {
        console.trace(error);
        if (error instanceof TerminalSyncError) {
          // One repository's own problem, and one the instructor or the student can act on.
          // Tag it rather than reporting it as another anonymous sync failure, so the org's
          // error rate is not driven by students resolving their own merges.
          scope?.setTag("terminal_sync_reason", error.reason);
        }
        Sentry.captureException(error, scope);
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          terminal_reason: error instanceof TerminalSyncError ? error.reason : undefined
        };
      }
    });
  });
}

/**
 * Documented fallback template repos, kept in sync with the github_orgs table defaults
 * and the resolve_class_template_repos RPC.
 */
export const DEFAULT_HANDOUT_TEMPLATE_REPO = "pawtograder/template-assignment-handout";
export const DEFAULT_SOLUTION_TEMPLATE_REPO = "pawtograder/template-assignment-grader";

/**
 * Resolve the handout and solution (grader) template repos for a class.
 *
 * Resolution order (handled by the resolve_class_template_repos RPC):
 *   class override -> github_orgs default -> hardcoded constant.
 *
 * Falls back to the hardcoded constants only when the class row is genuinely missing. A real
 * RPC error is surfaced rather than swallowed: silently falling back on error would build repos
 * from the wrong template and defeat the per-org feature with no signal. The "no override
 * configured" case never reaches the fallback — it is handled inside the RPC via COALESCE.
 */
export async function resolveTemplateRepos(
  supabase: SupabaseClient<Database>,
  classId: number
): Promise<{ handout: string; solution: string }> {
  const { data, error } = await supabase.rpc("resolve_class_template_repos", { p_class_id: classId });
  if (error) {
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    // No row => the class itself is missing. The RPC always returns COALESCEd (non-null)
    // template values for an existing class, so a present row never needs this fallback.
    console.warn(`resolveTemplateRepos: no row for class ${classId}; using hardcoded defaults`);
    return { handout: DEFAULT_HANDOUT_TEMPLATE_REPO, solution: DEFAULT_SOLUTION_TEMPLATE_REPO };
  }
  return {
    handout: row.handout_template_repo ?? DEFAULT_HANDOUT_TEMPLATE_REPO,
    solution: row.solution_template_repo ?? DEFAULT_SOLUTION_TEMPLATE_REPO
  };
}
