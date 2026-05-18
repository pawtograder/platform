import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { IllegalArgumentError, SecurityError, UserVisibleError, wrapRequestHandler } from "../_shared/HandlerUtils.ts";
import { Database } from "../_shared/SupabaseTypes.d.ts";
import { enqueueGithubArchiveRepo, getOctoKit, listCommits } from "../_shared/GitHubWrapper.ts";
import * as Sentry from "npm:@sentry/deno";
import {
  buildAssignmentDeleteArchiveDebugId,
  collectGitHubRepoTargets,
  selectGitHubCleanupStrategy
} from "./repositoryCleanup.ts";
import type { GitHubCleanupStrategy, GitHubRepoTarget } from "./repositoryCleanup.ts";

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

function isGitHubNotFoundError(error: unknown) {
  const maybeStatus = (error as { status?: number })?.status;
  const message = error instanceof Error ? error.message : String(error);
  return maybeStatus === 404 || message.includes("Not Found");
}

async function assertNoReleasedSubmissionReviews(adminSupabase: SupabaseClient<Database>, assignmentId: number) {
  const { data, error } = await adminSupabase
    .from("submission_reviews")
    .select("id, submissions!inner(assignment_id)")
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

async function deleteGitHubRepository(target: GitHubRepoTarget): Promise<"deleted" | "skipped"> {
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

    if (target.kind === "student") {
      console.warn(`Failed to delete repository ${target.fullName} from GitHub:`, deleteError);
      return "skipped";
    }

    console.warn(`Failed to delete ${target.kind} repository ${target.fullName} from GitHub:`, deleteError);
    throw new UserVisibleError(
      `Failed to delete ${target.kind} repository ${target.fullName} from GitHub: ${
        deleteError instanceof Error ? deleteError.message : "Unknown error"
      }`
    );
  }
}

async function deleteGitHubRepositoriesSynchronously(targets: GitHubRepoTarget[]) {
  let deleted = 0;
  let skipped = 0;

  for (const target of targets) {
    const result = await deleteGitHubRepository(target);
    if (result === "deleted") {
      deleted++;
    } else {
      skipped++;
    }
  }

  return { deleted, skipped };
}

async function enqueueGitHubRepositoryArchives(classId: number, assignmentId: number, targets: GitHubRepoTarget[]) {
  for (const [index, target] of targets.entries()) {
    const debugId = buildAssignmentDeleteArchiveDebugId(assignmentId, target, index);
    console.log(`Queueing ${target.fullName} for async archival with debug_id=${debugId}`);
    await enqueueGithubArchiveRepo(classId, target.org, target.repo, debugId);
  }

  return targets.length;
}

async function deleteAssignment(req: Request, scope: Sentry.Scope): Promise<AssignmentDeleteResponse> {
  const supabase = createClient<Database>(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: { Authorization: req.headers.get("Authorization")! }
    }
  });

  const { assignment_id, class_id } = (await req.json()) as AssignmentDeleteRequest;
  scope?.setTag("function", "assignment-delete");
  scope?.setTag("assignment_id", assignment_id.toString());
  scope?.setTag("class_id", class_id.toString());

  if (!assignment_id || !class_id) {
    throw new IllegalArgumentError("assignment_id and class_id are required");
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();
  if (!user) {
    throw new SecurityError("User not found");
  }

  // Check if user is an instructor for this course
  const { data: userRole } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("class_id", class_id)
    .single();

  if (!userRole || userRole.role !== "instructor") {
    throw new SecurityError("Only instructors can delete assignments");
  }

  const adminSupabase = createClient<Database>(
    Deno.env.get("SUPABASE_URL") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
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

  // Get all repositories for this assignment
  const { data: repositories } = await adminSupabase
    .from("repositories")
    .select("id, repository, assignment_group_id, profile_id, synced_handout_sha")
    .eq("assignment_id", assignment_id);
  const assignmentRepositories = (repositories ?? []) as RepositoryRow[];

  await assertNoReleasedSubmissionReviews(adminSupabase, assignment_id);
  await assertRepositoriesHaveOnlyTemplateCommits(assignmentRepositories, assignment.template_repo);

  const graderRepo =
    assignment.autograder && !Array.isArray(assignment.autograder) ? assignment.autograder.grader_repo : null;
  const { targets: githubTargets, invalidTargets } = collectGitHubRepoTargets({
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
  // PHASE 2: CLEAN UP GITHUB FIRST
  // ========================

  const cleanupStrategy = selectGitHubCleanupStrategy(githubTargets.length);
  scope?.setTag("github_cleanup_strategy", cleanupStrategy);
  scope?.setTag("github_repositories_total", githubTargets.length.toString());

  console.log(`Phase 2: Cleaning up ${githubTargets.length} GitHub repositories via ${cleanupStrategy}...`);

  let githubRepositoriesDeleted = 0;
  let githubRepositoriesQueuedForArchive = 0;
  let githubRepositoriesSkipped = skippedInvalidStudentRepos;

  if (cleanupStrategy === "archive_asynchronously") {
    githubRepositoriesQueuedForArchive = await enqueueGitHubRepositoryArchives(class_id, assignment_id, githubTargets);
  } else {
    const synchronousCleanup = await deleteGitHubRepositoriesSynchronously(githubTargets);
    githubRepositoriesDeleted = synchronousCleanup.deleted;
    githubRepositoriesSkipped += synchronousCleanup.skipped;
  }

  // ========================
  // PHASE 3: DELETE ALL DATA FROM DATABASE USING RPC FUNCTION
  // ========================

  console.log("Phase 3: Deleting all related data from database using RPC function...");

  // Call the RPC function to delete all assignment data
  const { data: deleteResultRaw, error: deleteError } = await adminSupabase.rpc("delete_assignment_with_all_data", {
    p_assignment_id: assignment_id,
    p_class_id: class_id
  });
  const deleteResult = deleteResultRaw as {
    success: boolean;
    message: string;
    assignment_id: number;
    class_id: number;
  };

  if (deleteError) {
    console.error("Failed to delete assignment data:", deleteError);
    throw new UserVisibleError(`Failed to delete assignment data: ${deleteError.message}`);
  }

  if (!deleteResult || !deleteResult.success) {
    console.error("RPC function returned error:", deleteResult);
    throw new UserVisibleError(`Failed to delete assignment: ${deleteResult?.message || "Unknown error"}`);
  }

  console.log(`Successfully deleted assignment ${assignment_id}: "${assignment.title}"`);

  const baseMessage =
    deleteResult.message ||
    `Assignment "${assignment.title}" has been successfully deleted along with all related data.`;
  const githubMessage =
    cleanupStrategy === "archive_asynchronously"
      ? `${githubRepositoriesQueuedForArchive} GitHub ${
          githubRepositoriesQueuedForArchive === 1 ? "repository was" : "repositories were"
        } queued for background archival and locking.`
      : `${githubRepositoriesDeleted} GitHub ${
          githubRepositoriesDeleted === 1 ? "repository was" : "repositories were"
        } deleted immediately.`;
  const skippedMessage =
    githubRepositoriesSkipped > 0
      ? ` ${githubRepositoriesSkipped} GitHub ${
          githubRepositoriesSkipped === 1 ? "repository was" : "repositories were"
        } skipped because they were missing or invalid.`
      : "";

  return {
    message: `${baseMessage} ${githubMessage}${skippedMessage}`,
    github_cleanup_strategy: cleanupStrategy,
    github_repositories_total: githubTargets.length,
    github_repositories_deleted: githubRepositoriesDeleted,
    github_repositories_queued_for_archive: githubRepositoriesQueuedForArchive,
    github_repositories_skipped: githubRepositoriesSkipped
  };
}

Deno.serve((req) => {
  return wrapRequestHandler(req, deleteAssignment);
});
