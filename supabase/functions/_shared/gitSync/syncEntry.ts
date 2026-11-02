/**
 * `syncRepositoryToHandoutGit`: the git engine behind the `SyncResult` contract of
 * `syncRepositoryToHandout` (docs/handout-sync-git-worker.md §4, §5.9, §7, §8.2-§8.4).
 *
 * The handler calls this instead of the REST function when the message came off the
 * `handout_sync` queue, and branches on the result exactly as it does today. Everything that
 * reaches the repository's content is git (`engine.ts`). What is left over REST is metadata: two
 * repo-size reads, the branch-safety compare, the pull request lookup, creation and merge, and the
 * App's bot account. Every one of those goes to the student repo with the student token, except
 * the template's size read, which uses the template token.
 *
 * Order of a job:
 *
 * 1. Validate the names and SHAs. Nothing has been asked of GitHub yet.
 * 2. Refuse a template that is the assignment's grader repo or the class's solution template
 *    (§8.3), from the database.
 * 3. Mint two installation tokens (§8.2): first a template token from the template org's
 *    installation that can only read the template, then a student token for the student repo
 *    that can write. Read each repo's size with its own token (§8.4), the template's before the
 *    student token exists.
 * 4. Plan. Before pushing, return early if a PR on the branch was already merged at this commit,
 *    or if main already holds the handout's content at every path the update touches. Otherwise
 *    push with a compare-and-swap (§5.8). The job directory is gone before step 5.
 * 5. Find or open the pull request and merge it (§5.9). Only this step runs under the per-org
 *    limiters; the git work holds neither. The step 4 PR lookup is a single read and runs
 *    without them.
 *
 * Failures come back as `SyncResult`, never as a throw, as they do from the REST function:
 * `success: false` with `terminal_reason` for a `TerminalSyncError`, and without it for anything
 * a retry may fix.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Octokit } from "npm:octokit";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import {
  getSyncLimiter,
  renderSyncPullRequestBody,
  resolveTemplateRepos,
  SyncBranchNotOursError,
  type SyncResult,
  syncPullRequestTitle,
  TerminalSyncError
} from "../GitHubSyncHelpers.ts";
import * as github from "../GitHubWrapper.ts";
import type { Database } from "../SupabaseTypes.d.ts";
import {
  isOurSyncCommit,
  isSyncBranchSafeToReset,
  resolveAutoMerge,
  type SyncBranchCommit
} from "../syncConflictGuard.ts";
import {
  type CommitPlan,
  HandoutBaseUnfetchableError,
  HandoutRevisionUnfetchableError,
  planHandoutSync,
  type SyncAnalysis,
  type SyncJob,
  type SyncJobContext,
  withSyncJob
} from "./engine.ts";
import { type GitFailureKind, GitSyncError, GitSyncTerminalError } from "./errors.ts";
import type { GitIdentity, GitLogger, RemoteConfig } from "./runGit.ts";
import { TemplateCache } from "./templateCache.ts";
import { validateRepoFullName, validateSha } from "./validate.ts";

/** The queue whose messages take the git path. Every other queue takes the REST path. */
export const HANDOUT_SYNC_QUEUE = "handout_sync";

/** Which engine runs a `sync_repo_to_handout` message from `queueName` (build plan D3). */
export function handoutSyncEngineFor(queueName: string | undefined): "git" | "rest" {
  return queueName === HANDOUT_SYNC_QUEUE ? "git" : "rest";
}

/** `HANDOUT_SYNC_MAX_REPO_KIB` default: 2 GiB (build plan D4). */
export const DEFAULT_MAX_REPO_KIB = 2 * 1024 * 1024;

/**
 * `H` or `F` unfetchable becomes terminal once the envelope's `retry_count` reaches this (§7). The
 * handler dead-letters a generic failure at the same count, so a sync never gets a sixth attempt to
 * report the revision as missing.
 */
export const UNFETCHABLE_TERMINAL_RETRY_COUNT = 5;

/**
 * Exactly what a sync job's student token may do (§8.2). `workflows` is needed to push `grade.yml`.
 * Scoped to the student repo alone.
 */
export const SYNC_TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  workflows: "write"
} as const satisfies github.InstallationTokenPermissions;

/** What a sync job's template token may do: read the template repo, and nothing else. */
export const TEMPLATE_TOKEN_PERMISSIONS = { contents: "read" } as const satisfies github.InstallationTokenPermissions;

export interface SyncRepositoryToHandoutGitParams {
  repositoryFullName: string;
  templateRepo: string;
  fromSha: string | null;
  toSha: string;
  syncedRepoSha: string | null;
  adminSupabase: SupabaseClient<Database>;
  autoMerge?: boolean;
  waitBeforeMerge?: number;
  scope?: Sentry.Scope;
  /** Accepted for signature parity and ignored: the engine always diffs two trees (§4, §5.3). */
  diffStrategy?: "descendant" | "rewritten";
  /** `repositories.id`, to find the assignment and class for the solution-repo check (§8.3). */
  repositoryId: number;
  /** The envelope's `retry_count`, which decides when an unfetchable revision is terminal (§7). */
  retryCount: number;
  /** Names the job's directory and its log lines. The pgmq message id. */
  jobId: string;
}

/** Where jobs run. One per process, because the template cache's mutex must be process-wide. */
export interface HandoutSyncGitRuntime {
  jobsDir: string;
  templateCache: TemplateCache;
  /** Defaults to GitHub over https. Tests pass `file://` remotes. */
  remote?: RemoteConfig;
  maxMergeBytes?: number;
  maxRepoKib: number;
  /**
   * The job's deadline signal (§3.1), keyed by the `jobId` the handler passes in, which is the
   * pgmq msg_id as a string. `processEnvelope` cannot carry an `AbortSignal`, so the worker
   * answers this from the `AbortController` it created for that message, and the engine kills
   * the job's git children when it fires. Undefined means no deadline.
   */
  signalFor?: (jobId: string) => AbortSignal | undefined;
  /** Every git call's log entry. The worker counts them for `/metrics`; unset, runGit logs them. */
  gitLog?: GitLogger;
}

let configuredRuntime: HandoutSyncGitRuntime | undefined;
let configuredTestDeps: Partial<GitSyncDeps> | undefined;

/**
 * Sets the runtime the git path uses. The worker calls this once at startup; without it the
 * first job builds one from the environment (`HANDOUT_SYNC_WORK_DIR`, default `/work`).
 *
 * `testOnly.deps` replaces parts of `defaultGitSyncDeps()` for every later call that does not
 * pass its own deps, which is how a worker started by a test reaches stubbed GitHub REST through
 * `processEnvelope`. The worker's production entry point never passes it.
 */
export function configureHandoutSyncGit(
  runtime: HandoutSyncGitRuntime,
  opts: { testOnly?: { deps?: Partial<GitSyncDeps> } } = {}
): void {
  configuredRuntime = runtime;
  configuredTestDeps = opts.testOnly?.deps;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    console.warn(`${name}=${JSON.stringify(raw)} is not a positive integer; using ${fallback}`);
    return fallback;
  }
  return n;
}

function runtimeFromEnv(): HandoutSyncGitRuntime {
  if (!configuredRuntime) {
    const root = Deno.env.get("HANDOUT_SYNC_WORK_DIR") || "/work";
    configuredRuntime = {
      jobsDir: `${root}/jobs`,
      templateCache: new TemplateCache(`${root}/templates`),
      maxMergeBytes: positiveIntFromEnv("HANDOUT_SYNC_MAX_MERGE_BYTES", 8 * 1024 * 1024),
      maxRepoKib: positiveIntFromEnv("HANDOUT_SYNC_MAX_REPO_KIB", DEFAULT_MAX_REPO_KIB)
    };
  }
  return configuredRuntime;
}

/** The part of an Octokit this module calls. Tests pass a stub with the same `request`. */
export type GitSyncOctokit = Pick<Octokit, "request">;

/** A Bottleneck, as far as this module uses one. */
export interface Schedulable {
  schedule<T>(fn: () => Promise<T>): Promise<T>;
}

/** What the git path solution-repo check compares the template against (§8.3). */
export interface SolutionRepos {
  /** `autograder.grader_repo` for the repository's assignment, when it has one. */
  graderRepo: string | null;
  /** The class's resolved `solution_template_repo`. */
  solutionTemplateRepo: string | null;
}

/**
 * Everything this module reaches outside itself. Production uses `defaultGitSyncDeps`; tests
 * replace the REST and database edges and keep git real.
 */
export interface GitSyncDeps {
  runtime: () => HandoutSyncGitRuntime;
  getScopedToken: (
    org: string,
    repositories: readonly string[],
    permissions: github.InstallationTokenPermissions,
    scope?: Sentry.Scope
  ) => Promise<github.ScopedInstallationToken>;
  octokitForToken: (token: string, scope?: Sentry.Scope) => GitSyncOctokit;
  appSlug: (scope?: Sentry.Scope) => Promise<string | undefined>;
  loadSolutionRepos: (adminSupabase: SupabaseClient<Database>, repositoryId: number) => Promise<SolutionRepos>;
  syncLimiter: (org: string) => Schedulable;
  contentLimiter: (org: string) => Schedulable;
  sleep: (ms: number) => Promise<void>;
  captureException: (error: unknown, scope?: Sentry.Scope) => void;
  /** Merged into the engine's job context. Tests set `log`, `gitLog` and `testOnly` here. */
  engineContext?: Partial<SyncJobContext>;
}

/** Reads the assignment's grader repo and the class's solution template for one repository. */
export async function loadSolutionRepos(
  adminSupabase: SupabaseClient<Database>,
  repositoryId: number
): Promise<SolutionRepos> {
  const { data: repo, error } = await adminSupabase
    .from("repositories")
    .select("assignment_id, class_id")
    .eq("id", repositoryId)
    .maybeSingle();
  if (error) throw error;
  // Retryable: the handler re-reads the row first on the next attempt and drops a job whose
  // repository has gone.
  if (!repo) throw new Error(`repository ${repositoryId} not found while checking the template against the grader`);
  const { data: autograder, error: autograderError } = await adminSupabase
    .from("autograder")
    .select("grader_repo")
    .eq("id", repo.assignment_id)
    .maybeSingle();
  if (autograderError) throw autograderError;
  const { solution } = await resolveTemplateRepos(adminSupabase, repo.class_id);
  return { graderRepo: autograder?.grader_repo ?? null, solutionTemplateRepo: solution };
}

export function defaultGitSyncDeps(): GitSyncDeps {
  const deps: GitSyncDeps = {
    runtime: runtimeFromEnv,
    getScopedToken: github.getScopedInstallationToken,
    octokitForToken: github.octokitForInstallationToken,
    appSlug: github.getAppSlug,
    loadSolutionRepos,
    syncLimiter: getSyncLimiter,
    contentLimiter: github.getCreateContentLimiter,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    captureException: (error, scope) => {
      Sentry.captureException(error, scope);
    }
  };
  return configuredTestDeps ? { ...deps, ...configuredTestDeps } : deps;
}

// ---------------------------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------------------------

/** What the git half of a job hands to the pull request half, after the job directory is gone. */
interface Pushed {
  kind: "pushed";
  plan: Pick<CommitPlan, "branch" | "commit" | "unresolved">;
  analysis: SyncAnalysis;
}

export async function syncRepositoryToHandoutGit(
  params: SyncRepositoryToHandoutGitParams,
  deps: GitSyncDeps = defaultGitSyncDeps()
): Promise<SyncResult> {
  const {
    repositoryFullName,
    templateRepo,
    fromSha,
    toSha,
    syncedRepoSha,
    autoMerge = true,
    waitBeforeMerge = 2000,
    scope,
    retryCount,
    jobId
  } = params;
  // Named fields only: `params` carries `adminSupabase`, and logging the client prints the
  // service_role key into the logs (#1144). The token never enters `params` at all.
  console.log("syncRepositoryToHandoutGit", {
    repositoryFullName,
    templateRepo,
    fromSha,
    toSha,
    syncedRepoSha,
    autoMerge,
    retryCount,
    jobId
  });
  scope?.setTag("repository", repositoryFullName);
  scope?.setTag("template_repo", templateRepo);
  scope?.setTag("from_sha", fromSha);
  scope?.setTag("to_sha", toSha);
  scope?.setTag("synced_repo_sha", syncedRepoSha ?? "none");
  scope?.setTag("auto_merge", String(autoMerge));
  scope?.setTag("sync_operation", "sync_repository_to_handout");
  scope?.setTag("sync_engine", "git");

  try {
    const { repo, template, org, octokit, ctx } = await prepareGitJob(params, SYNC_TOKEN_PERMISSIONS, deps, scope);
    // 4. The git work. No limiter is held here.
    const outcome = await withSyncJob(ctx, async (job): Promise<SyncResult | Pushed> => {
      const plan = await job.plan({ templateRepo: template, fromSha, toSha, syncedRepoSha, repoFullName: repo });
      for (const [tag, value] of Object.entries(plan.analysis.tags)) scope?.setTag(tag, value);
      scope?.setTag("baseline_sha", plan.analysis.baselineSha);
      if (plan.kind === "no_changes") return { success: true, no_changes: true };
      if (plan.kind === "nothing_survived") {
        return await blockedByStudentChanges(
          job,
          plan.analysis,
          plan.unresolved.map((f) => f.path),
          scope
        );
      }
      scope?.setTag("sync_commit", plan.commit);

      // A crash-after-merge retry rebuilds the same commit. Report the merge before pushing:
      // pushing first would recreate a branch GitHub auto-deleted on merge (§5.9).
      const mergedOurs = await findMergedSyncPullRequest(octokit, repo, plan.branch, plan.commit);
      if (mergedOurs) return mergedResult(mergedOurs, repo, plan.commit, scope);

      // REST's `isRepoAlreadyInSync`: someone already brought every path this update touches to
      // the handout's content at the head of main. Opening a PR would merge an empty diff, so this
      // is an ordinary no_changes, with the head the decision was read from. The paths left to
      // the student count too: recording the revision as delivered while one of them still
      // differs would lose the only record that it was not.
      const touched = [...plan.changedFiles, ...plan.unresolved.map((f) => f.path)];
      const current = await job.classifyPathsAgainstHead(plan.analysis, touched);
      if (current.stillDiffering.size === 0) {
        scope?.setTag("already_in_sync", "true");
        scope?.addBreadcrumb({
          message: `Repository ${repo} already holds the handout's content at ${toSha.substring(0, 7)}`,
          category: "sync",
          level: "info"
        });
        return { success: true, no_changes: true, repo_head_sha: current.headSha };
      }

      const pushed = await job.push(plan, {
        confirmResetSafe: ({ head, base }) => confirmResetSafe(octokit, repo, plan.branch, base, head, scope)
      });
      scope?.setTag("sync_branch_pushed", String(pushed.pushed));
      return { kind: "pushed", plan, analysis: plan.analysis };
    });
    if (!("kind" in outcome)) return outcome;

    // 5. The pull request, under both limiters and nothing else.
    return await deps.syncLimiter(org).schedule(() =>
      deps.contentLimiter(org).schedule(() =>
        deliverPullRequest({
          octokit,
          repo,
          pushed: outcome,
          fromSha,
          toSha,
          syncedRepoSha,
          autoMerge,
          waitBeforeMerge,
          sleep: deps.sleep,
          scope
        })
      )
    );
  } catch (caught) {
    // Every engine failure's kind, retryable or not, so `disk_full`, `auth_failed` and
    // `lease_rejected` can be told apart in Sentry and metrics (§7).
    if (caught instanceof GitSyncError) scope?.setTag("sync_git_error_kind", caught.kind);
    const error = toSyncError(caught, retryCount);
    console.trace(error);
    if (error instanceof TerminalSyncError) scope?.setTag("terminal_sync_reason", error.reason);
    deps.captureException(error, scope);
    const redeliver =
      error instanceof GitSyncError && error.retryable && REDELIVERY_KINDS.has(error.kind) ? error.kind : undefined;
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      terminal_reason: error instanceof TerminalSyncError ? error.reason : undefined,
      redeliver_kind: redeliver
    };
  }
}

/**
 * Retryable engine failures that say nothing about GitHub's health, so they must not reach the
 * handler's generic error path, whose requeue opens the org's `sync_repo_to_handout` circuit. The
 * handler records the kind on the row and the message comes back after one visibility timeout;
 * the worker's read cap (`HANDOUT_SYNC_MAX_READ_COUNT`) dead-letters one that keeps failing.
 *
 * Not listed, so they keep the generic path: `network`, `auth_failed` and `remote_repo_not_found`,
 * which are about GitHub or the installation, and `unfetchable`, which `toSyncError` turns
 * terminal after five retries counted by `retry_count`.
 */
export const REDELIVERY_KINDS: ReadonlySet<GitFailureKind> = new Set<GitFailureKind>([
  "deadline_exceeded",
  "disk_full",
  "lease_rejected",
  "reset_check_mismatch",
  "spawn_failed",
  "output_cap_exceeded",
  "git_failed",
  "timeout"
]);

/** What `prepareGitJob` hands to the git work: validated names, the student octokit, the context. */
interface PreparedGitJob {
  repo: string;
  template: string;
  org: string;
  octokit: GitSyncOctokit;
  ctx: SyncJobContext;
}

/**
 * Steps 1 to 3 of a job, shared by the sync and by the shadow plan: validate, refuse a grader
 * template, mint both tokens, check both sizes and resolve the bot identity. `studentPermissions`
 * is the only difference between the two callers. Throws; the callers map the error.
 */
async function prepareGitJob(
  params: Pick<
    SyncRepositoryToHandoutGitParams,
    | "repositoryFullName"
    | "templateRepo"
    | "fromSha"
    | "toSha"
    | "syncedRepoSha"
    | "adminSupabase"
    | "repositoryId"
    | "jobId"
  >,
  studentPermissions: github.InstallationTokenPermissions,
  deps: GitSyncDeps,
  scope?: Sentry.Scope
): Promise<PreparedGitJob> {
  const { repositoryFullName, templateRepo, fromSha, toSha, syncedRepoSha, adminSupabase, repositoryId, jobId } =
    params;
  // 1. Inputs. `InvalidSyncInputError` is a `GitSyncTerminalError`, mapped by the caller.
  const repo = validateRepoFullName(repositoryFullName, "repository");
  const template = validateRepoFullName(templateRepo, "template repo");
  validateSha(toSha, "to sha");
  if (fromSha !== null) validateSha(fromSha, "from sha");
  if (syncedRepoSha !== null) validateSha(syncedRepoSha, "synced repo sha");
  const [org, repoName] = repo.split("/");
  const [templateOrg, templateName] = template.split("/");

  // 2. The template must not be the grader (§8.3).
  const solution = await deps.loadSolutionRepos(adminSupabase, repositoryId);
  for (const [column, candidate] of [
    ["autograder.grader_repo", solution.graderRepo],
    ["solution_template_repo", solution.solutionTemplateRepo]
  ] as const) {
    if (candidate && candidate.toLowerCase() === template.toLowerCase()) {
      throw new TerminalSyncError(
        `Refusing to sync ${repo} from ${template}: it is this assignment's ${column}, and syncing it ` +
          `would push the solution and hidden tests into the student's repository. Set the assignment's ` +
          `handout repository to the handout, not the grader.`,
        "template_is_solution_repo"
      );
    }
  }

  // 3. Two tokens, one per side, and both repos' sizes (§8.2, §8.4). Separate even when both
  // repos are in one org, so the student token never reaches the template. The template token
  // comes from the template org's installation, so a handout an assignment inherited from
  // another org's class still syncs. The read-only template side goes first: a template that
  // is too large stops the job before a token that can write to the student repo exists.
  const runtime = deps.runtime();
  const { token: templateToken } = await deps.getScopedToken(
    templateOrg,
    [templateName],
    TEMPLATE_TOKEN_PERMISSIONS,
    scope
  );
  const templateOctokit = deps.octokitForToken(templateToken, scope);
  await assertRepoWithinSizeLimit(templateOctokit, template, runtime.maxRepoKib, scope);
  const { token } = await deps.getScopedToken(org, [repoName], studentPermissions, scope);
  const octokit = deps.octokitForToken(token, scope);
  await assertRepoWithinSizeLimit(octokit, repo, runtime.maxRepoKib, scope);
  const identity = await resolveBotIdentity(octokit, deps, scope);

  const ctx: SyncJobContext = {
    jobId: jobIdFor(jobId),
    jobsDir: runtime.jobsDir,
    templateCache: runtime.templateCache,
    remote: runtime.remote,
    maxMergeBytes: runtime.maxMergeBytes,
    signal: runtime.signalFor?.(String(jobId)),
    gitLog: runtime.gitLog,
    token,
    templateToken,
    identity,
    ...deps.engineContext
  };
  return { repo, template, org, octokit, ctx };
}

// ---------------------------------------------------------------------------------------------
// Shadow mode (build plan S2)
// ---------------------------------------------------------------------------------------------

/**
 * What a shadow job may do with the student repo: read it. The plan fetches and builds objects in
 * the job's own repo and never pushes, so the token cannot write even if a bug tried.
 */
export const SHADOW_STUDENT_TOKEN_PERMISSIONS = {
  contents: "read"
} as const satisfies github.InstallationTokenPermissions;

/** One `handout_sync_shadow_results` prediction, before the worker adds the message's ids. */
export interface ShadowPrediction {
  /**
   * The tree the sync commit would have, or null when there would be no commit: `no_changes` (and
   * `unresolved` empty) or every file left to the student (`unresolved` non-empty).
   */
  predicted_tree: string | null;
  /** The commit's parent, the baseline `S` the engine resolved, or null when there would be no commit. */
  predicted_commit_parent: string | null;
  /** Files the engine would leave to the student. Empty for `no_changes`; null after an error. */
  unresolved: Array<{ path: string; reason: string }> | null;
  /** Set when the plan failed, with the `terminal_reason` prefixed when it was terminal. */
  error: string | null;
}

/**
 * Plan-only twin of `syncRepositoryToHandoutGit` for a message marked `shadow` (build plan S2):
 * the same pre-checks and the same plan, with read-only tokens, then nothing. No push, no pull
 * request, no REST write and no database write; the worker records the prediction.
 *
 * Never throws: a failure is the prediction's `error`, because a shadow run is an observation and
 * is not retried.
 */
export async function planRepositoryToHandoutGit(
  params: Omit<SyncRepositoryToHandoutGitParams, "autoMerge" | "waitBeforeMerge" | "diffStrategy">,
  deps: GitSyncDeps = defaultGitSyncDeps()
): Promise<ShadowPrediction> {
  const { fromSha, toSha, syncedRepoSha, scope, retryCount } = params;
  scope?.setTag("sync_operation", "shadow_plan");
  scope?.setTag("sync_engine", "git");
  try {
    const { repo, template, ctx } = await prepareGitJob(params, SHADOW_STUDENT_TOKEN_PERMISSIONS, deps, scope);
    const plan = await planHandoutSync(
      { templateRepo: template, fromSha, toSha, syncedRepoSha, repoFullName: repo },
      ctx
    );
    const unresolved = (plan.kind === "no_changes" ? [] : plan.unresolved).map((f) => ({
      path: f.path,
      reason: f.reason
    }));
    return {
      predicted_tree: plan.kind === "commit" ? plan.tree : null,
      predicted_commit_parent: plan.kind === "commit" ? plan.parent : null,
      unresolved,
      error: null
    };
  } catch (caught) {
    const error = toSyncError(caught, retryCount);
    const message = error instanceof Error ? error.message : String(error);
    return {
      predicted_tree: null,
      predicted_commit_parent: null,
      unresolved: null,
      error: error instanceof TerminalSyncError ? `${error.reason}: ${message}` : message
    };
  }
}

/**
 * §7: the engine's errors onto the handler's. A `GitSyncTerminalError` keeps its `reason`. An
 * unfetchable `H` or `F` stays retryable until the envelope has been retried
 * `UNFETCHABLE_TERMINAL_RETRY_COUNT` times, then becomes terminal. Everything else is returned
 * unchanged, which the caller reports as retryable.
 */
export function toSyncError(error: unknown, retryCount: number): unknown {
  if (error instanceof GitSyncTerminalError) return new TerminalSyncError(error.message, error.reason);
  const exhausted = retryCount >= UNFETCHABLE_TERMINAL_RETRY_COUNT;
  if (error instanceof HandoutRevisionUnfetchableError && exhausted) {
    return new TerminalSyncError(
      `${error.message} after ${retryCount} retries. The handout revision was probably force-pushed away; ` +
        `push the handout again to sync its current revision.`,
      "handout_revision_missing"
    );
  }
  if (error instanceof HandoutBaseUnfetchableError && exhausted) {
    return new TerminalSyncError(
      `${error.message} after ${retryCount} retries. The handout's history was rewritten and the revision ` +
        `this repository was last synced to is gone, so there is nothing to compare the update against.`,
      "handout_base_missing"
    );
  }
  return error;
}

/** The engine's job id grammar. pgmq ids are numbers, so this only guards a caller's mistake. */
function jobIdFor(jobId: string): string {
  const safe = String(jobId)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 60);
  return `msg-${safe || "unknown"}`;
}

// ---------------------------------------------------------------------------------------------
// Pre-checks
// ---------------------------------------------------------------------------------------------

/** §8.4: GitHub's `size` (KiB, roughly the packed size) against the ceiling, before any fetch. */
async function assertRepoWithinSizeLimit(
  octokit: GitSyncOctokit,
  fullName: string,
  maxKib: number,
  scope?: Sentry.Scope
): Promise<void> {
  const [owner, repo] = fullName.split("/");
  const { data } = await octokit.request("GET /repos/{owner}/{repo}", { owner, repo });
  const size = typeof data.size === "number" ? data.size : 0;
  if (size > maxKib) {
    scope?.setTag("repo_too_large", fullName);
    throw new TerminalSyncError(
      `${fullName} is ${(size / 1024).toFixed(0)} MiB on GitHub, over the handout sync's limit of ` +
        `${(maxKib / 1024).toFixed(0)} MiB (HANDOUT_SYNC_MAX_REPO_KIB). Remove the large files from its ` +
        `history, or sync this repository by hand.`,
      "repo_too_large"
    );
  }
}

let botIdentity: Promise<GitIdentity> | undefined;

/**
 * The App's bot account as a commit identity: `<slug>[bot]` and its noreply address keyed on the
 * account id, which is what makes GitHub attribute the commit to the bot (type "Bot"), as
 * `isOurSyncCommit` requires. Resolved once per process; a failure is not cached.
 */
async function resolveBotIdentity(
  octokit: GitSyncOctokit,
  deps: Pick<GitSyncDeps, "appSlug">,
  scope?: Sentry.Scope
): Promise<GitIdentity> {
  botIdentity ??= (async () => {
    const slug = await deps.appSlug(scope);
    if (!slug) throw new Error("Cannot resolve the GitHub App's slug (GITHUB_APP_SLUG or GET /app)");
    const login = `${slug}[bot]`;
    const { data } = await octokit.request("GET /users/{username}", { username: login });
    return { name: login, email: `${data.id}+${login}@users.noreply.github.com` };
  })();
  try {
    return await botIdentity;
  } catch (e) {
    botIdentity = undefined;
    throw e;
  }
}

/** Test-only: forget the cached bot identity. */
export function resetBotIdentityForTesting(): void {
  botIdentity = undefined;
}

// ---------------------------------------------------------------------------------------------
// §5.8 branch safety and §6.3 blocked recheck
// ---------------------------------------------------------------------------------------------

/**
 * The REST branch-safety check for exactly `head`, the sha `ls-remote` read. Never re-reads the
 * branch: see `PushOptions.confirmResetSafe` for the lost student commit a fresh read can cause.
 * Same verdicts as `assertSyncBranchSafeToReset`, including treating a truncated compare as unsafe.
 */
export async function confirmResetSafe(
  octokit: GitSyncOctokit,
  repoFullName: string,
  branchName: string,
  base: string,
  head: string,
  scope?: Sentry.Scope
): Promise<string> {
  const [owner, repo] = repoFullName.split("/");
  const { data: comparison } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner,
    repo,
    basehead: `${base}...${head}`
  });
  const totalCommits = comparison.total_commits ?? comparison.commits?.length ?? 0;
  const readCommits = comparison.commits?.length ?? 0;
  if (totalCommits > readCommits) {
    scope?.setTag("sync_branch_commits_truncated", "true");
    throw new SyncBranchNotOursError(repoFullName, branchName, [
      `${totalCommits} commit(s) ahead of the base, of which GitHub returned only ${readCommits}; ` +
        `the rest cannot be inspected`
    ]);
  }
  const commits: SyncBranchCommit[] = (comparison.commits ?? []).map((c) => ({
    subject: (c.commit?.message ?? "").split("\n")[0],
    authorType: c.author?.type,
    committerLogin: c.committer?.login,
    committerType: c.committer?.type,
    verified: c.commit?.verification?.verified
  }));
  if (isSyncBranchSafeToReset(commits)) return head;
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
 * `blockedByStudentChanges` from the REST path, with its `findStudentModifiedFiles(head, H, …)`
 * answered from the `main` this job fetched (§6.3). The same two outcomes: `no_changes` with the
 * head the decision was read from, or blocked with the paths that still differ.
 */
async function blockedByStudentChanges(
  job: SyncJob,
  analysis: SyncAnalysis,
  unresolvedPaths: string[],
  scope?: Sentry.Scope
): Promise<SyncResult> {
  const { repoFullName, toSha } = analysis.input;
  const { headSha, stillDiffering } = await job.classifyPathsAgainstHead(analysis, unresolvedPaths);
  if (stillDiffering.size === 0) {
    scope?.setTag("blocked_paths_already_current", "true");
    scope?.addBreadcrumb({
      message:
        `${repoFullName} already holds the handout's version of every path this update ` +
        `touches; recording it as synced rather than blocked`,
      category: "sync",
      level: "info"
    });
    return { success: true, no_changes: true, repo_head_sha: headSha };
  }
  const blockingPaths = Array.from(stillDiffering.keys());
  scope?.setTag("sync_blocked_by_student_changes", "true");
  scope?.addBreadcrumb({
    message:
      `Every file in this update is the student's own work in ${repoFullName} ` +
      `(${blockingPaths.join(", ")}); nothing can be merged and nothing was written`,
    category: "sync",
    level: "warning"
  });
  console.warn(
    `[sync] ${repoFullName}: handout update ${toSha.substring(0, 7)} not delivered, ` +
      `all ${blockingPaths.length} changed file(s) are the student's own work`
  );
  return { success: true, blocked_by_student_changes: true, unresolved_paths: blockingPaths };
}

// ---------------------------------------------------------------------------------------------
// §5.9 pull request and merge
// ---------------------------------------------------------------------------------------------

/** One entry of `GET /repos/{owner}/{repo}/pulls`, as far as this module reads it. */
interface SyncPullRequest {
  number: number;
  html_url: string;
  state: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { sha: string };
}

/**
 * Every pull request, open or closed, whose head is `branchName` in the student's repo, newest
 * first. Unlike `findExistingSyncPR`, a failed read throws: going on to create a PR without knowing
 * whether one was already merged is the crash-after-merge case §5.9 exists to fix.
 */
async function listSyncPullRequests(
  octokit: GitSyncOctokit,
  repoFullName: string,
  branchName: string
): Promise<SyncPullRequest[]> {
  const [owner, repo] = repoFullName.split("/");
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/pulls", {
    owner,
    repo,
    head: `${owner}:${branchName}`,
    state: "all"
  });
  return data as SyncPullRequest[];
}

/**
 * Merged, and merged at `commit`. A PR closed without merging is not one, even at the same head:
 * as on the REST path, that falls through to opening a new PR.
 */
function isMergedAt(pr: SyncPullRequest, commit: string): boolean {
  return pr.merged_at !== null && pr.head.sha === commit;
}

/** The PR on `branchName` that was merged at `commit`, if any. */
async function findMergedSyncPullRequest(
  octokit: GitSyncOctokit,
  repoFullName: string,
  branchName: string,
  commit: string
): Promise<SyncPullRequest | undefined> {
  return (await listSyncPullRequests(octokit, repoFullName, branchName)).find((pr) => isMergedAt(pr, commit));
}

/**
 * The result for a PR already merged at this job's commit: a retry of a job that merged and died
 * before the row was written. It carries `merge_sha` so the handler moves both halves of the
 * baseline pair.
 */
function mergedResult(pr: SyncPullRequest, repo: string, commit: string, scope?: Sentry.Scope): SyncResult {
  scope?.addBreadcrumb({
    message: `Found already-merged PR #${pr.number} for ${repo} at ${commit.substring(0, 7)}`,
    category: "sync",
    level: "info"
  });
  return {
    success: true,
    pr_number: pr.number,
    pr_url: pr.html_url,
    merged: true,
    merge_sha: pr.merge_commit_sha || undefined
  };
}

/** `attemptAutoMerge` with the merge pinned to `expectedHead`, the commit this job pushed. */
async function attemptAutoMerge(
  octokit: GitSyncOctokit,
  repoFullName: string,
  prNumber: number,
  expectedHead: string,
  scope?: Sentry.Scope
): Promise<{ merged: boolean; mergeSha?: string }> {
  const [owner, repo] = repoFullName.split("/");
  const { data: pr } = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber
  });
  if (!pr.mergeable) return { merged: false };
  try {
    // The commit this job built and pushed, not the head the read above returned: a student who
    // pushed onto the branch since gets a 409 here and their commit stays unmerged, for a person
    // to review.
    const { data: mergeResult } = await octokit.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
      owner,
      repo,
      pull_number: prNumber,
      merge_method: "merge",
      sha: expectedHead
    });
    return { merged: true, mergeSha: mergeResult.sha };
  } catch (error) {
    const status = error && typeof error === "object" && "status" in error ? (error as { status: number }).status : 0;
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

async function deleteSyncBranch(octokit: GitSyncOctokit, repoFullName: string, branchName: string): Promise<void> {
  const [owner, repo] = repoFullName.split("/");
  try {
    await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", { owner, repo, ref: `heads/${branchName}` });
  } catch {
    // Ignore cleanup errors, as the REST path does.
  }
}

async function deliverPullRequest(args: {
  octokit: GitSyncOctokit;
  repo: string;
  pushed: Pushed;
  fromSha: string | null;
  toSha: string;
  syncedRepoSha: string | null;
  autoMerge: boolean;
  waitBeforeMerge: number;
  sleep: (ms: number) => Promise<void>;
  scope?: Sentry.Scope;
}): Promise<SyncResult> {
  const { octokit, repo, pushed, fromSha, toSha, syncedRepoSha, autoMerge, waitBeforeMerge, sleep, scope } = args;
  const { branch, commit, unresolved } = pushed.plan;
  const unresolvedPaths = unresolved.length > 0 ? unresolved.map((f) => f.path) : undefined;

  // §5.9: the lookup comes before creation, again after the push, for a merge that landed while
  // this job was pushing.
  const existing = await listSyncPullRequests(octokit, repo, branch);
  const mergedOurs = existing.find((pr) => isMergedAt(pr, commit));
  if (mergedOurs) return mergedResult(mergedOurs, repo, commit, scope);

  const effectiveAutoMerge = resolveAutoMerge(autoMerge, unresolved);
  scope?.setTag("unresolved_file_count", String(unresolved.length));
  scope?.setTag("effective_auto_merge", String(effectiveAutoMerge));
  if (autoMerge && !effectiveAutoMerge) {
    scope?.addBreadcrumb({
      message:
        `Auto-merge disabled for ${repo}: ${unresolved.length} file(s) are the student's own ` +
        `work and were left untouched (${unresolved.map((f) => f.path).join(", ")})`,
      category: "sync",
      level: "info"
    });
    console.log(`[sync] ${repo}: holding PR open, ${unresolved.length} file(s) left to the student`);
  }

  const [owner, name] = repo.split("/");
  const body = renderSyncPullRequestBody({
    toSha,
    fromSha,
    baselineSha: pushed.analysis.baselineSha,
    baselineWasRecorded: !!syncedRepoSha,
    changedFiles: pushed.analysis.files.map((f) => f.change),
    unresolved,
    effectiveAutoMerge
  });
  // A reused PR was opened by an earlier attempt, whose body may describe a different set of
  // files or say it will be auto-merged when this attempt will not. Rewrite it to this attempt's.
  const refreshBody = async (prNumber: number) => {
    await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo: name,
      pull_number: prNumber,
      body
    });
  };

  let prNumber: number;
  let prUrl: string;
  const open = existing.find((pr) => pr.state === "open");
  if (open) {
    // The branch now carries this job's commit, so the open PR already shows it.
    scope?.addBreadcrumb({ message: `Reusing open PR #${open.number} for ${repo}`, category: "sync", level: "info" });
    prNumber = open.number;
    prUrl = open.html_url;
    await refreshBody(prNumber);
  } else {
    try {
      const { data: pr } = await octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo: name,
        title: syncPullRequestTitle(toSha),
        body,
        head: branch,
        base: "main"
      });
      prNumber = pr.number;
      prUrl = `https://github.com/${repo}/pull/${prNumber}`;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes("No commits between")) {
        scope?.addBreadcrumb({
          message: `No commits between branches - repository already up to date`,
          category: "sync",
          level: "info"
        });
        await deleteSyncBranch(octokit, repo, branch);
        // GitHub refuses because this commit is already in main's history, so it is the commit
        // that delivered the update and the baseline to record with it. Not the head of main,
        // which may hold later student commits that must stay outside the baseline (§6.2).
        return { success: true, no_changes: true, repo_head_sha: commit };
      }
      if (!errorMessage.includes("A pull request already exists") && !errorMessage.includes("already exists for")) {
        throw error;
      }
      // Another job opened it between the lookup and the create.
      scope?.addBreadcrumb({
        message: `PR already exists for branch ${branch}, looking up existing PR`,
        category: "sync",
        level: "info"
      });
      const again = await listSyncPullRequests(octokit, repo, branch);
      const mergedNow = again.find((pr) => isMergedAt(pr, commit));
      if (mergedNow) return mergedResult(mergedNow, repo, commit, scope);
      const openNow = again.find((pr) => pr.state === "open");
      if (!openNow) throw error;
      prNumber = openNow.number;
      prUrl = openNow.html_url;
      await refreshBody(prNumber);
    }
  }

  let merged = false;
  let mergeSha: string | undefined;
  if (effectiveAutoMerge) {
    // Wait for GitHub to update mergeable state.
    await sleep(waitBeforeMerge);
    const result = await attemptAutoMerge(octokit, repo, prNumber, commit, scope);
    merged = result.merged;
    mergeSha = result.mergeSha;
  }
  return {
    success: true,
    pr_number: prNumber,
    pr_url: prUrl,
    merged,
    merge_sha: mergeSha,
    unresolved_paths: unresolvedPaths
  };
}
