import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  deleteRepo,
  type ForgejoConfig,
  listRecentCommitShas,
  STALE_CLAIM_MINUTES
} from "../_shared/ForgejoWrapper.ts";
import { UserVisibleError } from "../_shared/HandlerUtils.ts";
import type { Database } from "../_shared/SupabaseTypes.d.ts";
import { type GitHubRepoTarget, hasOnlyHandoutCommits, modifiedRepositoryMessage } from "./repositoryCleanup.ts";

export type ForgejoRepositoryRow = { repository: string | null; synced_handout_sha: string | null };

/**
 * The Forgejo side of assertRepositoriesHaveOnlyTemplateCommits, with the same rule (hasOnlyHandoutCommits). A
 * repo generated from the handout starts with one commit of its own.
 *
 * One difference: GitHub lets the delete go ahead when it can't read a repo. Here only a repo that is gone
 * (or still empty) passes; any other failure refuses, because the repos are deleted next and nothing was checked.
 */
export async function assertForgejoRepositoriesHaveOnlyTemplateCommits(
  config: ForgejoConfig,
  repositories: ForgejoRepositoryRow[],
  templateRepo: string | null,
  list: typeof listRecentCommitShas = listRecentCommitShas
): Promise<void> {
  if (repositories.length === 0 || !templateRepo) return;
  let templateShas: string[] | null;
  try {
    templateShas = await list(config, templateRepo);
  } catch (error) {
    console.error("Error reading the Forgejo handout's commits:", error);
    throw new UserVisibleError(
      `Cannot delete assignment: couldn't read the commits of the handout ${templateRepo} on Forgejo. Try again later.`,
      503
    );
  }
  const templateOldest = templateShas?.[templateShas.length - 1];
  for (const repo of repositories) {
    if (!repo.repository) continue;
    let shas: string[] | null;
    try {
      shas = await list(config, repo.repository);
    } catch (error) {
      console.error(`Error reading the commits of ${repo.repository}:`, error);
      throw new UserVisibleError(
        `Cannot delete assignment: couldn't check ${repo.repository} on Forgejo for student work. Try again later.`,
        503
      );
    }
    if (shas && !hasOnlyHandoutCommits(shas, templateOldest, repo.synced_handout_sha)) {
      throw new UserVisibleError(modifiedRepositoryMessage(repo.repository), 400);
    }
  }
}

export type ForgejoCleanupCounts = { deleted: number; queued: number; skipped: number };

/**
 * Deletes a small batch outright, as deleteGitHubRepositoriesSynchronously does. Runs after the database delete
 * has committed, so it never throws. delete_assignment_with_all_data has already queued every target in
 * forgejo_repo_archives; each one is claimed the way forgejo-reconciler claims it, so a repo the reconciler is
 * archiving (and may already have renamed, freeing its name for a new repo) is never deleted here. Anything not
 * deleted here stays queued, and the reconciler archives it.
 */
export async function deleteForgejoRepositoriesSynchronously(
  supabase: SupabaseClient<Database>,
  config: ForgejoConfig | null,
  targets: GitHubRepoTarget[],
  remove: typeof deleteRepo = deleteRepo,
  now: () => Date = () => new Date()
): Promise<ForgejoCleanupCounts> {
  const counts: ForgejoCleanupCounts = { deleted: 0, queued: 0, skipped: 0 };
  for (const target of targets) {
    const name = target.fullName.toLowerCase();
    try {
      if (!config) throw new Error("Forgejo is not configured");
      const { data: job, error } = await supabase
        .from("forgejo_repo_archives")
        .select("id, archived_as")
        .eq("repository", name)
        .is("archived_at", null)
        .maybeSingle();
      if (error) throw error;
      if (!job) {
        // Already archived by the reconciler: nothing is left to delete or queue.
        counts.skipped++;
        continue;
      }
      if (job.archived_as !== null) {
        counts.queued++;
        continue;
      }
      // function-grants: service-role
      const { data: claim, error: claimError } = await supabase.rpc("claim_forgejo_repo_archive", {
        p_id: job.id,
        p_stale_minutes: STALE_CLAIM_MINUTES,
        p_require_no_destination: true
      });
      if (claimError) throw claimError;
      if (!claim) {
        counts.queued++;
        continue;
      }
      const deleted = await remove(config, name);
      // If this write fails, the stale claim is retried by the reconciler, which finds the repo gone.
      // Filter by the claim so a later pass that took it over cannot be overwritten.
      const { error: saveError } = await supabase
        .from("forgejo_repo_archives")
        .update({ archived_at: now().toISOString() })
        .eq("id", job.id)
        .eq("claimed_at", claim)
        .is("archived_at", null);
      if (saveError) console.warn(`Couldn't mark the archive of ${name} done:`, saveError);
      if (deleted) counts.deleted++;
      else counts.skipped++;
    } catch (error) {
      console.warn(
        `Failed to delete ${target.kind} repository ${name} from Forgejo; it stays queued for archiving:`,
        error
      );
      counts.queued++;
    }
  }
  return counts;
}
