import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  IllegalArgumentError,
  UserVisibleError,
  assertUserIsInstructorOrServiceRole,
  wrapRequestHandler
} from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { getOctoKit, listCommits } from "../_shared/GitHubWrapper.ts";
import * as Sentry from "npm:@sentry/deno@10.10.0";
import {
  collectGitHubRepoTargets,
  parseDeletedGitHubRepositories,
  selectGitHubCleanupStrategy
} from "./repositoryCleanup.ts";
import type { GitHubCleanupStrategy, GitHubRepoTarget } from "./repositoryCleanup.ts";
import { REQUEST_SCOPED_AUTH_OPTIONS } from "../_shared/requestScopedAuthOptions.ts";

interface AssignmentDeleteRequest {
  assignment_id: number;
  class_id: number;
}

type RepositoryRow = {
  id: number;
  repository: string | null;
  assignment_group_id: number | null;
  profile_id: string | null;
  synced_handout_sha: string | null;
};

type AssignmentDeleteResponse = {
  message: string;
  github_cleanup_strategy: GitHubCleanupStrategy;
  github_repositories_total: number;
  github_repositories_deleted: number;
  github_repositories_queued_for_archive: number;
  github_repositories_skipped: number;
};

const REPOSITORY_MODIFICATION_CHECK_CONCURRENCY = 5;
const REPOSITORY_PAGE_SIZE = 1000;

function isGitHubNotFoundError(error: unknown) {
  const maybeStatus = (error as { status?: number })?.status;
  const message = error instanceof Error ? error.message : String(error);
  return maybeStatus === 404 || message.includes("Not Found");
}

async function assertNoReleasedSubmissionReviews(adminSupabase: SupabaseClient<Database>, assignmentId: number) {
  const { data, error } = await adminSupabase
    .from("submission_reviews")
    .select("id, submissions!submission_reviews_submission_id_fkey!inner(assignment_id)")
    .eq("released", true)
    .eq("submissions.assignment_id", assignmentId)
    .limit(1);

  if (error) {
    console.error("Failed to check released submission reviews:", error);
    throw new UserVisibleError(`Failed to check released submission reviews: ${error.message}`);
  }

  if (data && data.length > 0) {
    throw new UserVisibleError(
      "Cannot delete assignment: This assignment has released submission reviews. Delete cannot proceed.",
      400
    );
  }
}

async function assertRepositoriesHaveOnlyTemplateCommits(repositories: RepositoryRow[], templateRepo: string | null) {
  if (repositories.length === 0 || !templateRepo) {
    return;
  }

  console.log(`Checking ${repositories.length} repositories for modifications...`);

  let templateInitialCommitSha: string | undefined;
  try {
    const templateRepoCommits = await listCommits(templateRepo, 1);
    templateInitialCommitSha = templateRepoCommits.commits[templateRepoCommits.commits.length - 1]?.sha;
  } catch (error) {
    console.warn("Error checking template repository:", error);
    // If we can't access the template repo, preserve the previous behavior and proceed with deletion.
    return;
  }

  async function checkRepository(repo: RepositoryRow) {
    if (!repo.repository) {
      console.log("Repository name is null, skipping");
      return;
    }

    try {
      const repoCommits = await listCommits(repo.repository, 1);

      if (repoCommits.commits.length > 1) {
        const oldestCommit = repoCommits.commits[repoCommits.commits.length - 1];

        if (oldestCommit.sha !== templateInitialCommitSha && oldestCommit.sha !== repo.synced_handout_sha) {
          throw new UserVisibleError(
            `Cannot delete assignment: Repository ${repo.repository} has been modified beyond the template. ` +
              `Please manually delete modified repositories if you want to proceed.`,
            400
          );
        }
      }
    } catch (error) {
      if (error instanceof UserVisibleError) {
        throw error;
      }
      console.warn(`Error checking repository ${repo.repository}:`, error);
      // If we can't check the repo (maybe it's already deleted), that's okay.
      // Missing repos should not be an error according to requirements.
    }
  }

  for (let i = 0; i < repositories.length; i += REPOSITORY_MODIFICATION_CHECK_CONCURRENCY) {
    const batch = repositories.slice(i, i + REPOSITORY_MODIFICATION_CHECK_CONCURRENCY);
    await Promise.all(batch.map(checkRepository));
  }
}

/**
 * Runs AFTER the database delete has committed, so it must not throw: the assignment is
 * already gone and an error here would tell the instructor the delete failed when it did
 * not. Every target already has an archive job queued by the RPC, in the same transaction
 * as the delete, so this is only the fast path: a repository we fail to delete here (or
 * never reach, if the function dies part-way) is archived by that job instead, and one we
 * do delete turns the job into a no-op (archiveRepoAndLock treats a 404 as done).
 */
async function deleteGitHubRepository(target: GitHubRepoTarget): Promise<"deleted" | "skipped" | "queued"> {
  try {
    console.log(`Deleting ${target.kind} repository ${target.fullName} from GitHub...`);
    const octokit = await getOctoKit(target.org);

    if (!octokit) {
      throw new Error(`No Octokit client found for organization ${target.org}`);
    }

    await octokit.request("DELETE /repos/{owner}/{repo}", {
      owner: target.org,
      repo: target.repo
    });
    console.log(`Successfully deleted repository ${target.fullName} from GitHub`);
    return "deleted";
  } catch (deleteError) {
    if (isGitHubNotFoundError(deleteError)) {
      console.log(`Repository ${target.fullName} not found, skipping`);
      return "skipped";
    }

    console.warn(
      `Failed to delete ${target.kind} repository ${target.fullName} from GitHub; its queued archive job will clean it up:`,
      deleteError
    );
    return "queued";
  }
}

async function deleteGitHubRepositoriesSynchronously(targets: GitHubRepoTarget[]) {
  let deleted = 0;
  let queued = 0;
  let skipped = 0;

  for (const target of targets) {
    const result = await deleteGitHubRepository(target);
    if (result === "deleted") {
      deleted++;
    } else if (result === "queued") {
      queued++;
    } else {
      skipped++;
    }
  }

  return { deleted, queued, skipped };
}

async function deleteAssignment(req: Request, scope: Sentry.Scope): Promise<AssignmentDeleteResponse> {
  const { assignment_id, class_id } = (await req.json()) as AssignmentDeleteRequest;
  scope?.setTag("function", "assignment-delete");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());

  if (!assignment_id || !class_id) {
    throw new IllegalArgumentError("assignment_id and class_id are required");
  }

  // Service-role callers are allowed through, matching
  // assignment-create-handout-repo and the rest of the internally-invoked
  // functions. The previous check built an anon client from the forwarded
  // Authorization header and required auth.getUser() to resolve an instructor —
  // which a service-role key never does, so `pawtograder assignments delete`
  // (which invokes this through the admin client) always failed with
  // "User not found". The CLI does its own instructor check before invoking.
  await assertUserIsInstructorOrServiceRole(class_id, req.headers.get("Authorization"));

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    { auth: REQUEST_SCOPED_AUTH_OPTIONS }
  );

  // Check if assignment exists and belongs to the specified class
  const { data: assignment } = await adminSupabase
    .from("assignments")
    .select("id, title, template_repo, autograder(grader_repo)")
    .eq("id", assignment_id)
    .eq("class_id", class_id)
    .single();

  if (!assignment) {
    throw new IllegalArgumentError("Assignment not found or does not belong to this class");
  }

  // ========================
  // PHASE 1: PERFORM ALL CHECKS FIRST
  // ========================

  console.log("Phase 1: Performing all safety checks...");

  // Get all repositories for this assignment. Paged, because PostgREST caps a response at
  // db-max-rows (1000 in production): an unpaged read would silently safety-check only the
  // first page and hand the RPC an incomplete snapshot. A failed read must stop the delete,
  // not stand in for "no repositories".
  const assignmentRepositories: RepositoryRow[] = [];
  for (let offset = 0; ; offset += REPOSITORY_PAGE_SIZE) {
    const { data: page, error: pageError } = await adminSupabase
      .from("repositories")
      .select("id, repository, assignment_group_id, profile_id, synced_handout_sha")
      .eq("assignment_id", assignment_id)
      .order("id", { ascending: true })
      .range(offset, offset + REPOSITORY_PAGE_SIZE - 1);
    if (pageError) {
      throw new UserVisibleError(`Failed to read the assignment's repositories: ${pageError.message}`);
    }
    assignmentRepositories.push(...((page ?? []) as RepositoryRow[]));
    if (!page || page.length < REPOSITORY_PAGE_SIZE) {
      break;
    }
  }

  await assertNoReleasedSubmissionReviews(adminSupabase, assignment_id);
  await assertRepositoriesHaveOnlyTemplateCommits(assignmentRepositories, assignment.template_repo);

  const graderRepo =
    assignment.autograder && !Array.isArray(assignment.autograder) ? assignment.autograder.grader_repo : null;
  // Only for validation: the cleanup targets are whatever the RPC actually deletes.
  const { invalidTargets } = collectGitHubRepoTargets({
    repositories: assignmentRepositories,
    templateRepo: assignment.template_repo,
    graderRepo
  });

  const criticalInvalidTargets = invalidTargets.filter((target) => target.critical);
  if (criticalInvalidTargets.length > 0) {
    throw new UserVisibleError(
      `Cannot delete assignment: ${criticalInvalidTargets
        .map((target) => `${target.kind} repository "${target.value}" is invalid (${target.reason})`)
        .join("; ")}.`,
      400
    );
  }

  const skippedInvalidStudentRepos = invalidTargets.filter((target) => !target.critical).length;
  if (skippedInvalidStudentRepos > 0) {
    console.warn(`Skipping ${skippedInvalidStudentRepos} malformed student repository row(s) during GitHub cleanup`);
  }

  console.log("All safety checks passed. Proceeding with deletion...");

  // ========================
  // PHASE 2: DELETE ALL DATA FROM DATABASE USING RPC FUNCTION
  // ========================
  //
  // The database goes first, and the RPC queues an archive job for every repository it
  // deletes inside its own transaction. Queueing them here beforehand meant a delete that
  // failed (2026-10-15: statement timeout on 238 repositories) still archived, renamed and
  // stripped collaborators from every repository of an assignment that stayed live.

  console.log("Phase 2: Deleting all related data from database and queueing GitHub cleanup...");

  const { data: deleteResultRaw, error: deleteError } = await adminSupabase.rpc("delete_assignment_with_all_data", {
    p_assignment_id: assignment_id,
    p_class_id: class_id,
    p_enqueue_github_archives: true,
    // What Phase 1 checked for student work. If a repository was created since, the RPC
    // refuses rather than archive (or hand back for deletion) a repository nobody checked.
    p_expected_repository_ids: assignmentRepositories.map((repo) => repo.id)
  });
  const deleteResult = deleteResultRaw as {
    success: boolean;
    message: string;
    assignment_id: number;
    class_id: number;
    github_repositories?: unknown;
    github_archives_queued?: number;
    handout_syncs_cancelled?: number;
  };

  if (deleteError) {
    console.error("Failed to delete assignment data:", deleteError);
    // 55006 object_in_use: a handout sync for one of the repositories is running.
    // 40001 serialization_failure: a repository was created after the Phase 1 checks.
    // Either way nothing was deleted or queued, and a retry succeeds (and re-checks).
    if (deleteError.code === "55006" || deleteError.code === "40001") {
      throw new UserVisibleError(deleteError.message, 409);
    }
    throw new UserVisibleError(`Failed to delete assignment data: ${deleteError.message}`);
  }

  if (!deleteResult || !deleteResult.success) {
    console.error("RPC function returned error:", deleteResult);
    throw new UserVisibleError(`Failed to delete assignment: ${deleteResult?.message || "Unknown error"}`);
  }

  console.log(
    `Successfully deleted assignment ${assignment_id}: "${assignment.title}" ` +
      `(${deleteResult.handout_syncs_cancelled ?? 0} queued handout syncs cancelled)`
  );

  // ========================
  // PHASE 3: CLEAN UP GITHUB
  // ========================
  //
  // The RPC reports the repositories it actually deleted, which can include ones created
  // after the Phase 1 read, so the strategy is chosen from that list and not the Phase 1
  // count. Either way every target is already queued for archival; a small assignment is
  // also deleted outright here, which only makes those jobs no-ops.

  const deletedTargets = parseDeletedGitHubRepositories(deleteResult.github_repositories);
  const cleanupStrategy = selectGitHubCleanupStrategy(deletedTargets.length);
  scope?.setTag("github_cleanup_strategy", cleanupStrategy);
  scope?.setTag("github_repositories_total", deletedTargets.length.toString());

  let githubRepositoriesDeleted = 0;
  let githubRepositoriesQueuedForArchive = 0;
  let githubRepositoriesSkipped = skippedInvalidStudentRepos;

  if (cleanupStrategy === "archive_asynchronously") {
    githubRepositoriesQueuedForArchive = deleteResult.github_archives_queued ?? 0;
    console.log(`Phase 3: ${githubRepositoriesQueuedForArchive} GitHub repositories queued for archival by the RPC`);
  } else {
    console.log(`Phase 3: Deleting ${deletedTargets.length} GitHub repositories...`);
    const synchronousCleanup = await deleteGitHubRepositoriesSynchronously(deletedTargets);
    githubRepositoriesDeleted = synchronousCleanup.deleted;
    githubRepositoriesQueuedForArchive = synchronousCleanup.queued;
    githubRepositoriesSkipped += synchronousCleanup.skipped;
  }

  const baseMessage =
    deleteResult.message ||
    `Assignment "${assignment.title}" has been successfully deleted along with all related data.`;
  const queuedMessage = `${githubRepositoriesQueuedForArchive} GitHub ${
    githubRepositoriesQueuedForArchive === 1 ? "repository was" : "repositories were"
  } queued for background archival and locking.`;
  const githubMessage =
    cleanupStrategy === "archive_asynchronously"
      ? queuedMessage
      : `${githubRepositoriesDeleted} GitHub ${
          githubRepositoriesDeleted === 1 ? "repository was" : "repositories were"
        } deleted immediately.${githubRepositoriesQueuedForArchive > 0 ? ` ${queuedMessage}` : ""}`;
  const skippedMessage =
    githubRepositoriesSkipped > 0
      ? ` ${githubRepositoriesSkipped} GitHub ${
          githubRepositoriesSkipped === 1 ? "repository was" : "repositories were"
        } skipped because they were missing or invalid.`
      : "";

  return {
    message: `${baseMessage} ${githubMessage}${skippedMessage}`,
    github_cleanup_strategy: cleanupStrategy,
    github_repositories_total: deletedTargets.length,
    github_repositories_deleted: githubRepositoriesDeleted,
    github_repositories_queued_for_archive: githubRepositoriesQueuedForArchive,
    github_repositories_skipped: githubRepositoriesSkipped
  };
}

Deno.serve((req) => {
  return wrapRequestHandler(req, deleteAssignment);
});
