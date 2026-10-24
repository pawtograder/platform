import { Database } from "@/utils/supabase/SupabaseTypes";
import { UnstableGetResult as GetResult } from "@supabase/postgrest-js";

export type RepositoryRow = GetResult<
  Database["public"],
  Database["public"]["Tables"]["repositories"]["Row"],
  "repositories",
  Database["public"]["Tables"]["repositories"]["Relationships"],
  "*, assignment_groups(*), profiles(*), user_roles(*)"
>;

export type SyncData = {
  pr_url?: string;
  pr_number?: number;
  pr_state?: string;
  last_sync_attempt?: string;
  last_sync_error?: string;
  merge_sha?: string;
  /** Worker-reported outcome of the last attempt. "blocked_by_student_changes" is terminal. */
  status?: string;
  /** Set when the failure was terminal: the error class that names what a person has to do. */
  terminal_reason?: string;
  /** The handout revision that could not be delivered, when the sync blocked or failed terminally. */
  blocked_handout_sha?: string;
  /** The student's files that blocked it. There is no PR in this case, so this is the only record. */
  unresolved_paths?: string[];
} | null;

export type SyncStatus =
  | "No Sync Requested"
  | "Synced"
  | "Not Up-to-date"
  | "PR Open"
  | "Sync Finalizing"
  | "Sync Error"
  | "Sync Blocked"
  | "Sync in Progress";

/**
 * Computes the sync status for a repository row based on its sync data and latest template SHA.
 * This function centralizes the sync status logic to prevent drift between different components.
 *
 * @param repositoryRow - The repository row containing sync information
 * @param latestSha - The latest template SHA (optional)
 * @returns The computed sync status string
 */
export function computeSyncStatus(repositoryRow: RepositoryRow, latestSha?: string | null): SyncStatus {
  const desiredSha = repositoryRow.desired_handout_sha;
  const syncedSha = repositoryRow.synced_handout_sha;
  const syncData = repositoryRow.sync_data as SyncData;

  if (!desiredSha) {
    return "No Sync Requested";
  }

  if (desiredSha === syncedSha) {
    // Check if synced SHA matches latest template SHA
    if (latestSha && syncedSha !== latestSha) {
      return "Not Up-to-date";
    } else {
      return "Synced";
    }
  }

  // The handout update could not be delivered: every file it changed is the student's own
  // work, so nothing was written and no PR was opened. Checked before `pr_state` because a
  // PR carried over from an EARLIER revision does not make this revision any less blocked,
  // and without this branch the row falls all the way through to "Sync in Progress" and
  // shows an in-flight spinner for a sync that already finished and will never move.
  if (syncData?.status === "blocked_by_student_changes") {
    return "Sync Blocked";
  }

  // A sync that ended needing a person, checked BEFORE pr_state for the same reason the
  // blocked branch above is: the worker carries an earlier revision's open pull request into
  // the terminal-error object so the instructor keeps the link to it, and reading pr_state
  // first turned that kindness into a hidden failure -- the row said "PR Open" while the
  // newer revision had stopped with an error nobody was shown. The badge for this status
  // renders the carried pull request alongside the error, so nothing is lost by ordering it
  // this way.
  if (syncData?.status === "error") {
    return "Sync Error";
  }

  if (syncData?.pr_state === "open") {
    return "PR Open";
  }

  if (syncData?.pr_state === "merged") {
    return "Sync Finalizing";
  }

  if (syncData?.last_sync_error) {
    return "Sync Error";
  }

  return "Sync in Progress";
}
