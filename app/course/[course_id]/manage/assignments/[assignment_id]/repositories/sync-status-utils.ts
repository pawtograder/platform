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
  /** The handout revision that could not be delivered, when `status` is blocked. */
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
