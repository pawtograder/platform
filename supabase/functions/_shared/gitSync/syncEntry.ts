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
 * 3. Mint two installation tokens (§8.2): a student token for the student repo that can write,
 *    and a template token from the template org's installation that can only read the template.
 *    Read both repos' sizes, each with its own token (§8.4).
 * 4. Plan, and push with a compare-and-swap (§5.8). The job directory is gone before step 5.
 * 5. Find or open the pull request and merge it (§5.9). Only this step runs under the per-org
 *    limiters; the git work holds neither.
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
  type SyncAnalysis,
  type SyncJob,
  type SyncJobContext,
  withSyncJob
} from "./engine.ts";
import { GitSyncTerminalError } from "./errors.ts";
import type { GitIdentity, RemoteConfig } from "./runGit.ts";
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
}

let configuredRuntime: HandoutSyncGitRuntime | undefined;

/**
 * Sets the runtime the git path uses. The worker (WP5) calls this once at startup; without it the
 * first job builds one from the environment (`HANDOUT_SYNC_WORK_DIR`, default `/work`).
 *
 * The job deadline (§3.1) is not part of this yet. `processEnvelope` cannot carry an
 * `AbortSignal`, so the worker needs a per-job signal provider here, keyed by job id: for example
 * a `signalFor(jobId: string): AbortSignal | undefined` field that the worker answers from the
 * `AbortController` it created for that message, and that `syncRepositoryToHandoutGit` passes to
 * the engine as `SyncJobContext.signal`. The job id is `msg-<pgmq msg_id>` (see `jobIdFor`).
 */
export function configureHandoutSyncGit(runtime: HandoutSyncGitRuntime): void {
  configuredRuntime = runtime;
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
  return {
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
    adminSupabase,
    autoMerge = true,
    waitBeforeMerge = 2000,
    scope,
    repositoryId,
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
    // 1. Inputs. `InvalidSyncInputError` is a `GitSyncTerminalError`, mapped below.
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
    // another org's class still syncs.
    const { token } = await deps.getScopedToken(org, [repoName], SYNC_TOKEN_PERMISSIONS, scope);
    const { token: templateToken } = await deps.getScopedToken(
      templateOrg,
      [templateName],
      TEMPLATE_TOKEN_PERMISSIONS,
      scope
    );
    const octokit = deps.octokitForToken(token, scope);
    const templateOctokit = deps.octokitForToken(templateToken, scope);
    const runtime = deps.runtime();
    await assertRepoWithinSizeLimit(octokit, repo, runtime.maxRepoKib, scope);
    await assertRepoWithinSizeLimit(templateOctokit, template, runtime.maxRepoKib, scope);
    const identity = await resolveBotIdentity(octokit, deps, scope);

    // 4. The git work. No limiter is held here.
    const ctx: SyncJobContext = {
      jobId: jobIdFor(jobId),
      jobsDir: runtime.jobsDir,
      templateCache: runtime.templateCache,
      remote: runtime.remote,
      maxMergeBytes: runtime.maxMergeBytes,
      token,
      templateToken,
      identity,
      ...deps.engineContext
    };
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
    const error = toSyncError(caught, retryCount);
    console.trace(error);
    if (error instanceof TerminalSyncError) scope?.setTag("terminal_sync_reason", error.reason);
    deps.captureException(error, scope);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      terminal_reason: error instanceof TerminalSyncError ? error.reason : undefined
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

  // §5.9: the lookup comes before creation. A merged PR whose head is this very commit is a retry
  // of a job that merged and then died before the row was written: report the merge, with its
  // sha, so the handler moves both halves of the baseline pair.
  const existing = await listSyncPullRequests(octokit, repo, branch);
  const mergedOurs = existing.find((pr) => pr.merged_at !== null && pr.head.sha === commit);
  if (mergedOurs) {
    scope?.addBreadcrumb({
      message: `Found already-merged PR #${mergedOurs.number} for ${repo} at ${commit.substring(0, 7)}`,
      category: "sync",
      level: "info"
    });
    return {
      success: true,
      pr_number: mergedOurs.number,
      pr_url: mergedOurs.html_url,
      merged: true,
      merge_sha: mergedOurs.merge_commit_sha || undefined
    };
  }

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

  let prNumber: number;
  let prUrl: string;
  const open = existing.find((pr) => pr.state === "open");
  if (open) {
    // The branch now carries this job's commit, so the open PR already shows it.
    scope?.addBreadcrumb({ message: `Reusing open PR #${open.number} for ${repo}`, category: "sync", level: "info" });
    prNumber = open.number;
    prUrl = open.html_url;
  } else {
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
        return { success: true, no_changes: true };
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
      const mergedNow = again.find((pr) => pr.merged_at !== null && pr.head.sha === commit);
      if (mergedNow) {
        return {
          success: true,
          pr_number: mergedNow.number,
          pr_url: mergedNow.html_url,
          merged: true,
          merge_sha: mergedNow.merge_commit_sha || undefined
        };
      }
      const openNow = again.find((pr) => pr.state === "open");
      if (!openNow) throw error;
      prNumber = openNow.number;
      prUrl = openNow.html_url;
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
