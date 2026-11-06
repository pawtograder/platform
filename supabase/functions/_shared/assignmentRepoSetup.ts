/**
 * Creation of an assignment's STAFF repositories: the handout and the solution (grader) repo.
 *
 * Two callers run this code:
 *  - github-async-worker, for the `setup_handout_repo` / `setup_solution_repo` jobs that
 *    public.enqueue_assignment_repo_setup queues when an assignment is inserted. This is the
 *    normal path, and the only one that retries.
 *  - the assignment-create-handout-repo / assignment-create-solution-repo edge functions, kept as
 *    thin wrappers for the CLI, the seeding scripts and the e2e tests that call them directly.
 *
 * Both report to public.assignment_repo_setup through recordAssignmentRepoSetupEvent, so the
 * instructor sees the same state whichever path ran.
 *
 * Every step is safe to repeat. createRepo adopts a repository that already exists (and
 * regenerates one that exists but is empty), syncRepoPermissions converges, and every database
 * write sets the pointer to the same value it would set the first time. A retry after a partial
 * failure therefore finishes the job rather than duplicating it.
 *
 * The two jobs are independent and may run in either order or at the same time. The one step that
 * needs both repositories, seeding the handout file hashes, runs at the end of each job and skips
 * cleanly when its inputs are missing, so whichever job finishes second does it.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import { parse } from "jsr:@std/yaml";
import {
  createRepo,
  deleteFileFromRepo,
  getDefaultBranchHeadSha,
  getFileFromRepo,
  GRADE_WORKFLOW_PATH,
  NonRetryableGitHubError,
  syncRepoPermissions,
  updateAutograderWorkflowHash
} from "./GitHubWrapper.ts";
import { resolveTemplateRepos } from "./GitHubSyncHelpers.ts";
import type { Database, Json } from "./SupabaseTypes.d.ts";
import { resolveHandoutRepoAction, type HandoutSourceAssignment } from "./handoutRepoStrategy.ts";
import { shouldSkipRealGithubForE2eFixture } from "./e2eGithubGuard.ts";
import { describeHandoutSeedResult, seedHandoutFileHashes } from "./handoutFileHashes.ts";

export type AssignmentRepoKind = Database["public"]["Enums"]["assignment_repo_kind"];

/**
 * A setup that cannot succeed until someone changes the assignment or the course: retrying it
 * would only repeat the same answer. Extends NonRetryableGitHubError so github-async-worker sends
 * the job straight to the DLQ without tripping the org circuit breaker (the failure says nothing
 * about GitHub's health); the edge-function wrappers turn it into a 400 UserVisibleError.
 */
export class AssignmentSetupConfigError extends NonRetryableGitHubError {
  constructor(message: string) {
    super(message);
    this.name = "AssignmentSetupConfigError";
  }
}

export type AssignmentRepoSetupResult = {
  /** `ready`: the repository exists and the assignment points at it. `skipped`: nothing to create. */
  state: "ready" | "skipped";
  repo_full_name: string | null;
  /** Why a `skipped` result created nothing. */
  skip_reason?: "assignment_not_found" | "no_repositories" | "e2e_fixture";
  /** The edge functions' historical response body, which the CLI and scripts parse. */
  response: Record<string, unknown>;
};

export type AssignmentRepoSetupOptions = {
  adminSupabase: SupabaseClient<Database>;
  assignmentId: number;
  /**
   * When set, the assignment must belong to this class. The edge functions pass the class the
   * caller was authorized for, so an instructor of one course cannot act on another's assignment.
   */
  classId?: number;
  scope: Sentry.Scope;
  /**
   * Wraps the createRepo call. github-async-worker passes its per-org Redis limiter here, the same
   * one create_repo uses, so staff-repo creation shares the org's creation budget. It is handed the
   * org the repository is actually created in, read from the course when the job runs, so the
   * limiter can never charge a stale org from the queued message. Only createRepo
   * is wrapped: nothing inside it re-enters the limiter, which is what keeps the pattern free of
   * the Bottleneck deadlock described at the worker's create_repo case.
   */
  scheduleCreate?: <T>(org: string, fn: () => Promise<T>) => Promise<T>;
  /** Handout only: create from this repository instead of the course's configured template. */
  templateRepoOverride?: string;
  /** The GitHub calls, replaceable in unit tests. Defaults to GitHubWrapper's. */
  github?: Partial<SetupGitHubCalls>;
};

/** Every GitHub call the two jobs make. */
export type SetupGitHubCalls = {
  createRepo: typeof createRepo;
  syncRepoPermissions: typeof syncRepoPermissions;
  getFileFromRepo: typeof getFileFromRepo;
  deleteFileFromRepo: typeof deleteFileFromRepo;
  getDefaultBranchHeadSha: typeof getDefaultBranchHeadSha;
  updateAutograderWorkflowHash: typeof updateAutograderWorkflowHash;
};

const REAL_GITHUB: SetupGitHubCalls = {
  createRepo,
  syncRepoPermissions,
  getFileFromRepo,
  deleteFileFromRepo,
  getDefaultBranchHeadSha,
  updateAutograderWorkflowHash
};

const runDirectly = <T>(_org: string, fn: () => Promise<T>) => fn();

async function loadAssignment(opts: AssignmentRepoSetupOptions) {
  let query = opts.adminSupabase
    .from("assignments")
    // `*` rather than an explicit column list: a long list overflows postgrest-js's select-string
    // type parser and collapses the row to GenericStringError.
    .select("*, classes(slug,github_org)")
    .eq("id", opts.assignmentId);
  if (opts.classId !== undefined) query = query.eq("class_id", opts.classId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data;
}

/** The assignment fields a setup job's plan depends on. */
type RepoConfigSnapshot = {
  repo_mode: string | null;
  source_assignment_id: number | null;
  has_autograder: boolean | null;
  slug: string | null;
  submission_mode: string | null;
};

function snapshotOf(row: Record<string, unknown>): RepoConfigSnapshot {
  return {
    repo_mode: (row.repo_mode as string | null) ?? null,
    source_assignment_id: (row.source_assignment_id as number | null) ?? null,
    has_autograder: (row.has_autograder as boolean | null) ?? null,
    slug: (row.slug as string | null) ?? null,
    submission_mode: (row.submission_mode as string | null) ?? null
  };
}

/**
 * A job planned its work from the assignment as it was when the job started. If the instructor
 * changed the repository configuration since, the plan is stale. Thrown as a plain (retryable)
 * error: the worker's retry re-reads the assignment and plans again; createRepo adopts whatever
 * this attempt already created.
 */
export class AssignmentRepoConfigChangedError extends Error {
  constructor() {
    super(
      "The assignment's repository settings changed while its repository was being set up; retrying with the new settings"
    );
    this.name = "AssignmentRepoConfigChangedError";
  }
}

/**
 * Re-read the assignment right before an irreversible step (creating the repository) and right
 * before writing pointers back. An instructor can change the repository settings while a job
 * runs; the mode-change trigger marks rows skipped when repositories are turned off, but cannot
 * stop a job already in flight.
 *  - `disabled`: repositories were turned off. Stop, write nothing.
 *  - `changed`: still on, but the plan is stale (different mode, fork source, autograder flag,
 *    slug or submission mode). Throws AssignmentRepoConfigChangedError so the job is retried.
 * The window that remains is the milliseconds between this read and the write after it.
 */
async function recheckRepoConfig(
  opts: AssignmentRepoSetupOptions,
  planned: RepoConfigSnapshot
): Promise<"unchanged" | "disabled"> {
  const { data, error } = await opts.adminSupabase
    .from("assignments")
    .select("*")
    .eq("id", opts.assignmentId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.repo_mode === "none" || data.repo_mode === "no_submission") return "disabled";
  const now = snapshotOf(data as unknown as Record<string, unknown>);
  if (JSON.stringify(now) !== JSON.stringify(planned)) throw new AssignmentRepoConfigChangedError();
  return "unchanged";
}

const NO_LONGER_WANTED: Omit<AssignmentRepoSetupResult, "repo_full_name"> = {
  state: "skipped",
  skip_reason: "no_repositories",
  response: { repo_name: null, org_name: null, skipped: true, repositories_disabled_during_setup: true }
};

function notFound(assignmentId: number): AssignmentRepoSetupResult {
  return {
    state: "skipped",
    repo_full_name: null,
    skip_reason: "assignment_not_found",
    response: { repo_name: null, org_name: null, skipped: true, assignment_id: assignmentId }
  };
}

/**
 * Create (or adopt) the handout repository and point the assignment at it. The behavior is the
 * one assignment-create-handout-repo always had; see the comments on each step.
 */
export async function setupHandoutRepo(opts: AssignmentRepoSetupOptions): Promise<AssignmentRepoSetupResult> {
  const { adminSupabase, assignmentId, scope } = opts;
  const scheduleCreate = opts.scheduleCreate ?? runDirectly;
  const github = { ...REAL_GITHUB, ...opts.github };

  const assignment = await loadAssignment(opts);
  if (!assignment) return notFound(assignmentId);
  const planned = snapshotOf(assignment as unknown as Record<string, unknown>);
  if (!assignment.classes.slug) {
    throw new AssignmentSetupConfigError("This course has no slug, so its repositories cannot be named.");
  }
  const handoutRepoOrg = assignment.classes.github_org;
  if (!handoutRepoOrg && assignment.repo_mode !== "none" && assignment.repo_mode !== "no_submission") {
    throw new AssignmentSetupConfigError(
      "This course has no GitHub organization configured, so its repositories cannot be created."
    );
  }
  scope.setTag("repo_mode", assignment.repo_mode);

  let sourceAssignment: HandoutSourceAssignment | null = null;
  if (assignment.repo_mode === "fork_from_prior_assignment" && assignment.source_assignment_id) {
    const { data: src, error: srcError } = await adminSupabase
      .from("assignments")
      .select("id, class_id, title, has_autograder, template_repo, latest_template_sha")
      .eq("id", assignment.source_assignment_id)
      .maybeSingle();
    if (srcError) throw srcError;
    if (src) {
      sourceAssignment = src as HandoutSourceAssignment;
      // This mode adopts the SOURCE assignment's handout repo verbatim, and student repos fork
      // each student's source-assignment repo. So the two assignments share one handout, and the
      // autograder setting is a property of that shared handout -- it cannot differ between them.
      // Allowing it would leave a state that assignment-sync-autograder-workflow later refuses
      // (so every subsequent save fails), and the student forks would inherit the source's
      // grade.yml regardless of this assignment's flag.
      if ((src.has_autograder !== false) !== (assignment.has_autograder !== false)) {
        throw new AssignmentSetupConfigError(
          `This assignment forks from "${src.title}" (#${src.id}), so both share that assignment's handout ` +
            `repository and must have the same autograder setting. ` +
            `"${src.title}" has the autograder ${src.has_autograder === false ? "disabled" : "enabled"}, ` +
            `so this assignment must too. Change the autograder setting to match, or pick a different ` +
            `repository configuration so this assignment gets its own handout.`
        );
      }
    }
  }

  // Throws a plain Error for a fork whose source is missing or has no handout yet. That is left
  // retryable on purpose: the source's own handout job may simply not have finished.
  const action = resolveHandoutRepoAction(
    {
      id: assignment.id,
      class_id: assignment.class_id,
      repo_mode: assignment.repo_mode,
      source_assignment_id: assignment.source_assignment_id
    },
    sourceAssignment
  );

  if (action.kind === "noop") {
    // repo_mode in ('none', 'no_submission'). Clear template_repo so downstream consumers don't
    // try to use a stale value, and skip GitHub entirely.
    if (assignment.template_repo) {
      const { error } = await adminSupabase.from("assignments").update({ template_repo: null }).eq("id", assignmentId);
      if (error) throw error;
    }
    return {
      state: "skipped",
      repo_full_name: null,
      skip_reason: "no_repositories",
      response: { repo_name: null, org_name: null, skipped: true, repo_mode: assignment.repo_mode }
    };
  }

  if (action.kind === "inherit_from_source") {
    if ((await recheckRepoConfig(opts, planned)) === "disabled") return { ...NO_LONGER_WANTED, repo_full_name: null };
    // For fork_from_prior_assignment we don't create a new handout repo; the student repos fork
    // from each student's prior-assignment repo. We still copy the source assignment's
    // template_repo + latest_template_sha onto this assignment so the handout-history UI and
    // template-SHA-driven sync continue to work.
    const { error } = await adminSupabase
      .from("assignments")
      .update({
        template_repo: sourceAssignment!.template_repo,
        latest_template_sha: sourceAssignment!.latest_template_sha ?? null
      })
      .eq("id", assignmentId);
    if (error) throw error;
    // Populate this assignment's autograder.workflow_sha from the inherited handout's grade.yml.
    // Without this the auto-created autograder row keeps workflow_sha = NULL and every student
    // submission is rejected with a "workflow sha mismatch" error. updateAutograderWorkflowHash
    // bulk-updates all assignments sharing this template_repo, so the source assignment is
    // unaffected (it already has the same value).
    //
    // Skipped when this assignment has no autograder: there is no submission path that checks
    // workflow_sha, and the inherited handout may legitimately have no grade.yml at all
    // (updateAutograderWorkflowHash throws in that case). Note we deliberately do NOT delete
    // grade.yml from the inherited handout -- it belongs to the source assignment, which may well
    // have an autograder of its own.
    if (sourceAssignment!.template_repo && assignment.has_autograder !== false) {
      await github.updateAutograderWorkflowHash(sourceAssignment!.template_repo);
    }
    // The solution job may have finished first and skipped seeding for want of a handout
    // revision; now that one is recorded, seed (a no-op if the solution config is not there yet).
    await seedHashes(opts, sourceAssignment!.template_repo, sourceAssignment!.latest_template_sha ?? undefined);
    return {
      state: "ready",
      repo_full_name: sourceAssignment!.template_repo,
      response: {
        repo_name: sourceAssignment!.template_repo?.split("/")[1] ?? null,
        org_name: sourceAssignment!.template_repo?.split("/")[0] ?? null,
        inherited_from_source: true,
        source_assignment_id: sourceAssignment!.id,
        repo_mode: assignment.repo_mode
      }
    };
  }

  // action.kind === "create"
  const handoutRepoName = `${assignment.classes.slug}-handout-${assignment.slug}`;
  scope.setTag("handout_repo_name", handoutRepoName);
  scope.setTag("handout_repo_org", handoutRepoOrg!);

  // An explicit override (e.g. demo-mode provisioning) wins; otherwise resolve the configured
  // handout template (per-class override -> github_org default -> hardcoded constant).
  // resolveTemplateRepos already falls back to the same constant the strategy uses as
  // action.sourceRepo, so it supersedes it for the create case. Resolve lazily so an explicit
  // override skips the extra resolve_class_template_repos round-trip.
  const sourceTemplateRepo =
    opts.templateRepoOverride ?? (await resolveTemplateRepos(adminSupabase, assignment.class_id)).handout;
  scope.setTag("source_template_repo", sourceTemplateRepo);

  // E2E fixtures (pawtograder-playground + e2e-ignore-* class) must never hit real GitHub. Return
  // before every GitHub call below. Don't persist template_repo: no repo was created, so leaving
  // it null keeps the DB honest (mirrors the noop branch above). Stub-record tests still fall
  // through (predicate returns false).
  if (
    shouldSkipRealGithubForE2eFixture({
      org: handoutRepoOrg,
      courseSlug: assignment.classes.slug,
      repoName: handoutRepoName
    })
  ) {
    return {
      state: "skipped",
      repo_full_name: null,
      skip_reason: "e2e_fixture",
      response: { repo_name: handoutRepoName, org_name: handoutRepoOrg, skipped: true, repo_mode: assignment.repo_mode }
    };
  }

  // The protect_* columns configure STUDENT repos. The staff handout repo must never require pull
  // requests / approving reviews -- that would block instructors pushing handout updates -- so
  // only carry force-push protection onto the handout (and only when configured for student
  // repos).
  const branchProtection = {
    blockForcePush: assignment.protect_block_force_push ?? true,
    requirePullRequest: false,
    requiredReviewers: 0
  };

  if ((await recheckRepoConfig(opts, planned)) === "disabled") return { ...NO_LONGER_WANTED, repo_full_name: null };
  const createdHeadSha = await scheduleCreate(handoutRepoOrg!, () =>
    github.createRepo(
      handoutRepoOrg!,
      handoutRepoName,
      sourceTemplateRepo,
      {
        is_template_repo: action.isTemplateRepo,
        creation_method: "template",
        branch_protection: branchProtection
      },
      scope
    )
  );
  await github.syncRepoPermissions(
    handoutRepoOrg!,
    handoutRepoName,
    assignment.classes.slug,
    [],
    scope,
    action.studentTeamPermission ? { studentTeamPermission: action.studentTeamPermission } : undefined
  );
  // Branch protection is applied inside createRepo (both the fresh-create and the
  // pre-existing-repo branches), so no separate call is needed here.
  //
  // Repo-only assignments (has_autograder=false) get a handout with NO grading workflow: the stock
  // handout template ships .github/workflows/grade.yml, which would otherwise run in every student
  // repo generated from this handout and fail (there is no autograder to report to), showing
  // students a red X. Strip it here, after the repo exists -- GitHub's create-from-template API
  // copies the whole tree, so there is no way to exclude it up front.
  const handoutFullName = `${handoutRepoOrg}/${handoutRepoName}`;
  let handoutHeadSha: string | undefined;
  if (assignment.has_autograder === false) {
    const { deleted, commit_sha } = await github.deleteFileFromRepo(
      handoutFullName,
      GRADE_WORKFLOW_PATH,
      "Remove autograder workflow: this assignment has no autograder",
      scope
    );
    // Keep this sha: it is the FINAL handout commit, and it is created before template_repo
    // exists in the DB below. So the template-repo push webhook for it finds no assignment to
    // attribute it to and records nothing -- leaving latest_template_sha null, which gives student
    // syncs no target revision. We persist it ourselves rather than relying on that delivery.
    handoutHeadSha = commit_sha;
    // `deleted: false` means grade.yml was already gone -- the shape a RETRY takes when the delete
    // succeeded but the pointer update below then failed. Resolve the current head instead of
    // relying on a commit we cannot re-create.
    if (!deleted) {
      handoutHeadSha = await github.getDefaultBranchHeadSha(handoutFullName, scope);
      scope.setTag("recovered_stripped_handout_sha", String(!!handoutHeadSha));
    }
  } else {
    // An AUTOGRADED handout needs the pointer just as much: every commit in this repo predates the
    // `template_repo` write below, so the template-repo push webhook has no assignment to attribute
    // it to, and latest_template_sha would stay NULL. That silently disables handout-hash seeding
    // (it keys off latest_template_sha), so empty-submission detection would have nothing to
    // compare against until an instructor happened to push to the handout.
    //
    // Best-effort: creation must not fail because a head lookup did, and the pointer is
    // re-derivable from the next handout push.
    try {
      handoutHeadSha = await github.getDefaultBranchHeadSha(handoutFullName, scope);
      scope.setTag("resolved_handout_head_sha", String(!!handoutHeadSha));
    } catch (headErr) {
      scope.setTag("resolve_handout_head_failed", "true");
      Sentry.captureException(headErr, scope);
    }
    // createRepo already returned the head it left the repository at. Fall back to it rather than
    // record no revision: without one, hash seeding skips and new student repositories have no
    // target handout revision, on a row that would show ready with no Retry.
    handoutHeadSha = handoutHeadSha || createdHeadSha || undefined;
  }

  // Only persist the template_repo pointer after GitHub creation + permission sync succeed, so a
  // partial failure does not leave the assignment pointing at a repo that does not exist. For
  // pr-mode the handout IS the upstream repo (students fork it and PR back to it), so point
  // upstream_repo at the same repo here -- the github-repo-webhook PR ingestion matches
  // upstream_repo against the repo a PR targets, and handout == upstream must never drift.
  //
  // This has to happen BEFORE updateAutograderWorkflowHash below: that helper picks the
  // autograder rows to write via `.eq("template_repo", repoName)`, so calling it first matched
  // zero rows and silently left autograder.workflow_sha NULL.
  //
  // On an assignment whose release date has passed, this write is also what creates the student
  // repositories: check_assignment_for_repo_creation fires on template_repo going NULL -> value.
  if ((await recheckRepoConfig(opts, planned)) === "disabled")
    return { ...NO_LONGER_WANTED, repo_full_name: handoutFullName };
  const { error: pointerError } = await adminSupabase
    .from("assignments")
    .update({
      template_repo: handoutFullName,
      ...(handoutHeadSha ? { latest_template_sha: handoutHeadSha } : {}),
      ...(assignment.submission_mode === "pr" ? { upstream_repo: handoutFullName } : {})
    })
    .eq("id", assignmentId);
  if (pointerError) {
    Sentry.captureException(pointerError, scope);
    throw pointerError;
  }

  // updateAutograderWorkflowHash is skipped for a repo-only assignment: it reads grade.yml and
  // throws "File not found" when absent, which would fail the whole creation. Leaving
  // autograder.workflow_sha NULL is correct there, since the sha check only runs on the
  // Actions-driven submission path, which no longer exists.
  if (assignment.has_autograder !== false) {
    // Pinned to the same revision latest_template_sha now advertises, so the hash and the tree
    // students receive describe one commit.
    await github.updateAutograderWorkflowHash(handoutFullName, handoutHeadSha);
  }

  await seedHashes(opts, handoutFullName, handoutHeadSha);

  return {
    state: "ready",
    repo_full_name: handoutFullName,
    response: { repo_name: handoutRepoName, org_name: handoutRepoOrg, repo_mode: assignment.repo_mode }
  };
}

/**
 * Create (or adopt) the solution repository, then point the autograder at it.
 *
 * The pointer is written LAST, in one update with the config and the head sha. The previous
 * version wrote autograder.grader_repo before calling createRepo, so a creation that failed left
 * the assignment pointing at a repository that did not exist. It did that so the push webhook for
 * the generated commit could be attributed; writing latest_autograder_sha here ourselves, as the
 * handout does with latest_template_sha, removes the need.
 */
export async function setupSolutionRepo(opts: AssignmentRepoSetupOptions): Promise<AssignmentRepoSetupResult> {
  const { adminSupabase, assignmentId, scope } = opts;
  const scheduleCreate = opts.scheduleCreate ?? runDirectly;
  const github = { ...REAL_GITHUB, ...opts.github };

  const assignment = await loadAssignment(opts);
  if (!assignment) return notFound(assignmentId);
  const planned = snapshotOf(assignment as unknown as Record<string, unknown>);
  if (assignment.repo_mode === "none" || assignment.repo_mode === "no_submission") {
    return {
      state: "skipped",
      repo_full_name: null,
      skip_reason: "no_repositories",
      response: { repo_name: null, org_name: null, skipped: true, repo_mode: assignment.repo_mode }
    };
  }
  if (!assignment.classes.slug) {
    throw new AssignmentSetupConfigError("This course has no slug, so its repositories cannot be named.");
  }
  const solutionRepoOrg = assignment.classes.github_org;
  if (!solutionRepoOrg) {
    throw new AssignmentSetupConfigError(
      "This course has no GitHub organization configured, so its repositories cannot be created."
    );
  }
  const solutionRepoName = `${assignment.classes.slug}-solution-${assignment.slug}`;
  const solutionFullName = `${solutionRepoOrg}/${solutionRepoName}`;
  scope.setTag("solution_repo", solutionFullName);

  // E2E fixtures must never hit real GitHub. The grader_repo pointer is still written: fixtures
  // and the pages they exercise key off it, and no repository exists to contradict it. The config
  // is not, since it would have to be read from GitHub.
  if (
    shouldSkipRealGithubForE2eFixture({
      org: solutionRepoOrg,
      courseSlug: assignment.classes.slug,
      repoName: solutionRepoName
    })
  ) {
    const { error } = await adminSupabase
      .from("autograder")
      .update({ grader_repo: solutionFullName })
      .eq("id", assignmentId);
    if (error) throw error;
    return {
      state: "skipped",
      repo_full_name: solutionFullName,
      skip_reason: "e2e_fixture",
      response: { repo_name: solutionRepoName, org_name: solutionRepoOrg, skipped: true }
    };
  }

  const { solution: solutionTemplateRepo } = await resolveTemplateRepos(adminSupabase, assignment.class_id);
  scope.setTag("solution_template_repo", solutionTemplateRepo);

  if ((await recheckRepoConfig(opts, planned)) === "disabled") return { ...NO_LONGER_WANTED, repo_full_name: null };
  const headSha = await scheduleCreate(solutionRepoOrg, () =>
    github.createRepo(solutionRepoOrg, solutionRepoName, solutionTemplateRepo, {}, scope)
  );
  await github.syncRepoPermissions(solutionRepoOrg, solutionRepoName, assignment.classes.slug, [], scope);

  // Read the config at the commit we are about to record, so the two cannot describe different
  // trees if someone pushes in between.
  const graderConfig = await github.getFileFromRepo(solutionFullName, "pawtograder.yml", scope, headSha || undefined);
  let config: Json;
  try {
    config = (await parse(graderConfig.content)) as Json;
  } catch (yamlError) {
    // The content is fixed at this commit, so a syntax error will not go away on retry.
    throw new AssignmentSetupConfigError(
      `pawtograder.yml in ${solutionFullName} is not valid YAML: ${
        yamlError instanceof Error ? yamlError.message : String(yamlError)
      }. Fix the file in the solution repository (or the course's solution template), then use Retry.`
    );
  }
  // An empty file, or one that is YAML `null`, parses without throwing. Recording that would mark
  // the repository ready while autograder.config stays NULL -- the very state every submission
  // fails on. The file's content is fixed at this commit, so retrying cannot change the answer.
  if (config === null || config === undefined || typeof config !== "object" || Array.isArray(config)) {
    throw new AssignmentSetupConfigError(
      `pawtograder.yml in ${solutionFullName} is empty or is not a YAML mapping, so the autograder has no ` +
        `configuration. Fix the file in the solution repository (or the course's solution template), then use Retry.`
    );
  }

  if ((await recheckRepoConfig(opts, planned)) === "disabled")
    return { ...NO_LONGER_WANTED, repo_full_name: solutionFullName };
  const { error: pointerError } = await adminSupabase
    .from("autograder")
    .update({
      grader_repo: solutionFullName,
      config,
      ...(headSha ? { latest_autograder_sha: headSha } : {})
    })
    .eq("id", assignmentId);
  if (pointerError) {
    // The config is what every submission is graded against, and the pointer is what tells the
    // push webhook this repository belongs to the assignment. Reporting success without them is
    // exactly the state this job exists to prevent.
    Sentry.captureException(pointerError, scope);
    throw pointerError;
  }

  // Seed the handout's file hashes now that submissionFiles is known. Needs the handout's
  // template_repo and latest_template_sha too; if the handout job has not finished, this skips
  // and the handout job seeds instead when it does.
  const { data: handoutTarget, error: handoutTargetError } = await adminSupabase
    .from("assignments")
    .select("template_repo, latest_template_sha")
    .eq("id", assignmentId)
    .maybeSingle();
  if (handoutTargetError) throw handoutTargetError;
  await seedHashes(opts, handoutTarget?.template_repo ?? null, handoutTarget?.latest_template_sha ?? undefined);

  return {
    state: "ready",
    repo_full_name: solutionFullName,
    response: { repo_name: solutionRepoName, org_name: solutionRepoOrg }
  };
}

/**
 * Seed assignment_handout_file_hashes for the handout revision now recorded.
 *
 * Those rows are what let an ingested submission be recognised as "the student pushed nothing of
 * their own". Best-effort by construction: the rows are re-derivable from GitHub, the next handout
 * push recomputes them, and a failure is reported to Sentry by the helper -- so failing repository
 * setup over them would be the worse trade. It needs both repositories (the handout's revision and
 * the solution's submissionFiles globs), so it is a no-op for whichever job finishes first.
 */
async function seedHashes(
  opts: AssignmentRepoSetupOptions,
  templateRepo: string | null,
  commitSha: string | undefined
) {
  const { data: classRow } = await opts.adminSupabase
    .from("assignments")
    .select("class_id")
    .eq("id", opts.assignmentId)
    .maybeSingle();
  const seedResult = await seedHandoutFileHashes({
    adminSupabase: opts.adminSupabase,
    assignmentId: opts.assignmentId,
    classId: classRow?.class_id ?? opts.classId ?? 0,
    templateRepo,
    commitSha,
    scope: opts.scope
  });
  opts.scope.setTag("handout_hashes_seeded", String(seedResult.seeded));
  if (!seedResult.seeded) {
    console.log(
      `Not seeding handout file hashes for assignment ${opts.assignmentId}: ${describeHandoutSeedResult(seedResult)}`
    );
  }
}

export type AssignmentRepoSetupEvent = "started" | "succeeded" | "skipped" | "attempt_failed" | "gave_up";

/**
 * Record a transition on public.assignment_repo_setup. Never throws: the state row is how the
 * instructor sees the job, but failing the job because the report about it failed would turn a
 * reporting blip into a real outage. Failures go to Sentry instead, and the return value says
 * whether the report landed: a terminal report is also what releases the setup claim, so a caller
 * that finished the work has to act on a terminal report that did not (see the worker, and
 * releaseAssignmentRepoSetupClaim).
 */
export async function recordAssignmentRepoSetupEvent(
  adminSupabase: SupabaseClient<Database>,
  params: {
    assignmentId: number;
    kind: AssignmentRepoKind;
    event: AssignmentRepoSetupEvent;
    repoFullName?: string | null;
    error?: unknown;
  },
  scope?: Sentry.Scope
): Promise<boolean> {
  const errorText =
    params.error === undefined
      ? null
      : (params.error instanceof Error ? params.error.message : String(params.error)).slice(0, 2000);
  try {
    const { error } = await adminSupabase.rpc("record_assignment_repo_setup_event", {
      p_assignment_id: params.assignmentId,
      p_kind: params.kind,
      p_event: params.event,
      p_repo_full_name: params.repoFullName ?? undefined,
      p_error: errorText ?? undefined
    });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error(`Failed to record assignment repo setup event ${params.event}:`, e);
    if (scope) {
      const s = scope.clone();
      s.setContext("assignment_repo_setup_event", {
        assignment_id: params.assignmentId,
        kind: params.kind,
        event: params.event
      });
      Sentry.captureException(e, s);
    } else {
      Sentry.captureException(e);
    }
    return false;
  }
}

/**
 * Last-resort release of a claim whose terminal report could not be recorded, so the row does
 * not block other runners for the claim's whole TTL. Matches on the holder, so it can only ever
 * release this runner's own claim. Best-effort, like the report it stands in for.
 */
export async function releaseAssignmentRepoSetupClaim(
  adminSupabase: SupabaseClient<Database>,
  params: { assignmentId: number; kind: AssignmentRepoKind; holder: string },
  scope?: Sentry.Scope
): Promise<void> {
  const { error } = await adminSupabase
    .from("assignment_repo_setup")
    .update({ claimed_by: null, claimed_until: null })
    .eq("assignment_id", params.assignmentId)
    .eq("kind", params.kind)
    .eq("claimed_by", params.holder);
  if (error) {
    if (scope) Sentry.captureException(error, scope);
    else Sentry.captureException(error);
  }
}

/**
 * Another runner holds the claim on this repository's setup and did not finish within the wait.
 * The work is not lost: that runner (normally the worker's job) completes it.
 */
export class AssignmentSetupBusyError extends Error {
  constructor(kind: AssignmentRepoKind) {
    super(
      `Setup of this assignment's ${kind} repository is already running in the background and did not finish ` +
        `within ${CLAIM_WAIT_MS / 1000}s. It will complete on its own; check the assignment page, then retry this step.`
    );
    this.name = "AssignmentSetupBusyError";
  }
}

/**
 * How long a synchronous caller waits for a claim held by someone else. Bounded by the edge
 * isolate's lifetime (worker.timeoutMs, ~400s, retired at half), with room left for the caller's
 * own setup once it gets the claim.
 */
const CLAIM_WAIT_MS = 120_000;
const CLAIM_POLL_MS = 5_000;

/**
 * Take the right to run setup for one repository (public.claim_assignment_repo_setup). False when
 * another runner holds a live claim. Unlike the event reports this throws on a database error:
 * running without the claim is exactly the overlap it exists to prevent.
 */
export async function claimAssignmentRepoSetup(
  adminSupabase: SupabaseClient<Database>,
  params: { assignmentId: number; kind: AssignmentRepoKind; holder: string }
): Promise<boolean> {
  const { data, error } = await adminSupabase.rpc("claim_assignment_repo_setup", {
    p_assignment_id: params.assignmentId,
    p_kind: params.kind,
    p_holder: params.holder
  });
  if (error) throw error;
  return data === true;
}

/** A result for a repository someone else just finished setting up, in the wrappers' response shape. */
async function resultFromFinishedRow(
  adminSupabase: SupabaseClient<Database>,
  assignmentId: number,
  kind: AssignmentRepoKind
): Promise<AssignmentRepoSetupResult | null> {
  const { data: row } = await adminSupabase
    .from("assignment_repo_setup")
    .select("state, repo_full_name")
    .eq("assignment_id", assignmentId)
    .eq("kind", kind)
    .maybeSingle();
  if (!row || (row.state !== "ready" && row.state !== "skipped")) return null;
  const [org, repo] = (row.repo_full_name ?? "/").split("/");
  return {
    state: row.state,
    repo_full_name: row.repo_full_name,
    response: { repo_name: repo || null, org_name: org || null, completed_by_other_runner: true }
  };
}

/**
 * Run one setup job synchronously and record its outcome. Used by the edge-function wrappers.
 *
 * Inserting an assignment already queued this work for the worker, so a caller that inserts and
 * then calls a wrapper (the CLI's assignment copy, the seeding scripts) races that job. The claim
 * serializes them: if the worker holds it, this waits for the worker to finish and returns its
 * result rather than running createRepo alongside it.
 */
export async function runAssignmentRepoSetup(
  kind: AssignmentRepoKind,
  opts: AssignmentRepoSetupOptions
): Promise<AssignmentRepoSetupResult> {
  const { adminSupabase, assignmentId, scope } = opts;
  // The edge functions authorize the caller for the class_id in the request, not for the
  // assignment. Confirm the assignment is in that class BEFORE claiming or reporting anything:
  // the claim and the reports resolve the class from the assignment itself, so an assignment from
  // another course would otherwise have its row marked in_progress and then skipped, wiping a
  // failed row's error and its Retry button.
  if (!(await loadAssignment(opts))) return notFound(assignmentId);
  const holder = `edge:${crypto.randomUUID()}`;
  const deadline = Date.now() + CLAIM_WAIT_MS;
  while (!(await claimAssignmentRepoSetup(adminSupabase, { assignmentId, kind, holder }))) {
    if (Date.now() >= deadline) throw new AssignmentSetupBusyError(kind);
    await new Promise((resolve) => setTimeout(resolve, CLAIM_POLL_MS));
    const finished = await resultFromFinishedRow(adminSupabase, assignmentId, kind);
    if (finished) return finished;
  }
  try {
    const result = kind === "handout" ? await setupHandoutRepo(opts) : await setupSolutionRepo(opts);
    // Deleted between the ownership check and the job: there is no row left to report on.
    if (result.skip_reason === "assignment_not_found") return result;
    const reported = await recordAssignmentRepoSetupEvent(
      adminSupabase,
      {
        assignmentId,
        kind,
        event: result.state === "ready" ? "succeeded" : "skipped",
        repoFullName: result.repo_full_name
      },
      scope
    );
    if (!reported) await releaseAssignmentRepoSetupClaim(adminSupabase, { assignmentId, kind, holder }, scope);
    return result;
  } catch (e) {
    // Nothing retries a direct call, so the row goes straight to failed and the instructor gets
    // the Retry button, which queues the same work on the worker. Both reports release the claim.
    await recordAssignmentRepoSetupEvent(
      adminSupabase,
      { assignmentId, kind, event: "attempt_failed", error: e },
      scope
    );
    const reported = await recordAssignmentRepoSetupEvent(
      adminSupabase,
      { assignmentId, kind, event: "gave_up" },
      scope
    );
    if (!reported) await releaseAssignmentRepoSetupClaim(adminSupabase, { assignmentId, kind, holder }, scope);
    throw e;
  }
}
