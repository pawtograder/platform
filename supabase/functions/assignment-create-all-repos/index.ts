import { createClient } from "jsr:@supabase/supabase-js@2";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { TZDate } from "npm:@date-fns/tz";
import Bottleneck from "npm:bottleneck";
import { AssignmentCreateAllReposRequest, AssignmentGroup } from "../_shared/FunctionTypes.d.ts";
import * as github from "../_shared/GitHubWrapper.ts";
import { assertUserIsInstructor, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { sanitizeRepoNameComponent } from "../_shared/repoNames.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { shouldSkipRealGithubForE2eFixture } from "../_shared/e2eGithubGuard.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import {
  resolveRepoCreationStrategy,
  type AssignmentForRepoCreation,
  type SourceRepoRow,
  type StudentIdentity
} from "../_shared/repoCreationStrategy.ts";
import type { BranchProtectionConfig } from "../_shared/branchProtection.ts";
import {
  describeSettledSummary,
  emptySettledSummary,
  mergeSettledSummaries,
  summarizeSettled,
  type SettledSummary
} from "../_shared/settledSummary.ts";
import { waitUntilWithSentryFlush } from "../_shared/SentryInit.ts";

// Declare EdgeRuntime for type safety
declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

type RepoToCreate = {
  name: string;
  assignment_group?: AssignmentGroup;
  profile_id?: string;
  student_github_usernames: string[];
};

// Rate limiter to ensure no more than 20 concurrent operations
const rateLimiter = new Bottleneck({
  maxConcurrent: 30,
  minTime: 0 // No minimum time between requests
});

async function ensureRepoCreated({ org, repo, scope }: { org: string; repo: string; scope: Sentry.Scope }) {
  let repoExists = false;
  let attempts = 0;
  const maxAttempts = 10;
  while (!repoExists && attempts < maxAttempts) {
    try {
      scope?.setTag("ensure_repo_created_attempt", attempts.toString());
      const repoName = repo.split("/")[1];
      const repoData = await github.getRepo(org, repoName, scope);
      if (repoData && repoData.size > 0) {
        repoExists = true;
        scope?.setTag("ensure_repo_created_repo_data", JSON.stringify(repoData));
      } else {
        scope?.setTag("ensure_repo_created_repo_data", JSON.stringify(repoData));
        await new Promise((resolve) => setTimeout(resolve, 3000));
        attempts++;
      }
    } catch (e) {
      // A freshly-created repo can 404 briefly until GitHub finishes
      // provisioning it — retry those. Anything else is a real error.
      if (e instanceof Error && e.message.includes("Not Found")) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        attempts++;
      } else {
        throw e;
      }
    }
  }
  if (!repoExists) {
    throw new Error(`Repo ${repo} did not become ready after ${maxAttempts} attempts`);
  }
}

async function ensureExistingRepoCreated({
  repo,
  assignment,
  adminSupabase,
  courseId,
  assignmentId,
  scope,
  assignmentForStrategy,
  branchProtection,
  sourceAssignmentRepos
}: {
  repo: any;
  assignment: any;
  adminSupabase: any;
  courseId: number;
  assignmentId: number;
  scope: Sentry.Scope;
  assignmentForStrategy: AssignmentForRepoCreation;
  branchProtection: BranchProtectionConfig;
  sourceAssignmentRepos: SourceRepoRow[];
}) {
  const [org, repoName] = repo.repository.split("/");

  try {
    // Check if the repository exists in GitHub
    await github.getRepo(org, repoName, scope);
    console.log(`Repository ${repo.repository} exists in GitHub`);
  } catch (e) {
    if (e instanceof Error && e.message.includes("Not Found")) {
      console.log(`Repository ${repo.repository} does not exist in GitHub, creating it...`);

      // Get student GitHub usernames for this repo
      let student_github_usernames: (string | null | undefined)[] = [];
      if (repo.assignment_groups?.assignment_groups_members) {
        student_github_usernames = repo.assignment_groups.assignment_groups_members
          .map((member: any) => member.user_roles.users.github_username)
          .filter((username: string | null | undefined) => username);
      } else if (repo.profiles?.user_roles?.users.github_username) {
        student_github_usernames = [repo.profiles.user_roles.users.github_username];
      }

      // Filter out falsy values and deduplicate
      const uniqueUsernames = [
        ...new Set(student_github_usernames.filter((username): username is string => Boolean(username)))
      ];

      if (uniqueUsernames.length === 0) {
        console.log(`No valid GitHub usernames found for repo ${repo.repository}, skipping creation`);
        return;
      }

      // Resolve creation strategy using the same logic the synchronous path uses.
      const student: StudentIdentity = {
        profile_id: repo.profile_id ?? undefined,
        assignment_group_id: repo.assignment_group_id ?? undefined,
        group_name: repo.assignment_groups?.name ?? undefined
      };
      const strategy = resolveRepoCreationStrategy(assignmentForStrategy, student, sourceAssignmentRepos);
      if (strategy.kind !== "create") {
        console.log(
          `Skipping recreation of ${repo.repository}: ${strategy.kind === "skip" ? strategy.reason : "unknown"}`
        );
        return;
      }

      try {
        // E2E fixtures must never hit real GitHub (tripping the org-wide circuit breaker). Skip
        // createRepo + syncRepoPermissions and mark the row ready with a fake SHA, matching every
        // other direct createRepo caller.
        if (shouldSkipRealGithubForE2eFixture({ org, courseSlug: assignment.classes!.slug, repoName })) {
          await adminSupabase
            .from("repositories")
            .update({ synced_repo_sha: `e2e-skip-${repoName}`, is_github_ready: true })
            .eq("id", repo.id);
          return;
        }
        // Create the repository via template-generate or fork as configured.
        const headSha = await github.createRepo(
          org,
          repoName,
          strategy.sourceRepo,
          {
            creation_method: strategy.creationMethod,
            branch_protection: branchProtection
          },
          scope
        );

        // Sync repository permissions
        await github.syncRepoPermissions(org, repoName, assignment.classes!.slug!, uniqueUsernames, scope);

        // Update the database with the new head SHA
        await adminSupabase
          .from("repositories")
          .update({
            synced_repo_sha: headSha
          })
          .eq("id", repo.id);

        console.log(`Successfully created repository ${repo.repository} with head SHA ${headSha}`);
      } catch (createError) {
        console.error(`Error creating repository ${repo.repository}:`, createError);
        scope?.setTag("repo_creation_error", "failed_to_create_missing_repo");
        scope?.setTag("repository", repo.repository);
        // Rethrow. The per-repo isolation the old comment wanted is what the caller's
        // `Promise.allSettled` already provides, so this no longer stops the other repositories --
        // it only lets summarizeSettled see the failure. Swallowing it meant every settlement was
        // `fulfilled`, so `ensuredSummary.failed` was always 0 and a run where GitHub 5xx'd on
        // every pre-existing repo reported the same "All repository operations succeeded" as a
        // clean one.
        throw createError;
      }
    } else {
      // Some other error occurred while checking repo existence
      console.error(`Error checking repository ${repo.repository}:`, e);
      scope?.setTag("repo_check_error", "failed_to_check_repo_existence");
      scope?.setTag("repository", repo.repository);
      // Rethrow for the same reason as the creation failure above: a repo whose existence we could
      // not determine has NOT been ensured, and reporting it as ensured is the fail-open this pass
      // exists to close.
      throw e;
    }
  }
}

export async function createAllRepos(courseId: number, assignmentId: number, scope: Sentry.Scope) {
  scope.setTag("assignment_id", assignmentId.toString());
  scope.setTag("course_id", courseId.toString());

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: classData } = await adminSupabase.from("classes").select("time_zone").eq("id", courseId).single();
  const timeZone = classData?.time_zone;
  // Get the assignment from supabase
  const { data: assignment, error: assignmentError } = await adminSupabase
    .from("assignments")
    .select(
      "*, assignment_groups(*,assignment_groups_members(*,user_roles(users(github_username),profiles!private_profile_id(id, name, sortable_name)))), classes(slug,github_org,user_roles(users(github_username), disabled, profiles!private_profile_id(id, name, sortable_name)))"
    ) // , classes(canvas_id), user_roles(user_id)')
    .eq("id", assignmentId)
    .lte("release_date", TZDate.tz(timeZone || "America/New_York").toISOString())
    .eq("class_id", courseId)
    .single();
  if (assignmentError) {
    scope.setTag("db_error", "assignment_fetch_failed");
    scope.setTag("db_error_message", assignmentError.message);
    throw new UserVisibleError("Error fetching assignment: " + assignmentError.message);
  }
  if (!assignment) {
    scope.setTag("assignment_error", "not_found_or_not_released");
    throw new UserVisibleError("Assignment not found. Please be sure that the release date has passed.", 400);
  }

  scope.setTag("assignment_slug", assignment.slug || "unknown");
  scope.setTag("assignment_group_config", assignment.group_config || "unknown");
  scope.setTag("github_org", assignment.classes?.github_org || "unknown");
  scope.setTag("template_repo", assignment.template_repo || "none");
  scope.setTag("repo_mode", assignment.repo_mode || "template_only_staff");

  // Modes 'none' (upload) and 'no_submission' (manual grading, no artifact)
  // have no per-student repos to create. Return an EMPTY SUMMARY rather than
  // undefined: handleRequest now reads `summary.failed`, so a bare `return`
  // here crashes with a TypeError on exactly the assignments that have no work
  // to do. `deno check` would flag it, but `npm run typecheck:functions` ends
  // in `|| echo`, so a non-zero exit never fails CI.
  if (assignment.repo_mode === "none" || assignment.repo_mode === "no_submission") {
    console.log(`Assignment has repo_mode=${assignment.repo_mode}; skipping per-student repo creation`);
    return emptySettledSummary();
  }

  const branchProtection: BranchProtectionConfig = {
    blockForcePush: assignment.protect_block_force_push ?? true,
    requirePullRequest: assignment.protect_require_pull_request ?? false,
    requiredReviewers: assignment.protect_required_reviewers ?? 0
  };

  const assignmentForStrategy: AssignmentForRepoCreation = {
    id: assignment.id,
    repo_mode: assignment.repo_mode ?? "template_only_staff",
    template_repo: assignment.template_repo,
    source_assignment_id: assignment.source_assignment_id
  };

  // For mode 3, fetch the source assignment's per-student/group repos so each
  // new repo can fork the right upstream.
  let sourceAssignmentRepos: SourceRepoRow[] = [];
  if (assignment.repo_mode === "fork_from_prior_assignment" && assignment.source_assignment_id) {
    const { data: priorRepos, error: priorReposError } = await adminSupabase
      .from("repositories")
      .select("repository, profile_id, assignment_group_id, assignment_groups(name)")
      .eq("assignment_id", assignment.source_assignment_id)
      .limit(2000);
    if (priorReposError) {
      throw new UserVisibleError(`Error fetching source assignment repositories: ${priorReposError.message}`);
    }
    sourceAssignmentRepos = (priorRepos ?? []).map((r) => ({
      repository: r.repository,
      profile_id: r.profile_id,
      assignment_group_id: r.assignment_group_id,
      group_name: r.assignment_groups?.name ?? null
    }));
    scope.setTag("source_assignment_repo_count", String(sourceAssignmentRepos.length));
  }
  // Select all existing repos for the assignment
  const { data: existingRepos } = await adminSupabase
    .from("repositories")
    .select(
      "*, assignment_groups(name, assignment_groups_members(*,user_roles(users(github_username), github_org_confirmed))), profiles(user_roles!user_roles_private_profile_id_fkey(users(github_username), github_org_confirmed))"
    )
    .eq("assignment_id", assignmentId)
    .limit(1000);
  console.log(`Found ${existingRepos?.length} existing repos`);

  const studentsInAGroup = assignment.assignment_groups?.flatMap((group) =>
    group.assignment_groups_members.map((member) => member.profile_id)
  );
  // Find repos that need to be created
  const reposToCreate: RepoToCreate[] = [];
  if (assignment.group_config === "individual" || assignment.group_config === "both") {
    const individualRepos = assignment.classes!.user_roles.filter(
      (userRole) =>
        userRole.users.github_username &&
        !studentsInAGroup?.includes(userRole.profiles!.id) &&
        !userRole.disabled &&
        !existingRepos?.find((repo) => repo.profile_id === userRole.profiles!.id)
    );
    reposToCreate.push(
      ...individualRepos.map((userRole) => ({
        name: `${assignment.classes?.slug}-${assignment.slug}-${userRole.users.github_username}`,
        profile_id: userRole.profiles!.id,
        student_github_usernames: [userRole.users.github_username!]
      }))
    );
  }
  if (assignment.group_config === "groups" || assignment.group_config === "both") {
    const groupRepos = assignment.assignment_groups
      ?.filter((group) => !existingRepos?.find((repo) => repo.assignment_group_id === group.id))
      .map((group) => ({
        name: `${assignment.classes?.slug}-${assignment.slug}-group-${sanitizeRepoNameComponent(group.name)}`,
        assignment_group: group,
        student_github_usernames: group.assignment_groups_members.map(
          (member) => member.user_roles.users.github_username!
        )
      }));
    reposToCreate.push(...groupRepos);
  }

  scope?.setTag("existing_repos_count", existingRepos?.length.toString() || "0");
  scope?.setTag("repos_to_create_count", reposToCreate.length.toString());
  scope?.setTag("students_in_groups_count", studentsInAGroup?.length.toString() || "0");
  scope?.setTag("assignment_groups_count", assignment.assignment_groups?.length.toString() || "0");

  //Before creating repos, check to make sure template repo exists in GitHub, wait for it to exist
  // (mode 3 has no Pawtograder-owned handout — the per-student forks resolve against the source
  // assignment's per-student repos, which already exist if students reached that assignment).
  if (assignment.repo_mode !== "fork_from_prior_assignment" && assignment.template_repo) {
    await ensureRepoCreated({ org: assignment.classes!.github_org!, repo: assignment.template_repo, scope });
  }

  //Check that all existing repos in DB actually exist in GitHub, create them if they don't
  // Summarized, not discarded: this is the same bare `allSettled` shape that settledSummary.ts was
  // written for, and a run where GitHub 5xx'd on every pre-existing repo reported exactly the same
  // success as a clean one.
  let ensuredSummary: SettledSummary = emptySettledSummary();
  if (existingRepos && existingRepos.length > 0) {
    console.log(`Checking ${existingRepos.length} existing repositories in GitHub...`);
    ensuredSummary = summarizeSettled(
      await Promise.allSettled(
        existingRepos.map((repo) =>
          rateLimiter.schedule(() =>
            ensureExistingRepoCreated({
              repo,
              assignment,
              adminSupabase,
              courseId,
              assignmentId,
              scope,
              assignmentForStrategy,
              branchProtection,
              sourceAssignmentRepos
            })
          )
        )
      ),
      { label: "ensure" }
    );
  }

  const createRepo = async (
    name: string,
    github_username: string[],
    profile_id: string | null,
    assignmentGroup: AssignmentGroup | null
  ) => {
    // Group repos MUST carry the `-group-` infix so this name matches every other
    // site that derives it (the SQL enqueue existence-check, autograder-create-repos-for-student,
    // github-user-sync). Omitting it produces a divergent name and a duplicate repo enqueue.
    const repoName = `${assignment.classes?.slug}-${assignment.slug}-${assignmentGroup ? "group-" + sanitizeRepoNameComponent(assignmentGroup.name) : github_username[0]}`;
    console.log(`Creating repo ${repoName} for ${name}`);

    const strategy = resolveRepoCreationStrategy(
      assignmentForStrategy,
      {
        profile_id: profile_id ?? undefined,
        assignment_group_id: assignmentGroup?.id ?? undefined,
        group_name: assignmentGroup?.name ?? undefined,
        display_name: name
      },
      sourceAssignmentRepos
    );
    if (strategy.kind !== "create") {
      console.log(
        `Skipping repo ${repoName}: ${strategy.kind === "skip" ? `${strategy.reason}${strategy.reason === "missing_source" ? ` (${strategy.error})` : ""}` : "unknown"}`
      );
      return;
    }

    const { error, data: dbRepo } = await adminSupabase
      .from("repositories")
      .insert({
        profile_id: profile_id,
        assignment_group_id: assignmentGroup?.id,
        assignment_id: assignmentId,
        repository: assignment.classes!.github_org! + "/" + repoName,
        class_id: courseId,
        synced_handout_sha: assignment.latest_template_sha
      })
      .select("id")
      .single();
    if (error) {
      console.error(error);
      Sentry.captureException(error, scope);
      throw new UserVisibleError(`Error creating repo, repo not created: ${error}`);
    }
    if (!dbRepo) {
      throw new UserVisibleError(
        `Error creating repo: No repo created for ${assignment.classes!.github_org! + "/" + repoName}`
      );
    }

    try {
      // E2E fixtures must never hit real GitHub (tripping the org-wide circuit breaker). Skip
      // createRepo + syncRepoPermissions and mark the row ready with a fake SHA, matching every other
      // direct createRepo caller.
      if (
        shouldSkipRealGithubForE2eFixture({
          org: assignment.classes!.github_org,
          courseSlug: assignment.classes!.slug,
          repoName
        })
      ) {
        await adminSupabase
          .from("repositories")
          .update({ synced_repo_sha: `e2e-skip-${repoName}`, is_github_ready: true })
          .eq("id", dbRepo.id);
        return;
      }
      const headSha = await github.createRepo(
        assignment.classes!.github_org!,
        repoName,
        strategy.sourceRepo,
        {
          creation_method: strategy.creationMethod,
          branch_protection: branchProtection
        },
        scope
      );
      await github.syncRepoPermissions(
        assignment.classes!.github_org!,
        repoName,
        assignment.classes!.slug!,
        github_username,
        scope
      );
      await adminSupabase
        .from("repositories")
        .update({
          synced_repo_sha: headSha,
          is_github_ready: true
        })
        .eq("id", dbRepo.id);
    } catch (e) {
      console.log(`Error creating repo: ${repoName}`);
      console.error(e);
      // Keep the row. Deleting it orphaned any repo that GitHub had already created, and — because
      // reconcile_stuck_repo_creations only scans rows with is_github_ready = false — it also hid
      // the failure from the one mechanism that would have repaired it.
      //
      // Only a TERMINAL failure records creation_error, matching autograder-create-repos-for-student
      // and github-user-sync: a recorded error parks the row for an instructor and the reconciler
      // deliberately skips it, while NULL leaves it eligible for the 15-minute retry sweep.
      if (e instanceof github.NonRetryableRepoError) {
        await adminSupabase.from("repositories").update({ creation_error: e.message }).eq("id", dbRepo.id);
      }
      throw new UserVisibleError(`Error creating repo ${repoName}: ${e}`);
    }
  };
  const createdSummary = summarizeSettled(
    await Promise.allSettled(
      reposToCreate.map((repo) =>
        rateLimiter.schedule(() =>
          createRepo(repo.name, repo.student_github_usernames, repo.profile_id ?? null, repo.assignment_group ?? null)
        )
      )
    ),
    { label: "create" }
  );
  let syncedSummary: SettledSummary = emptySettledSummary();
  if (existingRepos) {
    syncedSummary = summarizeSettled(
      await Promise.allSettled(
        existingRepos.map((repo) =>
          rateLimiter.schedule(async () => {
            const [org, repoName] = repo.repository.split("/");
            let student_github_usernames: (string | null | undefined)[] = [];
            if (repo.assignment_groups?.assignment_groups_members) {
              student_github_usernames = repo.assignment_groups.assignment_groups_members
                .filter((member) => member.user_roles.github_org_confirmed)
                .map((member) => member.user_roles.users.github_username)
                .filter((username) => username); // Filter out falsy values
            } else {
              const github_username = repo.profiles?.user_roles?.users.github_username;
              if (github_username && repo.profiles?.user_roles?.github_org_confirmed) {
                student_github_usernames = [github_username];
              }
            }

            // Deduplicate and filter out any remaining falsy values
            const uniqueUsernames = [
              ...new Set(student_github_usernames.filter((username): username is string => Boolean(username)))
            ];

            // Skip if no valid usernames
            if (uniqueUsernames.length === 0) {
              console.log(`No valid github usernames for repo ${repo.repository}`);
              await adminSupabase
                .from("repositories")
                .update({
                  is_github_ready: false
                })
                .eq("id", repo.id);
              return;
            }

            const { removalsSkipped } = await github.syncRepoPermissions(
              org,
              repoName,
              assignment.classes!.slug!,
              uniqueUsernames,
              scope
            );
            // A sync that could not read the staff roster skipped every removal, so it did only half
            // the job. Leaving is_github_ready = false (with creation_error still NULL) is what keeps
            // the row inside reconcile_stuck_repo_creations' 15-minute sweep; writing `true` here
            // would make a half-done sync indistinguishable from a complete one and let a dropped
            // student keep push access with nothing scheduled to fix it.
            if (removalsSkipped) {
              throw new Error(
                `Staff roster unavailable while syncing ${repo.repository}; collaborator removals were skipped`
              );
            }
            await adminSupabase
              .from("repositories")
              .update({
                is_github_ready: true
              })
              .eq("id", repo.id);
          })
        )
      ),
      { label: "sync" }
    );
  }

  const summary = mergeSettledSummaries([ensuredSummary, createdSummary, syncedSummary]);
  if (summary.failed > 0) {
    // Was `console.log("All repos created + synced")` unconditionally, which is how a run where
    // every repo failed still reported success.
    console.error(`Repo creation finished with failures: ${describeSettledSummary(summary)}`);
    scope?.setTag("repo_creation_failed_count", String(summary.failed));
    scope?.setContext("repo_creation", {
      attempted: summary.attempted,
      succeeded: summary.succeeded,
      failed: summary.failed,
      reasons: summary.reasons,
      truncated_reasons: summary.truncatedReasons
    });
    Sentry.withScope((s) => {
      s.setFingerprint(["assignment-create-all-repos-partial-failure"]);
      Sentry.captureMessage(`assignment-create-all-repos: ${summary.failed}/${summary.attempted} failed`, s);
    });
  } else {
    console.log(`All repos created + synced (${summary.succeeded}/${summary.attempted})`);
  }
  return summary;
}

async function handleRequest(req: Request, scope: Sentry.Scope) {
  scope?.setTag("function", "assignment-create-all-repos");
  // Check for edge function secret authentication
  const edgeFunctionSecret = req.headers.get("x-edge-function-secret");
  const expectedSecret = Deno.env.get("EDGE_FUNCTION_SECRET") || "some-secret-value";

  let courseId: number;
  let assignmentId: number;

  if (edgeFunctionSecret && expectedSecret && edgeFunctionSecret === expectedSecret) {
    // For reasons that are not clear, we set it up so call_edge_function_internal will send params as GET, even on a POST?
    const url = new URL(req.url);
    const course_id = Number.parseInt(url.searchParams.get("courseId")!);
    const assignment_id = Number.parseInt(url.searchParams.get("assignmentId")!);
    // Edge function secret authentication - get parameters from request body
    courseId = course_id;
    assignmentId = assignment_id;
    scope?.setTag("Source", "edge-function-secret");

    const handler = async () => {
      try {
        await createAllRepos(courseId, assignmentId, scope);
      } catch (error) {
        console.error("Background task failed:", error);
        Sentry.captureException(error, scope);
      }
    };
    waitUntilWithSentryFlush(handler());

    return new Response(
      JSON.stringify({
        message: "Repository creation started in background",
        courseId,
        assignmentId
      }),
      {
        status: 202,
        headers: { "Content-Type": "application/json" }
      }
    );
  } else {
    // JWT authentication - get parameters from request body and validate instructor permissions
    const { courseId: cId, assignmentId: aId } = (await req.json()) as AssignmentCreateAllReposRequest;
    courseId = cId;
    assignmentId = aId;
    await assertUserIsInstructor(courseId, req.headers.get("Authorization")!);
    scope?.setTag("Source", "jwt");

    // Await the task completion
    const summary = await createAllRepos(courseId, assignmentId, scope);

    // This path waits for the work, so the caller is entitled to the real answer. Reporting
    // "All repositories created successfully" while N students have no repo is the failure this
    // fixes: the instructor moves on, and nobody looks again until someone cannot submit.
    //
    // Phrased in OPERATIONS, never "N of M repositories". The merged summary covers three passes
    // (ensure, create, sync) and two of them iterate the same existingRepos, so `attempted` exceeds
    // the number of repositories -- 20 existing + 5 new is 45 attempts over 25 repos. Calling that a
    // repository count is the same lie describeBulkReleaseResult was written to stop telling.
    if (summary.failed > 0) {
      throw new UserVisibleError(
        `${summary.failed} of ${summary.attempted} repository operations failed ` +
          `(${summary.succeeded} succeeded; some repositories may have been created). ` +
          describeSettledSummary(summary)
      );
    }

    return new Response(
      JSON.stringify({
        message: `All repository operations succeeded (${summary.succeeded}/${summary.attempted})`,
        courseId,
        assignmentId,
        attempted: summary.attempted,
        succeeded: summary.succeeded,
        failed: summary.failed
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}

Deno.serve(async (req) => {
  return await wrapRequestHandler(req, handleRequest);
});
